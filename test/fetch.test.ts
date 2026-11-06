import { createHash } from 'node:crypto'
import { createSchema, createYoga } from 'graphql-yoga'
import { describe, expect, it } from 'vitest'
import { createPaymentGate, readGraphQLParams, withPayment } from '../src/index.js'
import { type ChargeLog, challengeOf, fakeCharge, gql, payFor, resolvers, schema, typeDefs } from './fixtures.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const body = async (r: { response: Response } | Response) => ((r instanceof Response ? r : r.response).clone().json()) as Promise<any>

describe('createPaymentGate', () => {
  it('lets free operations and non-GraphQL requests through without charging', async () => {
    const log: ChargeLog = []
    const gate = createPaymentGate({ schema, charge: fakeCharge(log) })
    expect((await gate(gql('{ hello }'))).status).toBe('free')
    expect((await gate(new Request('http://localhost/graphql'))).status).toBe('free') // GraphiQL page
    expect(log).toHaveLength(0)
  })

  it('returns a 402 with the Challenge headers and a GraphQL error carrying the price', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const r = await gate(gql('{ search(query: "x", first: 2) { snippet } }'))
    expect(r.status).toBe('payment-required')
    if (r.status !== 'payment-required') return
    expect(r.response.status).toBe(402)
    expect(r.response.headers.get('cache-control')).toBe('no-store')
    const c = challengeOf(r.response)
    expect(c.amount).toBe('0.0014')
    expect(c.scope).toMatch(/^graphql:[0-9a-f]{32}$/)
    const b = await body(r)
    expect(b.type).toContain('payment-required') // mppx problem details are kept
    expect(b.errors[0].extensions.code).toBe('PAYMENT_REQUIRED')
    expect(b.errors[0].extensions.price.amount).toBe('0.0014')
    expect(b.errors[0].extensions.price.breakdown).toHaveLength(2)
  })

  it('can hide the price breakdown', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge(), exposePrice: false })
    const b = await body((await gate(gql('{ weather(city: "x") { temperature } }'))) as { response: Response })
    expect(b.errors[0].extensions).toEqual({ code: 'PAYMENT_REQUIRED' })
  })

  it('binds the scope to the operation and its variables', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const q = 'query($c: String!) { weather(city: $c) { temperature } }'
    const scopeFor = async (v: Record<string, unknown>) => challengeOf(((await gate(gql(q, v))) as { response: Response }).response)
    const a = await scopeFor({ c: 'Denver' })
    const b = await scopeFor({ c: 'Paris' })
    expect(a.amount).toBe(b.amount)
    expect(a.scope).not.toBe(b.scope)
    expect((await scopeFor({ c: 'Denver' })).scope).toBe(a.scope)
  })

  it('never lets a Credential for a cheaper operation pay for an expensive one', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const cheap = challengeOf(((await gate(gql('{ weather(city: "x") { temperature } }'))) as { response: Response }).response)
    expect((await gate(gql('{ expensive { pages } }', undefined, payFor(cheap)))).status).toBe('payment-required')
    expect((await gate(gql('{ weather(city: "x") { temperature } }', undefined, payFor(cheap)))).status).toBe('paid')
  })

  it('rejects documents it cannot price, without charging', async () => {
    const log: ChargeLog = []
    const gate = createPaymentGate({ schema, charge: fakeCharge(log), pricing: { maxPrice: '0.01' } })
    const invalid = await gate(gql('{ nope }'))
    expect(invalid.status).toBe('rejected')
    expect((await body(invalid as { response: Response })).errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED')
    expect((await gate(gql('{ weather( }'))).status).toBe('rejected')
    const limit = await gate(gql('{ expensive { pages } }'))
    expect((await body(limit as { response: Response })).errors[0].extensions.code).toBe('PRICE_LIMIT_EXCEEDED')
    expect(log).toHaveLength(0)
  })

  it('refuses mutations over GET before anyone pays', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const q = encodeURIComponent('mutation { generateImage(prompt: "x") }')
    const r = await gate(new Request(`http://localhost/graphql?query=${q}`))
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') {
      expect(r.response.status).toBe(405)
      expect(r.response.headers.get('allow')).toBe('POST')
    }
  })

  it('fails closed on bodies it cannot read', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const text = new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"query":"{ expensive { pages } }"}' })
    const r = await gate(text)
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.response.status).toBe(415)
    const broken = new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect((await gate(broken)).status).toBe('rejected')
  })

  it('prices form-urlencoded, application/graphql and GET requests when enabled', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge(), encodings: ['application/x-www-form-urlencoded', 'application/graphql'] })
    const form = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: '{ expensive { pages } }' }).toString(),
    })
    expect(challengeOf(((await gate(form)) as { response: Response }).response).amount).toBe('0.02')
    const raw = new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/graphql' }, body: '{ expensive { pages } }' })
    expect((await gate(raw)).status).toBe('payment-required')
    const get = new Request(`http://localhost/graphql?query=${encodeURIComponent('{ expensive { pages } }')}`)
    expect((await gate(get)).status).toBe('payment-required')
  })

  it('prices multipart uploads with the files in place', async () => {
    const log: ChargeLog = []
    const gate = createPaymentGate({ schema, charge: fakeCharge(log), encodings: ['multipart/form-data'] })
    const form = new FormData()
    form.set('operations', JSON.stringify({ query: 'mutation($f: Upload!) { upload(file: $f) }', variables: { f: null } }))
    form.set('map', JSON.stringify({ 0: ['variables.f'] }))
    form.set('0', new File(['hello'], 'a.txt', { type: 'text/plain' }))
    const r = await gate(new Request('http://localhost/graphql', { method: 'POST', body: form }))
    expect(r.status).toBe('payment-required')
    expect(log[0]?.amount).toBe('0.01')
    const params = (await readGraphQLParams(new Request('http://localhost/graphql', { method: 'POST', body: form }), { encodings: ['multipart/form-data'] })) as {
      variables: { f: File }
    }
    expect(params.variables.f).toBeInstanceOf(Blob)
  })

  it('speaks APQ without a hash store of its own, so it never charges for a hash the handler may not know', async () => {
    const query = '{ expensive { pages } }'
    const ext = { extensions: { persistedQuery: { version: 1, sha256Hash: sha256(query) } } }
    const hashOnly = () => new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ext) })
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    expect((await gate(gql(query, undefined, {}, ext))).status).toBe('payment-required') // full query: priced
    const miss = await gate(hashOnly())
    expect(miss.status).toBe('rejected')
    expect((await body(miss as { response: Response })).errors[0].extensions.code).toBe('PERSISTED_QUERY_NOT_FOUND')
    // With resolveDocument, hash-only requests are priced from your own store.
    const known = createPaymentGate({ schema, charge: fakeCharge(), resolveDocument: (p) => (p.extensions ? query : undefined) })
    expect(challengeOf(((await known(hashOnly())) as { response: Response }).response).amount).toBe('0.02')
  })

  it('stops reading a chunked body without content-length as soon as it passes maxBodyBytes', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge(), maxBodyBytes: 1000 })
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 10_000) return controller.close()
        controller.enqueue(new TextEncoder().encode(' '.repeat(512)))
      },
    })
    const req = new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit)
    const r = await gate(req)
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.response.status).toBe(413)
    expect(pulled).toBeLessThan(20)
  })

  it('re-validates when the schema changes', async () => {
    const { buildSchema } = await import('graphql')
    const { createDocumentCache } = await import('../src/core.js')
    const cache = createDocumentCache()
    const a = buildSchema(`${typeDefs.split('type Query')[0]} type Query { hello: String old: String @price(amount: "0.1") }`)
    const b = buildSchema(`${typeDefs.split('type Query')[0]} type Query { hello: String }`)
    expect(cache.get(a, '{ old }').errors).toBeUndefined()
    expect(cache.get(b, '{ old }').errors?.length).toBeGreaterThan(0)
  })

  it('refuses a cheap query sent under an expensive persisted hash', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const ext = { extensions: { persistedQuery: { version: 1, sha256Hash: sha256('{ expensive { pages } }') } } }
    const r = await gate(gql('{ hello }', undefined, {}, ext))
    expect(r.status).toBe('rejected')
    expect((await body(r as { response: Response })).errors[0].extensions.code).toBe('PERSISTED_QUERY_HASH_MISMATCH')
  })

  it('prices trusted documents through resolveDocument', async () => {
    const docs: Record<string, string> = { abc: '{ expensive { pages } }' }
    const gate = createPaymentGate({ schema, charge: fakeCharge(), resolveDocument: (p) => (p.documentId ? docs[p.documentId] : undefined) })
    const req = (id: string) => new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: id }) })
    expect((await gate(req('abc'))).status).toBe('payment-required')
    expect((await gate(req('zzz'))).status).toBe('rejected')
  })

  it('rejects batches by default and charges their total in one payment when enabled', async () => {
    const batch = (headers: Record<string, string> = {}) =>
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify([{ query: '{ weather(city: "x") { temperature } }' }, { query: '{ expensive { pages } }' }, { query: '{ hello }' }]),
      })
    expect((await createPaymentGate({ schema, charge: fakeCharge() })(batch())).status).toBe('rejected')

    const log: ChargeLog = []
    const gate = createPaymentGate({ schema, charge: fakeCharge(log), batching: true })
    const r = await gate(batch())
    expect(r.status).toBe('payment-required')
    expect(log[0]).toMatchObject({ amount: '0.021', description: 'GraphQL batch of 3 operations' })
    expect((await gate(batch(payFor(challengeOf((r as { response: Response }).response))))).status).toBe('paid')
  })

  it('uses describe() for the Challenge description', async () => {
    const log: ChargeLog = []
    const gate = createPaymentGate({ schema, charge: fakeCharge(log), describe: (op, p) => `${op.operationName}: ${p.amount} USD` })
    await gate(gql('query Forecast { weather(city: "x") { temperature } }'))
    expect(log[0]?.description).toBe('Forecast: 0.001 USD')
  })
})

describe('withPayment (any Fetch handler)', () => {
  const yoga = createYoga({ schema: createSchema({ typeDefs, resolvers }) })
  const handler = withPayment((req) => yoga.fetch(req), { schema, charge: fakeCharge() })

  it('runs the operation and attaches the receipt after payment', async () => {
    const q = '{ weather(city: "Denver") { temperature } }'
    const first = await handler(gql(q))
    expect(first.status).toBe(402)
    const paid = await handler(gql(q, undefined, payFor(challengeOf(first))))
    expect(paid.status).toBe(200)
    expect(paid.headers.get('payment-receipt')).toBe('ok;amount=0.001')
    expect((await paid.json()).data.weather.temperature).toBe(21.5)
  })

  it('passes free operations straight through', async () => {
    const r = await handler(gql('{ hello }'))
    expect((await r.json()).data.hello).toBe('hi')
  })
})
