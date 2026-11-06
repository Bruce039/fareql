import { type DocumentNode, type ExecutionResult, GraphQLError, type GraphQLSchema } from 'graphql'
import type { Plugin } from 'graphql-yoga'
import {
  type ChargeOutcome,
  type DocumentLimits,
  type FareOptions,
  type OperationInput,
  chargeOperations,
  createDocumentCache,
  paymentError,
  pricingErrorBody,
  receiptHeaders,
} from './core.js'
import { PricingError, priceOperation } from './price.js'

export type UseFareqlOptions = FareOptions &
  Pick<DocumentLimits, 'maxQueryLength' | 'maxTokens'> & {
    /** Schema to price against. Default: the schema the operation executes on. */
    schema?: GraphQLSchema
    /**
     * The HTTP request a payment belongs to. Default: `context.request`, which Yoga sets for HTTP.
     * Operations that reach execution without one (graphql-ws, `yoga.getEnveloped()`) are refused
     * when priced, unless this returns a Request (e.g. built from `connectionParams`).
     */
    getRequest?: (context: Record<string, unknown>) => Request | undefined
    /** Events one payment buys on a priced subscription; the stream then ends. Default: 100. */
    maxSubscriptionEvents?: number
  }

type ExecArgs = {
  schema: GraphQLSchema
  document: DocumentNode
  operationName?: string | null
  variableValues?: Record<string, unknown> | null
  contextValue: Record<string, unknown> & { request?: Request }
}

type Params = { query?: string; operationName?: string; variables?: Record<string, unknown> }

const failure = (message: string, extensions: Record<string, unknown>, status: number, headers?: Record<string, string>): ExecutionResult => ({
  errors: [new GraphQLError(message, { extensions: { ...extensions, http: headers ? { status, headers } : { status } } })],
})

const isAsyncIterable = (v: unknown): v is AsyncIterable<ExecutionResult> =>
  typeof v === 'object' && v !== null && Symbol.asyncIterator in v

const hasData = (r: unknown) => isAsyncIterable(r) || (typeof r === 'object' && r !== null && (r as ExecutionResult).data != null)

async function* limitEvents(source: AsyncIterable<ExecutionResult>, max: number): AsyncGenerator<ExecutionResult> {
  if (max <= 0) return
  let n = 0
  for await (const event of source) {
    yield event
    if (++n >= max) {
      yield {
        errors: [new GraphQLError('The events paid for are used up; subscribe again to continue', { extensions: { code: 'PAYMENT_EXHAUSTED' } })],
      }
      return // leaving the loop closes the source iterator
    }
  }
}

/**
 * GraphQL Yoga plugin. It charges right before execution, after Yoga and every other plugin have
 * parsed, validated and restored the document (APQ, persisted operations, depth limits…), so
 * what is priced is exactly what runs, and nobody pays for an operation a later check rejects.
 * A backstop before the response is sent charges results that skipped execution (response
 * caches, other plugins' shortcuts), so a cached priced result is never served unpaid.
 *
 * Priced operations answer with the MPP Challenge status (402) and `WWW-Authenticate` header
 * until the client retries with a valid Credential; the paid response carries `Payment-Receipt`.
 */
export function useFareql(options: UseFareqlOptions): Plugin {
  const receipts = new WeakMap<Request, Headers>()
  const batches = new WeakSet<Request>()
  const allowed = new WeakMap<Request, number>() // operations of a request that passed the gate
  const paramsOf = new WeakMap<Request, Params[]>()
  const documents = createDocumentCache(options)
  const exposePrice = options.exposePrice ?? true
  const maxEvents = options.maxSubscriptionEvents ?? 100
  let servedSchema: GraphQLSchema | undefined

  const reject = (e: PricingError) => failure(pricingErrorBody(e, exposePrice).message, pricingErrorBody(e, exposePrice).extensions, 400)

  /** Turns a charge outcome into a result to stop with (or undefined to go on). */
  const settle = (request: Request, outcome: ChargeOutcome): ExecutionResult | undefined => {
    switch (outcome.status) {
      case 'free':
        return undefined
      case 'rejected':
        return reject(outcome.error)
      case 'payment-required': {
        const headers: Record<string, string> = {}
        outcome.challenge.headers.forEach((value, key) => {
          if (key !== 'content-type' && key !== 'content-length') headers[key] = value
        })
        const body = paymentError(outcome.challenge.status, outcome.price, exposePrice)
        return failure(body.message, body.extensions, outcome.challenge.status, headers)
      }
      case 'paid':
        receipts.set(request, receiptHeaders(outcome.withReceipt))
        return undefined
    }
  }

  // Yoga has consumed the body by the time we charge; give mppx a body-less copy it can clone.
  const forPayment = (request: Request) => new Request(request.url, { method: request.method, headers: request.headers })

  /** Charges one operation. Returns a result to stop with, or undefined to let it run. */
  const gate = async (args: ExecArgs): Promise<{ stop?: ExecutionResult; paid: boolean }> => {
    const schema = options.schema ?? args.schema
    const input: OperationInput = { document: args.document, operationName: args.operationName, variables: args.variableValues }
    const request = options.getRequest?.(args.contextValue) ?? args.contextValue.request
    let units: bigint
    try {
      units = priceOperation({ schema, ...input }, options.pricing).units
    } catch (e) {
      if (e instanceof PricingError) return { stop: reject(e), paid: false }
      throw e
    }
    if (!request) {
      // No HTTP request to carry a Credential (e.g. graphql-ws): fail closed for priced operations.
      if (units === 0n) return { paid: false }
      return {
        stop: failure('Priced operations need an HTTP request; pass getRequest to charge over this transport', { code: 'PAYMENT_TRANSPORT_UNSUPPORTED' }, 402),
        paid: false,
      }
    }
    if (units === 0n) {
      allowed.set(request, (allowed.get(request) ?? 0) + 1)
      return { paid: false }
    }
    if (batches.has(request)) {
      // One request carries one Credential, so priced operations cannot share a batch.
      return { stop: failure('Priced operations cannot be batched; send them one per request', { code: 'BATCHING_NOT_SUPPORTED' }, 400), paid: false }
    }
    const outcome = await chargeOperations(forPayment(request), schema, [input], options)
    const stop = settle(request, outcome)
    if (!stop) allowed.set(request, (allowed.get(request) ?? 0) + 1)
    return { stop, paid: outcome.status === 'paid' }
  }

  /** Price of params that never reached execution, from their query text. */
  const priceParams = (schema: GraphQLSchema, p: Params): { input?: OperationInput; units: bigint } | PricingError => {
    if (typeof p.query !== 'string' || p.query.length === 0) {
      return new PricingError('Result produced without a query FareQL could price; register useFareql after APQ/persisted-operation plugins', 'UNKNOWN_OPERATION')
    }
    const parsed = documents.get(schema, p.query)
    if (parsed.errors) return new PricingError(parsed.errors[0]?.message ?? 'Invalid document', 'UNKNOWN_OPERATION')
    const input = { document: parsed.document, operationName: p.operationName, variables: p.variables }
    try {
      return { input, units: priceOperation({ schema, ...input }, options.pricing).units }
    } catch (e) {
      if (e instanceof PricingError) return e
      throw e
    }
  }

  return {
    onSchemaChange({ schema }) {
      servedSchema = schema
    },
    onRequestParse({ request }) {
      return {
        onRequestParseDone({ requestParserResult }) {
          if (Array.isArray(requestParserResult) && requestParserResult.length > 1) batches.add(request)
        },
      }
    },
    onParams({ request, params }) {
      const list = paramsOf.get(request) ?? []
      list.push(params as Params)
      paramsOf.set(request, list)
    },
    async onExecute({ args, setResultAndStopExecution }) {
      const { stop } = await gate(args as unknown as ExecArgs)
      if (stop) setResultAndStopExecution(stop)
    },
    async onSubscribe({ args, setResultAndStopExecution }) {
      const { stop, paid } = await gate(args as unknown as ExecArgs)
      if (stop) {
        setResultAndStopExecution(stop)
        return
      }
      if (!paid) return
      return {
        onSubscribeResult({ result, setResult }) {
          if (isAsyncIterable(result)) setResult(limitEvents(result, maxEvents))
        },
      }
    },
    // Backstop: results that did not go through execution (response caches, plugins that
    // short-circuit earlier) are priced here, before anything is sent.
    async onResultProcess({ request, result, setResult }) {
      const schema = options.schema ?? servedSchema
      const params = paramsOf.get(request) ?? []
      if (!schema) return
      if (Array.isArray(result)) {
        // Batches: priced operations are never allowed, whichever path produced them.
        const next = result.map((r, i) => {
          if (!hasData(r)) return r
          const p = params[i]
          const priced = p ? priceParams(schema, p) : new PricingError('Unmatched batch result', 'UNKNOWN_OPERATION')
          if (priced instanceof PricingError) return reject(priced)
          return priced.units === 0n ? r : failure('Priced operations cannot be batched; send them one per request', { code: 'BATCHING_NOT_SUPPORTED' }, 400)
        })
        if (next.some((r, i) => r !== result[i])) setResult(next)
        return
      }
      if ((allowed.get(request) ?? 0) > 0 || !hasData(result)) return
      const p = params[0]
      const priced = p ? priceParams(schema, p) : new PricingError('Result without GraphQL params', 'UNKNOWN_OPERATION')
      if (priced instanceof PricingError) return setResult(reject(priced))
      if (priced.units === 0n || !priced.input) return
      const outcome = await chargeOperations(forPayment(request), schema, [priced.input], options)
      const stop = settle(request, outcome)
      if (stop) setResult(stop)
    },
    onResponse({ request, response }) {
      const headers = receipts.get(request)
      if (!headers) return
      receipts.delete(request)
      headers.forEach((value, key) => response.headers.set(key, value))
      // Paid content belongs to the payer: never let a shared cache or CDN store it.
      const cc = response.headers.get('cache-control') ?? ''
      if (!/\b(private|no-store)\b/i.test(cc)) response.headers.set('cache-control', 'private, no-store')
    },
  }
}
