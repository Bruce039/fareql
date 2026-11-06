import type { GraphQLSchema } from 'graphql'
import {
  type DocumentLimits,
  type FareOptions,
  type GraphQLErrorBody,
  type OperationInput,
  chargeOperations,
  createDocumentCache,
  graphqlChallenge,
  jsonResponse,
  pricingErrorBody,
  sha256Hex,
} from './core.js'
import { type OperationPrice, PricingError, selectOperation } from './price.js'

export type GraphQLParams = {
  query?: string | null
  operationName?: string | null
  variables?: Record<string, unknown> | null
  extensions?: Record<string, unknown> | null
  /** GraphQL-over-HTTP persisted document identifier. */
  documentId?: string | null
}

/** Request bodies the gate reads besides `application/json`. Enable only what your handler accepts. */
export type Encoding = 'application/graphql+json' | 'application/graphql' | 'application/x-www-form-urlencoded' | 'multipart/form-data'

export type ReadOptions = {
  /** Extra body encodings to accept. Default: none (GET and `application/json` only). */
  encodings?: readonly Encoding[]
  /** Largest request body read, in bytes. Default: 1 MB. */
  maxBodyBytes?: number
}

export class RequestError extends Error {
  override name = 'RequestError'
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

const PARAM_KEYS = ['query', 'operationName', 'variables', 'extensions', 'documentId'] as const
const bad = (message: string, status = 400, code = 'BAD_REQUEST') => new RequestError(message, status, code)

/** Content-type match as GraphQL Yoga does it: first entry of a list, case-sensitive, parameters allowed. */
// Deliberately exact and case-sensitive, like GraphQL Yoga: a type the gate accepted but the
// handler refused would mean a client paid for nothing.
function contentTypeIs(request: Request, expected: string): boolean {
  const t = (request.headers.get('content-type') ?? '').split(',')[0]?.trim() ?? ''
  return t === expected || t.startsWith(`${expected};`)
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw bad(`${what} is not valid JSON`)
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(typeof Blob !== 'undefined' && v instanceof Blob)

function hasGraphQLParams(p: URLSearchParams): boolean {
  return PARAM_KEYS.some((k) => p.has(k))
}

function fromSearchParams(p: URLSearchParams): GraphQLParams | undefined {
  if (!hasGraphQLParams(p)) return undefined
  for (const k of PARAM_KEYS) if (p.getAll(k).length > 1) throw bad(`Parameter "${k}" is given more than once`)
  const variables = p.get('variables')
  const extensions = p.get('extensions')
  // Empty values count as absent, as in GraphQL Yoga.
  return checkParams({
    query: p.get('query') || null,
    operationName: p.get('operationName') || null,
    variables: variables ? parseJson(variables, 'variables') : null,
    extensions: extensions ? parseJson(extensions, 'extensions') : null,
    documentId: p.get('documentId') || null,
  })
}

function setPath(target: unknown, path: string, value: unknown) {
  const keys = path.split('.')
  let cur = target as Record<string, unknown>
  for (const [i, key] of keys.entries()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return
    if (i === keys.length - 1) cur[key] = value
    else {
      if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {}
      cur = cur[key] as Record<string, unknown>
    }
  }
}

/** Checks one set of params the way GraphQL Yoga does, so the gate never prices what the server would refuse. */
function checkParams(value: unknown): GraphQLParams {
  if (!isPlainObject(value)) throw bad('GraphQL params must be an object')
  for (const key of Object.keys(value)) {
    if (!(PARAM_KEYS as readonly string[]).includes(key)) throw bad(`Unexpected parameter "${key}"`)
  }
  const { query, operationName, variables, extensions, documentId } = value
  if (query != null && typeof query !== 'string') throw bad('"query" must be a string')
  if (operationName != null && (typeof operationName !== 'string' || operationName === '')) {
    throw bad('"operationName" must be a non-empty string')
  }
  if (variables != null && !isPlainObject(variables)) throw bad('"variables" must be an object')
  if (extensions != null && !isPlainObject(extensions)) throw bad('"extensions" must be an object')
  if (documentId != null && typeof documentId !== 'string') throw bad('"documentId" must be a string')
  if (documentId != null && query != null) throw bad('Send either "query" or "documentId", not both')
  if (documentId != null && (extensions as { persistedQuery?: unknown } | undefined)?.persistedQuery !== undefined) {
    throw bad('Send either "documentId" or extensions.persistedQuery, not both')
  }
  return value as GraphQLParams
}

function normalize(value: unknown): GraphQLParams | GraphQLParams[] {
  return Array.isArray(value) ? value.map(checkParams) : checkParams(value)
}

const tooLarge = (maxBytes: number) => bad(`Request body is larger than ${maxBytes} bytes`, 413, 'PAYLOAD_TOO_LARGE')

/** Reads a clone of the body as bytes, stopping as soon as it passes `maxBytes` (chunked bodies included). */
async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (declared > maxBytes) throw tooLarge(maxBytes)
  const body = request.clone().body
  if (!body) return new Uint8Array(new ArrayBuffer(0))
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      // Not awaited: cancelling one branch of a teed body can wait on the other branch.
      reader.cancel().catch(() => {})
      throw tooLarge(maxBytes)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(new ArrayBuffer(size))
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function readBody(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBytes(request, maxBytes))
}

/**
 * Reads GraphQL-over-HTTP params without consuming the request body. It refuses anything that
 * a handler could read differently (URL fragments, duplicate or unknown parameters, GraphQL
 * parameters in the URL of a POST, bodies on other methods), so what is priced is what runs.
 * Returns undefined when the request carries no GraphQL operation (e.g. a GraphiQL page).
 * Throws {@link RequestError} for anything it will not price.
 */
export async function readGraphQLParams(request: Request, options: ReadOptions = {}): Promise<GraphQLParams | GraphQLParams[] | undefined> {
  const encodings = options.encodings ?? []
  const maxBytes = options.maxBodyBytes ?? 1_000_000
  // URL parsers disagree about "#": URL drops it, GraphQL Yoga keeps what follows "?".
  if (request.url.includes('#')) throw bad('URL must not contain "#"')
  const search = new URL(request.url).searchParams

  if (request.method === 'GET') return fromSearchParams(search)
  if (request.method === 'HEAD') {
    if (hasGraphQLParams(search)) throw bad('Use GET or POST for GraphQL operations', 405, 'METHOD_NOT_ALLOWED')
    return undefined
  }
  if (request.method !== 'POST') {
    if (request.body !== null || hasGraphQLParams(search)) throw bad(`Method ${request.method} is not allowed`, 405, 'METHOD_NOT_ALLOWED')
    return undefined // e.g. CORS preflight
  }
  if (hasGraphQLParams(search)) throw bad('A POST request must carry its GraphQL parameters in the body')
  if (request.body === null) throw bad('Missing request body')
  const accepts = (type: Encoding) => encodings.includes(type) && contentTypeIs(request, type)

  if (contentTypeIs(request, 'application/json') || accepts('application/graphql+json')) {
    return normalize(parseJson(await readBody(request, maxBytes), 'Request body'))
  }
  if (accepts('application/graphql')) return { query: await readBody(request, maxBytes) }
  if (accepts('application/x-www-form-urlencoded')) {
    return fromSearchParams(new URLSearchParams(await readBody(request, maxBytes))) ?? checkParams({})
  }
  if (accepts('multipart/form-data')) {
    const bytes = await readBytes(request, maxBytes)
    let form: FormData
    try {
      form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData()
    } catch (e) {
      throw bad(`Invalid multipart body: ${(e as Error).message}`)
    }
    if (form.getAll('operations').length !== 1 || form.getAll('map').length > 1) {
      throw bad('Multipart body needs exactly one "operations" field and at most one "map" field')
    }
    const ops = form.get('operations')
    if (typeof ops !== 'string') throw bad('Multipart field "operations" must be a string')
    const operations = parseJson<unknown>(ops, 'Multipart field "operations"')
    const map = form.get('map')
    if (typeof map === 'string') {
      for (const [file, paths] of Object.entries(parseJson<Record<string, unknown>>(map, 'Multipart field "map"'))) {
        for (const path of Array.isArray(paths) ? paths : []) if (typeof path === 'string') setPath(operations, path, form.get(file))
      }
    }
    return normalize(operations)
  }
  throw bad('Unsupported content type for this endpoint', 415, 'UNSUPPORTED_MEDIA_TYPE')
}

export type GateOptions = FareOptions &
  ReadOptions &
  DocumentLimits & {
    schema: GraphQLSchema
    /** Accept JSON arrays of operations and charge their total in one payment. Default: false. */
    batching?: boolean
    /** Most operations in one batch. Default: 10. */
    maxBatchSize?: number
    /**
     * Looks up persisted documents (trusted documents, `documentId`, or APQ hashes your server
     * stores itself). Without it, hash-only APQ requests get PersistedQueryNotFound and the client
     * resends the full query, which is then priced.
     */
    resolveDocument?: (params: GraphQLParams) => string | undefined | Promise<string | undefined>
  }

export type GateResult =
  /** Nothing to charge (price 0, or not a GraphQL request). Run the handler. */
  | { status: 'free'; price?: OperationPrice }
  /** Return `response` (402 with the MPP Challenge). */
  | { status: 'payment-required'; response: Response; price: OperationPrice }
  /** Paid. Run the handler and pass its response through `withReceipt`. */
  | { status: 'paid'; price: OperationPrice; withReceipt: (response: Response) => Response }
  /** Must not run (unreadable, invalid, unpriceable or over the price limit). Return `response`. */
  | { status: 'rejected'; response: Response; error: Error }

const reject = (status: number, errors: GraphQLErrorBody[], error: Error, headers?: HeadersInit): GateResult => ({
  status: 'rejected',
  response: jsonResponse(status, errors, headers),
  error,
})

const rejectWith = (status: number, code: string, message: string, headers?: HeadersInit) =>
  reject(status, [{ message, extensions: { code } }], new RequestError(message, status, code), headers)

/** Hash of an Automatic Persisted Query, if the params carry one. */
function apqHash(params: GraphQLParams): string | undefined {
  const pq = (params.extensions as { persistedQuery?: { sha256Hash?: unknown } } | null | undefined)?.persistedQuery
  return typeof pq?.sha256Hash === 'string' ? pq.sha256Hash : undefined
}

/**
 * Creates a framework-agnostic payment gate. Call it with each request before executing
 * GraphQL. It fails closed: anything it cannot read or price is answered, never executed.
 */
export function createPaymentGate(options: GateOptions): (request: Request) => Promise<GateResult> {
  const documents = createDocumentCache(options)
  const exposePrice = options.exposePrice ?? true
  const maxBatchSize = options.maxBatchSize ?? 10

  const queryOf = async (params: GraphQLParams): Promise<string | GateResult> => {
    const hash = apqHash(params)
    if (typeof params.query === 'string' && params.query.length > 0) {
      if (hash !== undefined) {
        // Exact comparison, as Yoga and Apollo do: the hash names exactly this text.
        if ((await sha256Hex(params.query)) !== hash) {
          return rejectWith(400, 'PERSISTED_QUERY_HASH_MISMATCH', 'persistedQuery.sha256Hash does not match the query')
        }
      }
      return params.query
    }
    const resolved = await options.resolveDocument?.(params)
    if (resolved) return resolved
    if (hash !== undefined) {
      // Same reply as Apollo/Yoga: APQ clients resend the full query, which is then priced. The gate
      // keeps no hash store of its own: the wrapped handler might not know the hash, and the client
      // would pay for an operation that never runs.
      return reject(200, [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }], new RequestError('PersistedQueryNotFound', 200, 'PERSISTED_QUERY_NOT_FOUND'))
    }
    if (params.documentId) {
      return rejectWith(400, 'PERSISTED_DOCUMENT_NOT_FOUND', 'Unknown persisted document; pass resolveDocument to price persisted documents')
    }
    return rejectWith(400, 'BAD_REQUEST', 'Must provide a query string')
  }

  return async (request) => {
    let read: GraphQLParams | GraphQLParams[] | undefined
    try {
      read = await readGraphQLParams(request, options)
    } catch (error) {
      const e = error instanceof RequestError ? error : new RequestError('Unreadable request', 400, 'BAD_REQUEST')
      return reject(e.status, [{ message: e.message, extensions: { code: e.code } }], e, e.status === 405 ? { allow: 'GET, POST' } : undefined)
    }
    if (read === undefined) return { status: 'free' }
    if (Array.isArray(read) && !options.batching) {
      return rejectWith(400, 'BATCHING_NOT_SUPPORTED', 'Batched requests are not accepted; send one operation per request')
    }
    const list = Array.isArray(read) ? read : [read]
    if (list.length === 0) return rejectWith(400, 'BAD_REQUEST', 'Empty batch')
    if (list.length > maxBatchSize) return rejectWith(400, 'BATCH_TOO_LARGE', `A batch may hold at most ${maxBatchSize} operations`)

    const operations: OperationInput[] = []
    for (const params of list) {
      const query = await queryOf(params)
      if (typeof query !== 'string') return query
      const parsed = documents.get(options.schema, query)
      if (parsed.errors) {
        return reject(
          400,
          parsed.errors.map((e) => ({ message: e.message, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } })),
          new RequestError(parsed.errors[0]?.message ?? 'Invalid document', 400, 'GRAPHQL_VALIDATION_FAILED'),
        )
      }
      try {
        const op = selectOperation(parsed.document, params.operationName)
        if (request.method !== 'POST' && op.operation !== 'query') {
          return rejectWith(405, 'METHOD_NOT_ALLOWED', `Can only perform a ${op.operation} operation from a POST request`, { allow: 'POST' })
        }
      } catch (error) {
        if (error instanceof PricingError) return reject(400, [pricingErrorBody(error, exposePrice)], error)
        throw error
      }
      operations.push({ document: parsed.document, operationName: params.operationName, variables: params.variables })
    }

    const outcome = await chargeOperations(request, options.schema, operations, options)
    switch (outcome.status) {
      case 'free':
        return { status: 'free', price: outcome.price }
      case 'rejected':
        return reject(400, [pricingErrorBody(outcome.error, exposePrice)], outcome.error)
      case 'payment-required':
        return { status: 'payment-required', price: outcome.price, response: await graphqlChallenge(outcome.challenge, outcome.price, exposePrice) }
      case 'paid':
        return { status: 'paid', price: outcome.price, withReceipt: outcome.withReceipt }
    }
  }
}

/** Paid content belongs to the payer: never let a shared cache or CDN store it. */
function privateResponse(response: Response): Response {
  const cc = response.headers.get('cache-control') ?? ''
  if (/\b(private|no-store)\b/i.test(cc)) return response
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'private, no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Wraps any Fetch-API GraphQL handler (graphql-http, Apollo's fetch integrations, a Hono or
 * Next.js route). Free operations pass through; priced ones get a 402 Challenge, or run and
 * receive a Payment-Receipt. For GraphQL Yoga and Apollo Server, prefer their plugins: they
 * price after the server's own validation.
 */
export function withPayment(
  handler: (request: Request) => Response | Promise<Response>,
  options: GateOptions,
): (request: Request) => Promise<Response> {
  const gate = createPaymentGate(options)
  return async (request) => {
    const r = await gate(request)
    if (r.status === 'free') return handler(request)
    if (r.status === 'paid') return privateResponse(r.withReceipt(await handler(request)))
    return r.response
  }
}
