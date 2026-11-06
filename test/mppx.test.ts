import { ApolloServer, HeaderMap } from '@apollo/server'
import { createSchema, createYoga } from 'graphql-yoga'
import { Credential, Method, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, tempo } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { type ChargeFactory, withPayment } from '../src/index.js'
import { fareqlApolloPlugin } from '../src/apollo.js'
import { useFareql } from '../src/yoga.js'
import { gql, resolvers, schema, typeDefs } from './fixtures.js'

const decodeRequest = (header: string) => {
  const raw = /request="([^"]+)"/.exec(header)?.[1]
  return JSON.parse(Buffer.from(raw ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
}

// ── Real Tempo method: issuing a Challenge needs no RPC ──────────────────────
describe('real mppx with tempo.charge (offline Challenge)', () => {
  const payment = Mppx.create({
    methods: [
      tempo.charge({
        currency: '0x20c0000000000000000000000000000000000001', // pathUSD on Moderato testnet
        recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        testnet: true,
      }),
    ],
    secretKey: 'test-secret-key-not-for-production-000000',
    realm: 'graphql.example.com',
  })
  const charge: ChargeFactory = (o) => payment.charge(o)

  it('withPayment: the Challenge amount is the operation price in base units', async () => {
    const handler = withPayment(() => Response.json({ data: { ok: true } }), { schema, charge })
    const r = await handler(gql('{ weather(city: "Denver") { temperature } }'))
    expect(r.status).toBe(402)
    const header = r.headers.get('www-authenticate') ?? ''
    expect(header).toMatch(/^Payment /)
    expect(decodeRequest(header).amount).toBe('1000') // 0.001 at 6 decimals
    expect(header).toContain('realm="graphql.example.com"')
    expect((await handler(gql('{ hello }'))).status).toBe(200)
  })

  it('Yoga and Apollo issue the same Tempo Challenge', async () => {
    const yoga = createYoga({ schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge })] })
    const y = await yoga.fetch(gql('{ search(query: "x", first: 2) { snippet } }'))
    expect(y.status).toBe(402)
    expect(decodeRequest(y.headers.get('www-authenticate') ?? '').amount).toBe('1400')

    const apollo = new ApolloServer({ typeDefs, resolvers, plugins: [fareqlApolloPlugin({ charge })] })
    await apollo.start()
    const a = await apollo.executeHTTPGraphQLRequest({
      httpGraphQLRequest: {
        method: 'POST',
        headers: new HeaderMap([['content-type', 'application/json'], ['host', 'graphql.example.com']]),
        search: '',
        body: { query: '{ search(query: "x", first: 2) { snippet } }' },
      },
      context: async () => ({}),
    })
    expect(a.status).toBe(402)
    expect(decodeRequest(a.headers.get('www-authenticate') ?? '').amount).toBe('1400')
  })
})

// ── A settlement-free method, to run the whole 402 → pay → 200 loop through mppx ──
const testCharge = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string() }),
  },
})

function realLoop() {
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
    secretKey: 'another-test-secret-key-0000000000000000',
    realm: 'graphql.test',
  })
  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    plugins: [useFareql({ charge: (o) => server.charge(o as never) })],
  })
  const credentials: string[] = []
  const client = ClientMppx.create({
    polyfill: false,
    fetch: async (input, init) => {
      const req = new Request(input, init)
      const auth = req.headers.get('authorization')
      if (auth) credentials.push(auth)
      return yoga.fetch(req)
    },
    methods: [
      Method.toClient(testCharge, {
        async createCredential({ challenge }) {
          return Credential.serialize(Credential.from({ challenge, payload: { token: 'ok' } }))
        },
      }),
    ],
  })
  const post = (query: string, headers: Record<string, string> = {}) =>
    ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify({ query }) }) as RequestInit
  return { settled, yoga, client, credentials, post }
}

describe('real mppx client ↔ server loop (settlement-free test method)', () => {
  it('pays the 402 automatically and returns data with a Payment-Receipt', async () => {
    const { client, settled, post } = realLoop()
    const r = await client.fetch('http://localhost/graphql', post('{ search(query: "x", first: 2) { snippet } }'))
    expect(r.status).toBe(200)
    expect(r.headers.get('payment-receipt')).toBeTruthy()
    expect((await r.json()).data.search).toHaveLength(1)
    expect(settled).toEqual(['0.0014'])
  })

  it('does not pay for free operations', async () => {
    const { client, settled, post } = realLoop()
    const r = await client.fetch('http://localhost/graphql', post('{ hello }'))
    expect((await r.json()).data.hello).toBe('hi')
    expect(settled).toEqual([])
  })

  it('rejects a real Credential for a cheap query replayed on an expensive one', async () => {
    const { client, credentials, yoga, settled, post } = realLoop()
    await client.fetch('http://localhost/graphql', post('{ weather(city: "x") { temperature } }'))
    const cheapCredential = credentials.at(-1)
    expect(cheapCredential).toMatch(/^Payment /)
    expect(settled).toEqual(['0.001'])

    // Same price, different operation: the amount matches but the scope does not.
    const sameAmount = await yoga.fetch(new Request('http://localhost/graphql', post('{ a: weather(city: "y") { temperature } }', { authorization: cheapCredential! })))
    expect(sameAmount.status).toBe(402)
    const expensive = await yoga.fetch(new Request('http://localhost/graphql', post('{ expensive { pages } }', { authorization: cheapCredential! })))
    expect(expensive.status).toBe(402)
    expect(settled).toEqual(['0.001'])

    // Control: the same Credential on the operation it was issued for is accepted
    // (this test method does not track replays; real methods like tempo.charge do).
    const same = await yoga.fetch(new Request('http://localhost/graphql', post('{ weather(city: "x") { temperature } }', { authorization: cheapCredential! })))
    expect(same.status).toBe(200)
    expect(settled).toEqual(['0.001', '0.001'])
  })
})
