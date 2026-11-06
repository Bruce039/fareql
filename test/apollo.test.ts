import { ApolloServer, HeaderMap } from '@apollo/server'
import { describe, expect, it } from 'vitest'
import { fareqlApolloPlugin } from '../src/apollo.js'
import { type ChargeLog, challengeOf, fakeCharge, resolvers, typeDefs } from './fixtures.js'

async function setup(log: ChargeLog = [], pricing = {}) {
  const server = new ApolloServer({ typeDefs, resolvers, plugins: [fareqlApolloPlugin({ charge: fakeCharge(log), pricing })] })
  await server.start()
  const run = async (query: string, headers: Record<string, string> = {}, method = 'POST') => {
    const h = new HeaderMap([
      ['content-type', 'application/json'],
      ['host', 'api.example.com'],
      ...Object.entries(headers),
    ])
    const r = await server.executeHTTPGraphQLRequest({
      httpGraphQLRequest:
        method === 'POST'
          ? { method, headers: h, search: '', body: { query } }
          : { method, headers: new HeaderMap([['host', 'api.example.com'], ['apollo-require-preflight', 'true']]), search: `?query=${encodeURIComponent(query)}`, body: undefined },
      context: async () => ({}),
    })
    const text = r.body.kind === 'complete' ? r.body.string : ''
    const headersOut = new Headers()
    for (const [k, v] of r.headers) headersOut.set(k, v)
    return { status: r.status ?? 200, headers: headersOut, json: JSON.parse(text) }
  }
  return { server, run }
}

describe('fareqlApolloPlugin (Apollo Server)', () => {
  it('serves free operations normally', async () => {
    const { run } = await setup()
    const r = await run('{ hello }')
    expect(r.status).toBe(200)
    expect(r.json.data.hello).toBe('hi')
  })

  it('answers 402 with the Challenge, then executes and adds Payment-Receipt', async () => {
    const log: ChargeLog = []
    const { run } = await setup(log)
    const q = '{ search(query: "x", first: 2) { snippet } }'
    const first = await run(q)
    expect(first.status).toBe(402)
    expect(first.json.errors[0].extensions.code).toBe('PAYMENT_REQUIRED')
    expect(first.json.errors[0].extensions.price.amount).toBe('0.0014')
    expect(first.json.data).toBeUndefined()
    const c = challengeOf(new Response(null, { headers: first.headers }))
    expect(c.amount).toBe('0.0014')
    const paid = await run(q, { authorization: `Payment ${c.amount}|${c.scope}` })
    expect(paid.status).toBe(200)
    expect(paid.headers.get('payment-receipt')).toBe('ok;amount=0.0014')
    expect(paid.json.data.search).toHaveLength(1)
  })

  it('rejects over-limit operations with 400 and no charge', async () => {
    const log: ChargeLog = []
    const { run } = await setup(log, { maxPrice: '0.01' })
    const r = await run('{ expensive { pages } }')
    expect(r.status).toBe(400)
    expect(r.json.errors[0].extensions.code).toBe('PRICE_LIMIT_EXCEEDED')
    expect(log).toHaveLength(0)
  })

  it('hides the price in limit errors when exposePrice is false', async () => {
    const server = new ApolloServer({ typeDefs, resolvers, plugins: [fareqlApolloPlugin({ charge: fakeCharge(), exposePrice: false, pricing: { maxPrice: '0.01' } })] })
    await server.start()
    const r = await server.executeHTTPGraphQLRequest({
      httpGraphQLRequest: { method: 'POST', headers: new HeaderMap([['content-type', 'application/json']]), search: '', body: { query: '{ expensive { pages } }' } },
      context: async () => ({}),
    })
    const text = r.body.kind === 'complete' ? r.body.string : ''
    expect(text).toContain('PRICE_LIMIT_EXCEEDED')
    expect(text).not.toContain('0.02')
    expect(text).not.toContain('0.01')
  })

  it('prices GET queries', async () => {
    const { run } = await setup()
    expect((await run('{ expensive { pages } }', {}, 'GET')).status).toBe(402)
  })

  it('does not charge in-process executeOperation calls', async () => {
    const log: ChargeLog = []
    const { server } = await setup(log)
    const r = await server.executeOperation({ query: '{ expensive { pages } }' })
    expect(r.body.kind === 'single' && r.body.singleResult.data).toEqual({ expensive: { pages: 3 } })
    expect(log).toHaveLength(0)
  })
})
