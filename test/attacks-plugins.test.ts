/**
 * Offensive tests against the Yoga and Apollo plugins. Every test asserts the SECURE behaviour:
 * a failing test means the attack works.
 */
import { ApolloServer, HeaderMap } from '@apollo/server'
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl'
import responseCachePlugin from '@apollo/server-plugin-response-cache'
import { usePersistedOperations } from '@graphql-yoga/plugin-persisted-operations'
import { useResponseCache } from '@graphql-yoga/plugin-response-cache'
import { parse } from 'graphql'
import { createSchema, createYoga } from 'graphql-yoga'
import { Credential, Method, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { fareDirectiveTypeDefs } from '../src/index.js'
import { fareqlApolloPlugin } from '../src/apollo.js'
import { useFareql } from '../src/yoga.js'
import { type ChargeLog, challengeOf, fakeCharge, gql, payFor, resolvers, typeDefs } from './fixtures.js'

const EXPENSIVE = '{ expensive { pages } }'

function yogaWith(plugins: any[], log: ChargeLog = [], extra: Record<string, unknown> = {}, yogaExtra: Record<string, unknown> = {}) {
  return createYoga({ logging: false, schema: createSchema({ typeDefs, resolvers }), batching: true, plugins, ...yogaExtra, ...extra } as any)
}

async function payAndRun(yoga: { fetch: (r: Request) => Promise<Response> | Response }, q: string) {
  const first = await yoga.fetch(gql(q))
  const c = challengeOf(first)
  return yoga.fetch(gql(q, undefined, payFor(c)))
}

// ── settlement-free real mppx method (same pattern as test/mppx.test.ts) ─────
const testCharge = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string() }),
  },
})

function realMppx() {
  const settled: string[] = []
  const server = Mppx.create({
    methods: [
      Method.toServer(testCharge, {
        defaults: { currency: 'USD' },
        async verify({ credential }) {
          settled.push(String(credential.challenge.request.amount))
          return { method: 'test', status: 'success', reference: `ref-${settled.length}`, timestamp: new Date().toISOString() }
        },
      }),
    ],
    secretKey: 'attack-test-secret-key-00000000000000000',
    realm: 'graphql.test',
  })
  return { settled, charge: (o: any) => server.charge(o as never) }
}

function realClient(handler: (r: Request) => Promise<Response>) {
  const credentials: string[] = []
  const client = ClientMppx.create({
    polyfill: false,
    fetch: async (input, init) => {
      const req = new Request(input, init)
      const auth = req.headers.get('authorization')
      if (auth) credentials.push(auth)
      return handler(req)
    },
    methods: [
      Method.toClient(testCharge, {
        async createCredential({ challenge }) {
          return Credential.serialize(Credential.from({ challenge, payload: { token: 'ok' } }))
        },
      }),
    ],
  })
  return { client, credentials }
}

const post = (query: string, headers: Record<string, string> = {}, variables?: Record<string, unknown>) =>
  ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify({ query, variables }) }) as RequestInit

// Bridge Fetch → Apollo executeHTTPGraphQLRequest
function apolloFetch(server: ApolloServer<any>) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const headers = new HeaderMap()
    req.headers.forEach((v, k) => headers.set(k, v))
    if (!headers.has('host')) headers.set('host', url.host)
    const text = req.method === 'POST' ? await req.text() : ''
    const r = await server.executeHTTPGraphQLRequest({
      httpGraphQLRequest: { method: req.method, headers, search: url.search, body: text ? JSON.parse(text) : undefined },
      context: async () => ({}),
    })
    const out = new Headers()
    for (const [k, v] of r.headers) out.set(k, v)
    const body = r.body.kind === 'complete' ? r.body.string : ''
    return new Response(body, { status: r.status ?? 200, headers: out })
  }
}

async function apolloRun(server: ApolloServer<any>, body: unknown, headers: Record<string, string> = {}, method = 'POST', search = '') {
  const h = new HeaderMap([['content-type', 'application/json'], ['host', 'api.example.com'], ...Object.entries(headers)])
  const r = await server.executeHTTPGraphQLRequest({
    httpGraphQLRequest: { method, headers: h, search, body },
    context: async () => ({}),
  })
  const text = r.body.kind === 'complete' ? r.body.string : ''
  const out = new Headers()
  for (const [k, v] of r.headers) out.set(k, v)
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: r.status ?? 200, headers: out, json }
}

// ═════════════════════════════════════════════════════════════════════════════
describe('Yoga plugin attacks', () => {
  it('ATTACK 1a: response cache (registered before FareQL) serves a paid result to an unpaid client', async () => {
    const log: ChargeLog = []
    const yoga = yogaWith([useResponseCache({ session: () => null }), useFareql({ charge: fakeCharge(log) })])
    const paid = await payAndRun(yoga, EXPENSIVE)
    expect(paid.status).toBe(200)
    const freeloader = await yoga.fetch(gql(EXPENSIVE))
    const body = await freeloader.json()
    expect(body.data?.expensive).toBeUndefined()
    expect(freeloader.status).toBe(402)
  })

  it('ATTACK 1b: response cache (registered after FareQL) serves a paid result to an unpaid client', async () => {
    const log: ChargeLog = []
    const yoga = yogaWith([useFareql({ charge: fakeCharge(log) }), useResponseCache({ session: () => null })])
    const paid = await payAndRun(yoga, EXPENSIVE)
    expect(paid.status).toBe(200)
    const freeloader = await yoga.fetch(gql(EXPENSIVE))
    const body = await freeloader.json()
    expect(body.data?.expensive).toBeUndefined()
    expect(freeloader.status).toBe(402)
  })

  it('ATTACK 1c: response cache does not cache 402 results (no poisoning with the challenge)', async () => {
    const yoga = yogaWith([useResponseCache({ session: () => null }), useFareql({ charge: fakeCharge() })])
    expect((await yoga.fetch(gql(EXPENSIVE))).status).toBe(402)
    const paid = await payAndRun(yoga, EXPENSIVE)
    expect(paid.status).toBe(200)
    expect((await paid.json()).data.expensive.pages).toBe(3)
  })

  it('ATTACK 2: an earlier plugin that stops execution in onExecute skips the FareQL gate', async () => {
    const store = new Map<string, unknown>()
    // A naive memoising plugin (custom caches, mocks, dataloader-style shortcuts) registered first.
    const memo = {
      onExecute({ args, setResultAndStopExecution }: any) {
        const key = args.contextValue.params.query
        if (store.has(key)) setResultAndStopExecution(store.get(key))
        return {
          onExecuteDone({ result }: any) {
            if (!result.errors) store.set(key, result)
          },
        }
      },
    }
    const yoga = yogaWith([memo, useFareql({ charge: fakeCharge() })])
    expect((await payAndRun(yoga, EXPENSIVE)).status).toBe(200)
    const freeloader = await yoga.fetch(gql(EXPENSIVE))
    expect((await freeloader.json()).data?.expensive).toBeUndefined()
  })

  for (const order of ['persisted-first', 'fareql-first'] as const) {
    it(`ATTACK 3 (${order}): cheap query text + expensive persisted id is priced as what runs`, async () => {
      const log: ChargeLog = []
      const store: Record<string, string> = { exp1: EXPENSIVE }
      const po = usePersistedOperations({ getPersistedOperation: (id: string) => store[id] ?? null, allowArbitraryOperations: true })
      const fq = useFareql({ charge: fakeCharge(log) })
      const yoga = yogaWith(order === 'persisted-first' ? [po, fq] : [fq, po])
      const ext = { persistedQuery: { version: 1, sha256Hash: 'exp1' } }
      const mixed = await yoga.fetch(gql('{ hello }', undefined, {}, { extensions: ext }))
      const b = await mixed.json()
      expect(b.data?.expensive).toBeUndefined()
      // id only: the stored expensive document is charged
      const idOnly = await yoga.fetch(
        new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extensions: ext }) }),
      )
      expect(idOnly.status).toBe(402)
      expect(challengeOf(idOnly).amount).toBe('0.02')
      // a credential for the cheap/free query never pays the stored one
      expect(log.every((l) => l.amount === '0.02')).toBe(true)
    })
  }

  it('ATTACK 4a: a paid Yoga response carries Cache-Control: private (real mppx withReceipt)', async () => {
    const { charge } = realMppx()
    const yoga = createYoga({ logging: false, schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge })] })
    const { client } = realClient(async (r) => yoga.fetch(r))
    const r = await client.fetch(`http://localhost/graphql?query=${encodeURIComponent(EXPENSIVE)}`, { headers: { accept: 'application/json' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('payment-receipt')).toBeTruthy()
    const cc = (r.headers.get('cache-control') ?? '').toLowerCase()
    expect(cc.includes('private') || cc.includes('no-store')).toBe(true)
  })

  it('ATTACK 4b: response cache hit served to a payer still carries private Cache-Control', async () => {
    const { charge } = realMppx()
    const yoga = createYoga({ logging: false, schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge }), useResponseCache({ session: () => null })] })
    const { client } = realClient(async (r) => yoga.fetch(r))
    await client.fetch('http://localhost/graphql', post(EXPENSIVE))
    // second GET is answered from the response cache: no gate, no receipt, no private header
    const r = await yoga.fetch(new Request(`http://localhost/graphql?query=${encodeURIComponent(EXPENSIVE)}`, { headers: { accept: 'application/json' } }))
    const body = await r.json()
    if (body.data?.expensive) {
      const cc = (r.headers.get('cache-control') ?? '').toLowerCase()
      expect(cc.includes('private') || cc.includes('no-store')).toBe(true)
    }
  })

  it('ATTACK 6a: single-element batch of a priced operation is still charged', async () => {
    const yoga = yogaWith([useFareql({ charge: fakeCharge() })])
    const r = await yoga.fetch(
      new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ query: EXPENSIVE }]) }),
    )
    const b = await r.json()
    const first = Array.isArray(b) ? b[0] : b
    expect(first.data?.expensive).toBeUndefined()
  })

  it('ATTACK 6b: a single-element batch cannot reuse one credential for a second request body', async () => {
    const yoga = yogaWith([useFareql({ charge: fakeCharge() })])
    const c = challengeOf(await yoga.fetch(gql(EXPENSIVE)))
    // paid credential + batch of [paid op, other priced op]
    const r = await yoga.fetch(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...payFor(c) },
        body: JSON.stringify([{ query: EXPENSIVE }, { query: 'mutation { generateImage(prompt: "x") }' }]),
      }),
    )
    const b = await r.json()
    expect(b[0].data?.expensive).toBeUndefined()
    expect(b[1].data?.generateImage).toBeUndefined()
  })

  it('ATTACK 6c: multipart batch (operations is a JSON array) is detected', async () => {
    const yoga = yogaWith([useFareql({ charge: fakeCharge() })])
    const fd = new FormData()
    fd.set('operations', JSON.stringify([{ query: '{ hello }' }, { query: EXPENSIVE }]))
    fd.set('map', '{}')
    const r = await yoga.fetch(new Request('http://localhost/graphql', { method: 'POST', body: fd, headers: { 'graphql-require-preflight': '1' } }))
    const b = await r.json()
    expect(Array.isArray(b) ? b[1].data?.expensive : b.data?.expensive).toBeUndefined()
  })

  it('ATTACK 6d: a custom request parser returning an array is detected as a batch', async () => {
    const custom = {
      onRequestParse({ request, setRequestParser }: any) {
        if (request.headers.get('content-type') === 'application/x-ops') {
          setRequestParser(async (req: Request) => (await req.text()).split('\n---\n').map((query) => ({ query })))
        }
      },
    }
    const yoga = yogaWith([custom, useFareql({ charge: fakeCharge() })])
    const r = await yoga.fetch(new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/x-ops' }, body: `{ hello }\n---\n${EXPENSIVE}` }))
    const b = await r.json()
    expect(b[1].data?.expensive).toBeUndefined()
  })

  // ── subscriptions / SSE ──
  const subTypeDefs = /* GraphQL */ `
    ${fareDirectiveTypeDefs}
    type Query { hello: String, secret: String @price(amount: "0.01") }
    type Subscription { ticks: Int @price(amount: "0.01") }
  `
  const subResolvers = {
    Query: { hello: () => 'hi', secret: () => 'SECRET' },
    Subscription: {
      ticks: {
        async *subscribe() {
          for (let i = 0; i < 3; i++) yield { ticks: i }
        },
      },
    },
  }
  const subYoga = (log: ChargeLog = [], extra: Record<string, unknown> = {}) =>
    createYoga({ logging: false, schema: createSchema({ typeDefs: subTypeDefs, resolvers: subResolvers }), plugins: [useFareql({ charge: fakeCharge(log), ...extra })] })

  it('ATTACK 7a: unpaid priced subscription over SSE yields no data', { timeout: 10000 }, async () => {
    const yoga = subYoga()
    const r = await yoga.fetch(
      new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ query: 'subscription { ticks }' }) }),
    )
    const text = await r.text()
    expect(text).not.toMatch(/"ticks":\d/)
  })

  it('ATTACK 7b: unpaid priced subscription over SSE returns a usable 402 Challenge', { timeout: 10000 }, async () => {
    const yoga = subYoga()
    const r = await yoga.fetch(
      new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ query: 'subscription { ticks }' }) }),
    )
    await r.text()
    expect(r.status).toBe(402)
    expect(r.headers.get('www-authenticate')).toMatch(/^Payment/)
  })

  it('ATTACK 7c: priced query over SSE / GET event-stream yields no data unpaid', { timeout: 10000 }, async () => {
    const yoga = subYoga()
    const r = await yoga.fetch(new Request(`http://localhost/graphql?query=${encodeURIComponent('{ secret }')}`, { headers: { accept: 'text/event-stream' } }))
    const text = await r.text()
    expect(text).not.toContain('SECRET')
  })

  it('ATTACK 7d: one payment buys a bounded subscription, not an unbounded stream (design check)', { timeout: 10000 }, async () => {
    const log: ChargeLog = []
    // Fixed: a payment buys maxSubscriptionEvents events (default 100), then the stream ends.
    const yoga = subYoga(log, { maxSubscriptionEvents: 1 })
    const req = (h: Record<string, string> = {}) =>
      new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...h }, body: JSON.stringify({ query: 'subscription { ticks }' }) })
    const c = challengeOf(await yoga.fetch(req()))
    const r = await yoga.fetch(req(payFor(c)))
    const text = await r.text()
    const events = (text.match(/"ticks":\d/g) ?? []).length
    expect(text).toContain('PAYMENT_EXHAUSTED')
    // Each event costs 0.01 per the schema, but only the start is charged.
    const charged = log.filter((l) => l.amount === '0.01').length
    expect(events).toBeLessThanOrEqual(1)
    expect(charged).toBeGreaterThan(0)
  })

  it('ATTACK 8a: graphql-ws recipe (yoga.getEnveloped, contextValue without `request`) executes priced ops for free', async () => {
    const log: ChargeLog = []
    const yoga = createYoga({ logging: false, schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge: fakeCharge(log) })] })
    // This mirrors the official Yoga + graphql-ws recipe: the WebSocket upgrade request is passed as `req`.
    const fakeUpgrade = { headers: { host: 'localhost' }, url: '/graphql' }
    const params = { query: EXPENSIVE }
    const { execute, contextFactory, schema } = yoga.getEnveloped({ req: fakeUpgrade, socket: {}, params } as any)
    const result: any = await execute({ schema, document: parse(params.query), contextValue: await contextFactory(), variableValues: {} } as any)
    expect(result.data?.expensive).toBeUndefined()
  })

  it('ATTACK 8b: real mppx credential replay with different variables / operation name is refused', async () => {
    const { charge, settled } = realMppx()
    const yoga = createYoga({ logging: false, schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge })] })
    const { client, credentials } = realClient(async (r) => yoga.fetch(r))
    const q = 'query W($c: String!) { weather(city: $c) { temperature } }'
    await client.fetch('http://localhost/graphql', post(q, {}, { c: 'Denver' }))
    const cred = credentials.at(-1)!
    expect(settled).toEqual(['0.001'])
    const otherVars = await yoga.fetch(new Request('http://localhost/graphql', post(q, { authorization: cred }, { c: 'Paris' })))
    expect(otherVars.status).toBe(402)
    const otherPath = await yoga.fetch(new Request('http://localhost/other?x=1', post('{ search(query: "x", first: 2) { snippet } }', { authorization: cred })))
    expect([402, 404]).toContain(otherPath.status)
    expect(settled).toEqual(['0.001'])
  })

  it('ATTACK 8c: a forged Payment-Receipt / garbage Authorization header does not unlock execution', async () => {
    const { charge } = realMppx()
    const yoga = createYoga({ logging: false, schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge })] })
    for (const auth of ['Payment abc', 'Payment ' + Buffer.from('{}').toString('base64url'), 'Bearer x']) {
      const r = await yoga.fetch(gql(EXPENSIVE, undefined, { authorization: auth, 'payment-receipt': 'forged' }))
      expect((await r.json()).data?.expensive).toBeUndefined()
      expect(r.status).not.toBe(200)
    }
  })

  it('ATTACK 9a: masked errors do not turn the 402 into a 200/500 with data', async () => {
    const yoga = yogaWith([useFareql({ charge: fakeCharge() })], [], { maskedErrors: true })
    const r = await yoga.fetch(gql(EXPENSIVE))
    expect(r.status).toBe(402)
    expect((await r.json()).errors[0].extensions.code).toBe('PAYMENT_REQUIRED')
  })

  it('ATTACK 9b: exposePrice:false hides the price in every error body', async () => {
    const yoga = yogaWith([useFareql({ charge: fakeCharge(), exposePrice: false, pricing: { maxPrice: '0.01' } })])
    const r = await yoga.fetch(gql(EXPENSIVE))
    const b = await r.json()
    expect(JSON.stringify(b)).not.toContain('0.02')
  })

  it('ATTACK 9c: a charge handler that throws fails closed (no data)', async () => {
    const yoga = yogaWith([useFareql({ charge: () => async () => { throw new Error('rpc down') } })])
    const r = await yoga.fetch(gql(EXPENSIVE))
    expect((await r.json()).data?.expensive).toBeUndefined()
  })

  it('ATTACK 9d: introspection and __typename stay free and do not leak priced data', async () => {
    const log: ChargeLog = []
    const yoga = yogaWith([useFareql({ charge: fakeCharge(log) })])
    const r = await yoga.fetch(gql('{ __typename __schema { queryType { name } } }'))
    expect(r.status).toBe(200)
    expect(log).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('Apollo plugin attacks', () => {
  async function apollo(log: ChargeLog = [], extraPlugins: any[] = [], opts: Record<string, unknown> = {}, before = true) {
    const fq = fareqlApolloPlugin({ charge: fakeCharge(log) })
    const server = new ApolloServer({ typeDefs, resolvers, plugins: before ? [...extraPlugins, fq] : [fq, ...extraPlugins], ...opts } as any)
    await server.start()
    return server
  }

  it('ATTACK 5a: Host header with invalid URL characters does not bypass payment', async () => {
    const server = await apollo()
    for (const host of ['bad host', 'a\tb', '[::1', 'x/y?z#']) {
      const r = await apolloRun(server, { query: EXPENSIVE }, { host })
      expect(r.json?.data?.expensive).toBeUndefined()
      expect(r.status).not.toBe(200)
    }
  })

  it('ATTACK 5b: Host header with invalid URL characters yields a 4xx, not a 500', async () => {
    const server = await apollo()
    const r = await apolloRun(server, { query: EXPENSIVE }, { host: 'bad host' })
    expect(r.status).toBeLessThan(500)
  })

  it('ATTACK 5c: HTTP batch with two priced operations and one credential runs only the paid one', async () => {
    const server = await apollo([], [], { allowBatchedHttpRequests: true })
    const first = await apolloRun(server, { query: EXPENSIVE })
    const c = challengeOf(new Response(null, { headers: first.headers }))
    const r = await apolloRun(server, [{ query: EXPENSIVE }, { query: 'mutation { generateImage(prompt: "x") }' }, { query: EXPENSIVE }], payFor(c))
    expect(Array.isArray(r.json)).toBe(true)
    expect(r.json[1].data?.generateImage ?? null).toBeNull()
    // the same credential paying twice inside one batch: method-level replay protection is the only guard
    const paidTwice = r.json.filter((x: any) => x.data?.expensive).length
    expect(paidTwice).toBeLessThanOrEqual(1)
  })

  it('ATTACK 5d: HTTP batch [free, priced] unpaid leaks no priced data', async () => {
    const server = await apollo([], [], { allowBatchedHttpRequests: true })
    const r = await apolloRun(server, [{ query: '{ hello }' }, { query: EXPENSIVE }])
    expect(r.json[1].data?.expensive).toBeUndefined()
  })

  for (const before of [true, false]) {
    it(`ATTACK 5e: Apollo response cache (${before ? 'before' : 'after'} FareQL) does not serve paid results unpaid`, async () => {
      const server = await apollo([], [ApolloServerPluginCacheControl({ defaultMaxAge: 60 }), responseCachePlugin()], {}, before)
      const first = await apolloRun(server, { query: EXPENSIVE })
      const c = challengeOf(new Response(null, { headers: first.headers }))
      const paid = await apolloRun(server, { query: EXPENSIVE }, payFor(c))
      expect(paid.json.data.expensive.pages).toBe(3)
      const freeloader = await apolloRun(server, { query: EXPENSIVE })
      expect(freeloader.status).toBe(402)
      expect(freeloader.json.data?.expensive).toBeUndefined()
    })
  }

  it('ATTACK 5f: Apollo APQ registered hash for an expensive op is priced on hash-only replay', async () => {
    const { createHash } = await import('node:crypto')
    const server = await apollo()
    const hash = createHash('sha256').update(EXPENSIVE).digest('hex')
    const ext = { persistedQuery: { version: 1, sha256Hash: hash } }
    // Apollo only registers an APQ after a successful run, so the attacker pays once to register it.
    const first = await apolloRun(server, { query: EXPENSIVE, extensions: ext })
    expect(first.status).toBe(402)
    const c = challengeOf(new Response(null, { headers: first.headers }))
    const paid = await apolloRun(server, { query: EXPENSIVE, extensions: ext }, payFor(c))
    expect(paid.status).toBe(200)
    const r = await apolloRun(server, { extensions: ext })
    expect(r.status).toBe(402)
    expect(r.json.data?.expensive).toBeUndefined()
    // cheap text + expensive hash: Apollo rejects mismatching hash
    const mixed = await apolloRun(server, { query: '{ hello }', extensions: ext })
    expect(mixed.json.data?.expensive).toBeUndefined()
  })

  for (const before of [true, false]) {
    it(`ATTACK 4c: paid Apollo response with public cache hints stays private (cacheControl plugin ${before ? 'before' : 'after'})`, async () => {
      const { charge } = realMppx()
      const fq = fareqlApolloPlugin({ charge })
      const cc = ApolloServerPluginCacheControl({ defaultMaxAge: 300 })
      const server = new ApolloServer({ typeDefs, resolvers, plugins: before ? [cc, fq] : [fq, cc] })
      await server.start()
      const { client } = realClient(apolloFetch(server))
      const r = await client.fetch('http://api.example.com/graphql', post(EXPENSIVE, { 'apollo-require-preflight': '1' }))
      expect(r.status).toBe(200)
      expect(r.headers.get('payment-receipt')).toBeTruthy()
      const value = (r.headers.get('cache-control') ?? '').toLowerCase()
      expect(value).not.toContain('public')
      expect(value.includes('private') || value.includes('no-store')).toBe(true)
    })
  }

  it('ATTACK 5g: GET mutation is refused before any charge', async () => {
    const log: ChargeLog = []
    const server = await apollo(log)
    const r = await apolloRun(server, undefined, { 'apollo-require-preflight': '1' }, 'GET', `?query=${encodeURIComponent('mutation { generateImage(prompt: "x") }')}`)
    expect(r.status).toBe(405)
    expect(log).toHaveLength(0)
  })

  it('ATTACK 5h: real mppx credential from a cheap Apollo op cannot pay an expensive one', async () => {
    const { charge, settled } = realMppx()
    const server = new ApolloServer({ typeDefs, resolvers, plugins: [fareqlApolloPlugin({ charge })] })
    await server.start()
    const handler = apolloFetch(server)
    const { client, credentials } = realClient(handler)
    await client.fetch('http://api.example.com/graphql', post('{ weather(city: "x") { temperature } }'))
    const cred = credentials.at(-1)!
    const r = await handler(new Request('http://api.example.com/graphql', post(EXPENSIVE, { authorization: cred })))
    expect(r.status).toBe(402)
    expect(settled).toEqual(['0.001'])
  })
})
