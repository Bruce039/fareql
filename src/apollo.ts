import { type ApolloServerPlugin, type BaseContext, type HTTPGraphQLRequest, HeaderMap } from '@apollo/server'
import { GraphQLError } from 'graphql'
import { type FareOptions, chargeOperations, paymentError, pricingErrorBody, receiptHeaders } from './core.js'
import { PricingError, priceOperation } from './price.js'

export type FareqlApolloOptions = FareOptions & {
  /**
   * URL of the GraphQL endpoint, used to build the Fetch `Request` mppx sees. Apollo does not
   * expose the path. Default: `http://<Host header>/graphql<search>`.
   */
  url?: string | ((http: HTTPGraphQLRequest) => string)
}

function toFetchRequest(http: HTTPGraphQLRequest, url: FareqlApolloOptions['url']): Request {
  const headers = new Headers()
  for (const [key, value] of http.headers) headers.set(key, value)
  let href: string
  if (typeof url === 'function') href = url(http)
  else if (url) {
    try {
      const u = new URL(url)
      for (const [k, v] of new URLSearchParams(http.search)) u.searchParams.append(k, v)
      href = u.toString()
    } catch {
      href = `http://localhost/graphql${http.search}`
    }
  } else href = `http://${http.headers.get('host') ?? 'localhost'}/graphql${http.search}`
  try {
    return new Request(href, { method: http.method, headers })
  } catch {
    // A Host header that is not a valid authority: the Challenge realm falls back to localhost
    // (configure `realm` in Mppx.create to make it independent of the Host header).
    return new Request(`http://localhost/graphql${http.search.startsWith('?') ? http.search : ''}`, { method: http.method, headers })
  }
}

const fail = (message: string, extensions: Record<string, unknown>, status: number, headers?: HeaderMap) => {
  // Typed loosely: GraphQL Yoga augments GraphQLErrorExtensions with its own `http` shape.
  const ext: Record<string, unknown> = { ...extensions, http: { status, headers: headers ?? new HeaderMap() } }
  return new GraphQLError(message, { extensions: ext })
}

/**
 * Apollo Server 4/5 plugin. Prices each operation after Apollo has parsed, validated and
 * resolved it (persisted queries included), before execution. Priced operations answer with the
 * MPP Challenge (402 + `WWW-Authenticate`); paid ones carry `Payment-Receipt`.
 *
 * In an HTTP batch only the first priced operation can be paid (one request carries one
 * Credential); further priced operations in the same batch are refused.
 * Operations run in-process with `server.executeOperation()` have no HTTP request and are not charged.
 */
export function fareqlApolloPlugin<TContext extends BaseContext = BaseContext>(options: FareqlApolloOptions): ApolloServerPlugin<TContext> {
  const exposePrice = options.exposePrice ?? true
  // Pieces of one HTTP batch share the same headers object; count the priced ones per request.
  const pricedPieces = new WeakMap<object, number>()
  return {
    async requestDidStart() {
      let receipt: Headers | undefined
      return {
        async didResolveOperation(rc) {
          const http = rc.request.http
          if (!http) return
          const input = { document: rc.document, operationName: rc.operationName ?? rc.request.operationName, variables: rc.request.variables }
          let price: ReturnType<typeof priceOperation>
          try {
            price = priceOperation({ schema: rc.schema, ...input }, options.pricing)
          } catch (e) {
            if (e instanceof PricingError) {
              const body = pricingErrorBody(e, exposePrice)
              throw fail(body.message, body.extensions, 400)
            }
            throw e
          }
          if (price.units === 0n) return
          // Counted synchronously, before any await, so parallel batch pieces cannot race past it.
          const n = (pricedPieces.get(http.headers) ?? 0) + 1
          pricedPieces.set(http.headers, n)
          if (n > 1) {
            throw fail('Priced operations cannot be batched; send them one per request', { code: 'BATCHING_NOT_SUPPORTED' }, 400)
          }
          const outcome = await chargeOperations(toFetchRequest(http, options.url), rc.schema, [input], options, [price])
          switch (outcome.status) {
            case 'free':
              return
            case 'rejected': {
              const body = pricingErrorBody(outcome.error, exposePrice)
              throw fail(body.message, body.extensions, 400)
            }
            case 'payment-required': {
              const headers = new HeaderMap()
              outcome.challenge.headers.forEach((value, key) => {
                if (key !== 'content-type' && key !== 'content-length') headers.set(key, value)
              })
              const body = paymentError(outcome.challenge.status, outcome.price, exposePrice)
              throw fail(body.message, body.extensions, outcome.challenge.status, headers)
            }
            case 'paid':
              receipt = receiptHeaders(outcome.withReceipt)
          }
        },
        async willSendResponse(rc) {
          if (!receipt) return
          receipt.forEach((value, key) => rc.response.http.headers.set(key, value))
          // Paid content belongs to the payer: never let a shared cache or CDN store it.
          const cc = rc.response.http.headers.get('cache-control') ?? ''
          if (!/\b(private|no-store)\b/i.test(cc)) rc.response.http.headers.set('cache-control', 'private, no-store')
        },
      }
    },
  }
}
