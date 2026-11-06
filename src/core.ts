import {
  type DocumentNode,
  type GraphQLError,
  GraphQLError as GraphQLErrorClass,
  type GraphQLSchema,
  type OperationTypeNode,
  type ValidationRule,
  parse,
  print,
  specifiedRules,
  validate,
} from 'graphql'
import {
  type OperationPrice,
  type PricingOptions,
  PriceLimitError,
  PricingError,
  formatUnits,
  parseUnits,
  priceOperation,
  selectOperation,
} from './price.js'

/** Options passed to the charge factory; maps 1:1 onto `mppx.charge({ ... })`. */
export type ChargeOptions = {
  /** Price in token units, e.g. "0.0014". */
  amount: string
  /** Binds the Challenge to this exact operation, so its Credential cannot pay for another one. */
  scope: string
  description?: string
}

/** What an mppx route handler returns (`await mppx.charge(options)(request)`). */
export type ChargeResult =
  | { status: 402; challenge: Response }
  | { status: 200; withReceipt: (response: Response) => Response }

/**
 * Creates a charge handler for one priced operation. With mppx this is
 * `(o) => mppx.charge(o)`, or `(o) => mppx.tempo.charge(o)` with several methods.
 */
export type ChargeFactory = (options: ChargeOptions) => (request: Request) => Promise<ChargeResult>

export type OperationInput = {
  document: DocumentNode
  operationName?: string | null
  variables?: Record<string, unknown> | null
}

export type OperationInfo = {
  operationName: string | undefined
  operationType: OperationTypeNode
}

export type FareOptions = {
  charge: ChargeFactory
  pricing?: PricingOptions
  /** Challenge description. Default: `GraphQL <operation name or type>`. */
  describe?: (operation: OperationInfo, price: OperationPrice) => string | undefined
  /** Include the price and its breakdown in 402 bodies. Default: true. */
  exposePrice?: boolean
}

export type ChargeOutcome =
  /** Nothing to charge. Execute normally. */
  | { status: 'free'; price: OperationPrice }
  /** Send `challenge` (an MPP 402) to the client. */
  | { status: 'payment-required'; price: OperationPrice; scope: string; challenge: Response }
  /** Paid. Execute, then pass the response through `withReceipt`. */
  | { status: 'paid'; price: OperationPrice; scope: string; withReceipt: (response: Response) => Response }
  /** The operation could not be priced; it must not run. */
  | { status: 'rejected'; error: PricingError }

const MAX_VARIABLE_DEPTH = 64

/**
 * Canonical, unambiguous encoding of variable values: sorted keys, tagged files, no
 * non-finite numbers, bounded depth. Equal inputs give equal strings and different
 * inputs can never collide.
 */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > MAX_VARIABLE_DEPTH) throw new PricingError('Variables are nested too deeply', 'TOO_COMPLEX')
  if (value === undefined) return { $undefined: true }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PricingError('Variables must not contain non-finite numbers', 'INVALID_VARIABLES')
    return value
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1))
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    // Uploaded files: bound by name, type and size (the content does not change the price).
    const f = value as Blob & { name?: string }
    return { $blob: [f.name ?? '', f.type, f.size] }
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    return { $object: Object.keys(o).sort().map((k) => [k, canonical(o[k], depth + 1)]) }
  }
  throw new PricingError(`Unsupported variable value of type ${typeof value}`, 'INVALID_VARIABLES')
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export { sha256Hex }

/** Only the variables the operation declares can change what runs. */
function declaredVariables(o: OperationInput): Record<string, unknown> {
  const vars = o.variables ?? {}
  const op = selectOperation(o.document, o.operationName)
  const out: Record<string, unknown> = {}
  for (const d of op.variableDefinitions ?? []) {
    const name = d.variable.name.value
    if (Object.hasOwn(vars, name)) out[name] = vars[name]
  }
  return out
}

/**
 * Scope binding a Challenge to a set of operations: `graphql:<sha256 of document, operation name and variables>`.
 * mppx stores it in the Challenge's HMAC-protected metadata and refuses Credentials whose scope differs.
 */
export async function operationScope(operations: readonly OperationInput[]): Promise<string> {
  const material = JSON.stringify(
    operations.map((o) => [print(o.document), o.operationName ?? null, canonical(declaredVariables(o))]),
  )
  return `graphql:${(await sha256Hex(material)).slice(0, 32)}`
}

function sumPrices(prices: readonly OperationPrice[], decimals: number): OperationPrice {
  if (prices.length === 1) return prices[0] as OperationPrice
  const units = prices.reduce((s, p) => s + p.units, 0n)
  return {
    amount: formatUnits(units, decimals),
    units,
    decimals,
    breakdown: prices.flatMap((p, i) => p.breakdown.map((b) => ({ ...b, path: `${i}:${b.path}` }))).slice(0, 100),
    ...(prices.some((p) => p.breakdownTruncated) || prices.reduce((n, p) => n + p.breakdown.length, 0) > 100
      ? { breakdownTruncated: true }
      : {}),
  }
}

/**
 * Prices one or more operations and charges for them through mppx. Every adapter (Fetch, Yoga,
 * Apollo) goes through here. The price is recomputed from the retried request, so a Credential
 * for a cheaper operation never pays for a more expensive one.
 */
export async function chargeOperations(
  request: Request,
  schema: GraphQLSchema,
  operations: readonly OperationInput[],
  options: FareOptions,
): Promise<ChargeOutcome> {
  const decimals = options.pricing?.decimals ?? 6
  let price: OperationPrice
  let info: OperationInfo
  try {
    const prices = operations.map((o) => priceOperation({ schema, ...o }, options.pricing))
    price = sumPrices(prices, decimals)
    const max = options.pricing?.maxPrice
    if (max !== undefined && price.units > parseUnits(max, decimals)) throw new PriceLimitError(price.amount, max)
    const first = operations[0]
    const op = first ? selectOperation(first.document, first.operationName) : undefined
    info = { operationName: operations.length === 1 ? op?.name?.value : undefined, operationType: op?.operation ?? ('query' as OperationTypeNode) }
  } catch (error) {
    if (error instanceof PricingError) return { status: 'rejected', error }
    throw error
  }
  if (price.units === 0n) return { status: 'free', price }

  let scope: string
  try {
    scope = await operationScope(operations)
  } catch (error) {
    if (error instanceof PricingError) return { status: 'rejected', error }
    throw error
  }
  const description =
    options.describe?.(info, price) ??
    (operations.length > 1 ? `GraphQL batch of ${operations.length} operations` : `GraphQL ${info.operationName ?? info.operationType}`)
  const result = await options.charge({ amount: price.amount, scope, description })(request)
  if (result.status === 402) return { status: 'payment-required', price, scope, challenge: result.challenge }
  return { status: 'paid', price, scope, withReceipt: result.withReceipt }
}

// ── GraphQL-shaped error bodies ───────────────────────────────────────────────

export type GraphQLErrorBody = { message: string; extensions: Record<string, unknown> }

export function priceExtension(price: OperationPrice) {
  return {
    amount: price.amount,
    decimals: price.decimals,
    breakdown: price.breakdown,
    ...(price.breakdownTruncated ? { breakdownTruncated: true } : {}),
  }
}

export function paymentError(status: number, price: OperationPrice, exposePrice: boolean): GraphQLErrorBody {
  const code = status === 402 ? 'PAYMENT_REQUIRED' : status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN'
  return {
    message: status === 402 ? `Payment required: this operation costs ${price.amount}` : 'Payment was not accepted for this operation',
    extensions: exposePrice ? { code, price: priceExtension(price) } : { code },
  }
}

export function pricingErrorBody(error: PricingError, exposePrice = true): GraphQLErrorBody {
  if (!exposePrice && error.code === 'PRICE_LIMIT_EXCEEDED') {
    return { message: 'Operation exceeds the maximum price', extensions: { code: error.code } }
  }
  return { message: error.message, extensions: { code: error.code } }
}

/**
 * Turns mppx's 402 into a response GraphQL clients understand: same status and headers
 * (WWW-Authenticate carries the Challenge), and a body with both the problem details mppx
 * wrote and a GraphQL `errors` array. HTML paywalls are passed through untouched.
 */
export async function graphqlChallenge(challenge: Response, price: OperationPrice, exposePrice: boolean): Promise<Response> {
  const type = challenge.headers.get('content-type') ?? ''
  if (type.includes('text/html') || challenge.status === 200) return challenge
  let problem: Record<string, unknown> = {}
  if (type.includes('json')) {
    try {
      const parsed = (await challenge.clone().json()) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) problem = parsed as Record<string, unknown>
    } catch {
      // keep an empty problem object
    }
  }
  const headers = new Headers(challenge.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.delete('content-length')
  const body = { ...problem, errors: [paymentError(challenge.status, price, exposePrice)] }
  return new Response(JSON.stringify(body), { status: challenge.status, statusText: challenge.statusText, headers })
}

export function jsonResponse(status: number, errors: readonly GraphQLErrorBody[], headers?: HeadersInit): Response {
  const h = new Headers(headers)
  h.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify({ errors }), { status, headers: h })
}

/** Copies the headers mppx adds for a receipt onto an existing response. */
export function receiptHeaders(withReceipt: (response: Response) => Response): Headers {
  return withReceipt(new Response(null)).headers
}

// ── Parsed-document cache ─────────────────────────────────────────────────────

export type ParsedDocument = { document: DocumentNode; errors?: undefined } | { document?: undefined; errors: readonly GraphQLError[] }

export type DocumentLimits = {
  /** Longest query text accepted, in characters. Default: 100000. */
  maxQueryLength?: number
  /** Most lexical tokens a document may have (graphql-js `maxTokens`). Default: 15000. */
  maxTokens?: number
  /** Extra validation rules your server applies, so their failures are refused before payment. */
  validationRules?: readonly ValidationRule[]
}

const CACHEABLE_QUERY_LENGTH = 32_768

/** Small LRU of parse + validate results. Only short queries are cached, so memory stays bounded. */
export function createDocumentCache(limits: DocumentLimits = {}, max = 1000) {
  const entries = new Map<string, ParsedDocument>()
  const maxQueryLength = limits.maxQueryLength ?? 100_000
  const maxTokens = limits.maxTokens ?? 15_000
  const rules = limits.validationRules ? [...specifiedRules, ...limits.validationRules] : undefined
  return {
    get(schema: GraphQLSchema, query: string): ParsedDocument {
      if (query.length > maxQueryLength) {
        return { errors: [new GraphQLErrorClass(`Query is longer than ${maxQueryLength} characters`)] }
      }
      const hit = entries.get(query)
      if (hit) {
        entries.delete(query)
        entries.set(query, hit)
        return hit
      }
      let result: ParsedDocument
      try {
        const document = parse(query, { maxTokens })
        const errors = validate(schema, document, rules)
        result = errors.length > 0 ? { errors } : { document }
      } catch (error) {
        result = { errors: [error instanceof GraphQLErrorClass ? error : new GraphQLErrorClass(String((error as Error).message))] }
      }
      if (query.length <= CACHEABLE_QUERY_LENGTH) {
        entries.set(query, result)
        if (entries.size > max) entries.delete(entries.keys().next().value as string)
      }
      return result
    },
    clear() {
      entries.clear()
    },
  }
}
