import { createHash } from 'node:crypto'
import { useAPQ } from '@graphql-yoga/plugin-apq'
import { GraphQLError, type ValidationRule } from 'graphql'
import { createSchema, createYoga } from 'graphql-yoga'
import { describe, expect, it } from 'vitest'
import { useFareql } from '../src/yoga.js'
import { type ChargeLog, challengeOf, fakeCharge, gql, payFor, resolvers, typeDefs } from './fixtures.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function server(log: ChargeLog = [], extra: Parameters<typeof useFareql>[0] extends infer O ? Partial<O> : never = {}, plugins: any[] = []) {
  return createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    batching: true,
    plugins: [...plugins, useFareql({ charge: fakeCharge(log), ...extra })],
  })
}

describe('useFareql (GraphQL Yoga plugin)', () => {
  it('serves free operations normally', async () => {
    const r = await server().fetch(gql('{ hello }'))
    expect(r.status).toBe(200)
    expect((await r.json()).data.hello).toBe('hi')
  })

  it('answers 402 for priced operations, then executes and adds Payment-Receipt', async () => {
    const yoga = server()
    const q = 'mutation { generateImage(prompt: "cat") }'
    const first = await yoga.fetch(gql(q))
    expect(first.status).toBe(402)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const b = await first.json()
    expect(b.errors[0].extensions.code).toBe('PAYMENT_REQUIRED')
    expect(b.errors[0].extensions.price.amount).toBe('0.05')
    expect(b.errors[0].extensions.http).toBeUndefined()
    const c = challengeOf(first)
    expect(c.amount).toBe('0.05')
    const paid = await yoga.fetch(gql(q, undefined, payFor(c)))
    expect(paid.status).toBe(200)
    expect(paid.headers.get('payment-receipt')).toBe('ok;amount=0.05')
    expect((await paid.json()).data.generateImage).toBe('https://img')
  })

  it('prices GET queries and refuses GET mutations before payment', async () => {
    const yoga = server()
    const get = (q: string) => yoga.fetch(new Request(`http://localhost/graphql?query=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } }))
    expect((await get('{ expensive { pages } }')).status).toBe(402)
    expect((await get('mutation { generateImage(prompt: "x") }')).status).toBe(405)
  })

  it('rejects invalid documents and over-limit operations without charging', async () => {
    const log: ChargeLog = []
    const yoga = server(log, { pricing: { maxPrice: '0.01' } })
    const invalid = await yoga.fetch(gql('{ nope }'))
    expect((await invalid.json()).errors[0].message).toMatch(/nope/)
    const limit = await yoga.fetch(gql('{ expensive { pages } }'))
    expect(limit.status).toBe(400)
    expect((await limit.json()).errors[0].extensions.code).toBe('PRICE_LIMIT_EXCEEDED')
    expect(log).toHaveLength(0)
  })

  it('prices documents restored by the APQ plugin registered before it', async () => {
    const yoga = server([], {}, [useAPQ()])
    const query = '{ expensive { pages } }'
    const ext = { persistedQuery: { version: 1, sha256Hash: sha256(query) } }
    const hashOnly = () =>
      yoga.fetch(new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extensions: ext }) }))
    expect((await (await hashOnly()).json()).errors[0].message).toMatch(/PersistedQueryNotFound/)
    expect((await yoga.fetch(gql(query, undefined, {}, { extensions: ext }))).status).toBe(402) // registers it
    const restored = await hashOnly()
    expect(restored.status).toBe(402)
    expect(challengeOf(restored).amount).toBe('0.02')
  })

  it('never charges for an operation another plugin rejects during validation', async () => {
    const log: ChargeLog = []
    // Stand-in for graphql-armor / depth limits: a validation rule that forbids `expensive`.
    const forbid: ValidationRule = (ctx) => ({
      Field(node) {
        if (node.name.value === 'expensive') ctx.reportError(new GraphQLError('expensive is disabled'))
      },
    })
    const yoga = server(log, {}, [{ onValidate: ({ addValidationRule }: any) => addValidationRule(forbid) }])
    const r = await yoga.fetch(gql('{ expensive { pages } }'))
    expect((await r.json()).errors[0].message).toBe('expensive is disabled')
    expect(log).toHaveLength(0)
  })

  it('prices what actually runs, whatever hash a client sends alongside', async () => {
    const log: ChargeLog = []
    const yoga = server(log, {}, [useAPQ()])
    const ext = { persistedQuery: { version: 1, sha256Hash: sha256('{ expensive { pages } }') } }
    const r = await yoga.fetch(gql('{ hello }', undefined, {}, { extensions: ext }))
    const b = await r.json()
    expect(b.data?.expensive).toBeUndefined()
    expect(log.every((l) => l.amount !== '0.02')).toBe(true)
  })

  it('allows free operations in batches but not priced ones', async () => {
    const log: ChargeLog = []
    const yoga = server(log)
    const batch = (ops: string[]) =>
      yoga.fetch(new Request('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ops.map((query) => ({ query }))) }))
    const free = await (await batch(['{ hello }', '{ hello }'])).json()
    expect(free.map((r: any) => r.data.hello)).toEqual(['hi', 'hi'])
    const priced = await (await batch(['{ hello }', '{ expensive { pages } }'])).json()
    expect(priced[1].errors[0].extensions.code).toBe('BATCHING_NOT_SUPPORTED')
    expect(log).toHaveLength(0)
  })
})
