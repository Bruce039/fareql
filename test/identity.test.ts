import { ApolloServer, HeaderMap } from '@apollo/server'
import { createSchema, createYoga } from 'graphql-yoga'
import { Credential, Method, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { fareqlApolloPlugin } from '../src/apollo.js'
import { type IdentityVerifier, type Tier, withPayment } from '../src/index.js'
import { useFareql } from '../src/yoga.js'
import { type ChargeLog, challengeOf, fakeCharge, gql, payFor, resolvers, schema, typeDefs } from './fixtures.js'

const WEATHER = '{ weather(city: "Baku") { temperature } }' // 0.001

/** API-key verifier shaped like `Identity.from`: missing without a key, forbidden for an unknown one. */
function apiKeyVerifier(calls = { n: 0 }): IdentityVerifier {
  return {
    verify(request) {
      calls.n++
      const key = request.headers.get('x-api-key')
      if (!key) return { status: 'missing' }
      if (key !== 'good-key') return { status: 'invalid', code: 403, reason: 'Unknown API key' }
      return { status: 'valid', value: { member: 'satoshi' } }
    },
  }
}

const emailVerifier: IdentityVerifier = {
  verify(request) {
    const proof = request.headers.get('x-email-proof')
    if (!proof) return { status: 'missing' }
    if (proof === 'down') return { status: 'invalid', code: 503, reason: 'Issuer unavailable' }
    if (proof !== 'ok') return { status: 'invalid', reason: 'Bad attestation' }
    return { status: 'valid', value: { email: 'a@b.c' } }
  },
}

const tiers: Tier[] = [
  { name: 'member', verifier: apiKeyVerifier(), multiplier: '0.25' },
  { name: 'verified', verifier: emailVerifier, multiplier: '0.5' },
]

describe('identity tiers (Fetch gate)', () => {
  const handler = (log: ChargeLog = [], extra: Partial<Parameters<typeof withPayment>[1]> = {}) =>
    withPayment(() => Response.json({ data: { ok: true } }), { schema, charge: fakeCharge(log), tiers, ...extra })

  it('charges each tier its multiplier of the base price', async () => {
    const h = handler()
    expect(challengeOf(await h(gql(WEATHER))).amount).toBe('0.001')
    expect(challengeOf(await h(gql(WEATHER, undefined, { 'x-email-proof': 'ok' }))).amount).toBe('0.0005')
    expect(challengeOf(await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key' }))).amount).toBe('0.00025')
    // Best tier first: a member who also proves an email pays the member price.
    expect(challengeOf(await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key', 'x-email-proof': 'ok' }))).amount).toBe('0.00025')
  })

  it('binds the tier into the scope, and leaves the anonymous scope unchanged', async () => {
    const h = handler()
    const anon = challengeOf(await h(gql(WEATHER)))
    const member = challengeOf(await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key' })))
    expect(anon.scope).toMatch(/^graphql:[0-9a-f]{32}$/)
    expect(member.scope).toBe(`${anon.scope}:tier=member`)
    const plain = withPayment(() => Response.json({}), { schema, charge: fakeCharge() })
    expect(challengeOf(await plain(gql(WEATHER))).scope).toBe(anon.scope)
  })

  it('rounds up to the smallest unit', async () => {
    const h = handler()
    // 10 ids × 0.000001 = 0.00001; × 0.25 = 0.0000025, rounded up to 0.000003.
    expect(challengeOf(await h(gql('{ ids }'))).amount).toBe('0.00001')
    expect(challengeOf(await h(gql('{ ids }', undefined, { 'x-api-key': 'good-key' }))).amount).toBe('0.000003')
  })

  it('pays with the tier proof and refuses a Credential replayed without it', async () => {
    const h = handler()
    const member = challengeOf(await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key' })))
    const ok = await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key', ...payFor(member) }))
    expect(ok.status).toBe(200)
    const dropped = await h(gql(WEATHER, undefined, payFor(member)))
    expect(dropped.status).toBe(402)
    expect(challengeOf(dropped).amount).toBe('0.001')
  })

  it('refuses a presented but wrong proof instead of charging the dearer price', async () => {
    const log: ChargeLog = []
    const h = handler(log)
    const bad = await h(gql(WEATHER, undefined, { 'x-api-key': 'stolen' }))
    expect(bad.status).toBe(403)
    expect((await bad.json()).errors[0].extensions.code).toBe('FORBIDDEN')
    const badEmail = await h(gql(WEATHER, undefined, { 'x-email-proof': 'forged' }))
    expect(badEmail.status).toBe(401)
    const down = await h(gql(WEATHER, undefined, { 'x-email-proof': 'down' }))
    expect(down.status).toBe(503)
    expect(log).toEqual([]) // never reached the payment method
  })

  it('requires a proof when anonymous callers are turned off', async () => {
    const h = handler([], { anonymous: false })
    const r = await h(gql(WEATHER))
    expect(r.status).toBe(401)
    expect((await r.json()).errors[0].extensions.code).toBe('UNAUTHENTICATED')
    // Free operations never need a proof.
    expect((await h(gql('{ hello }'))).status).toBe(200)
  })

  it('makes a "0" tier free without calling the payment method', async () => {
    const log: ChargeLog = []
    const h = withPayment(() => Response.json({ data: { ok: true } }), {
      schema,
      charge: fakeCharge(log),
      tiers: [{ name: 'staff', verifier: apiKeyVerifier(), multiplier: '0' }],
    })
    expect((await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key' }))).status).toBe(200)
    expect(log).toEqual([])
  })

  it('applies maxPrice to the base price, the same limit for every tier', async () => {
    const h = handler([], { pricing: { maxPrice: '0.0009' } })
    const r = await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key' })) // 0.00025 after the tier, 0.001 base
    expect(r.status).toBe(400)
    expect((await r.json()).errors[0].extensions.code).toBe('PRICE_LIMIT_EXCEEDED')
  })

  it('lists the price of every tier in the 402 body, and hides it with exposePrice: false', async () => {
    const body = await (await handler()(gql(WEATHER))).json()
    expect(body.errors[0].extensions.price).toMatchObject({
      amount: '0.001',
      tier: 'anonymous',
      baseAmount: '0.001',
      tiers: [
        { tier: 'member', amount: '0.00025' },
        { tier: 'verified', amount: '0.0005' },
      ],
    })
    const hidden = await (await handler([], { exposePrice: false })(gql(WEATHER))).json()
    expect(hidden.errors[0].extensions.price).toBeUndefined()
  })

  it('runs each verifier at most once per request', async () => {
    const calls = { n: 0 }
    const h = withPayment(() => Response.json({}), {
      schema,
      charge: fakeCharge(),
      tiers: [{ name: 'member', verifier: apiKeyVerifier(calls), multiplier: '0.5' }],
    })
    await h(gql(WEATHER, undefined, { 'x-api-key': 'good-key' }))
    expect(calls.n).toBe(1)
  })

  it('rejects misconfigured tiers at startup', () => {
    const make = (t: Tier[]) => () => withPayment(() => Response.json({}), { schema, charge: fakeCharge(), tiers: t })
    const v = apiKeyVerifier()
    expect(make([{ name: 'anonymous', verifier: v, multiplier: '1' }])).toThrow(/invalid tier name/)
    expect(make([{ name: 'a b', verifier: v, multiplier: '1' }])).toThrow(/invalid tier name/)
    expect(make([{ name: 'm', verifier: v, multiplier: '-1' }])).toThrow(/invalid multiplier/)
    expect(make([{ name: 'm', verifier: v, multiplier: '1e3' }])).toThrow(/invalid multiplier/)
    expect(make([{ name: 'm', verifier: v, multiplier: '1' }, { name: 'm', verifier: v, multiplier: '1' }])).toThrow(/duplicate/)
    expect(make([{ name: 'm', verifier: { ...v, stage: 'payment' }, multiplier: '1' }])).toThrow(/payment-stage/)
  })
})

describe('identity tiers (Yoga and Apollo)', () => {
  it('Yoga charges the tier price and returns the identity status codes', async () => {
    const yoga = createYoga({ schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge: fakeCharge(), tiers })] })
    expect(challengeOf(await yoga.fetch(gql(WEATHER, undefined, { 'x-api-key': 'good-key' }))).amount).toBe('0.00025')
    expect((await yoga.fetch(gql(WEATHER, undefined, { 'x-api-key': 'stolen' }))).status).toBe(403)
  })

  it('Apollo charges the tier price and returns the identity status codes', async () => {
    const apollo = new ApolloServer({ typeDefs, resolvers, plugins: [fareqlApolloPlugin({ charge: fakeCharge(), tiers })] })
    await apollo.start()
    const run = (headers: [string, string][]) =>
      apollo.executeHTTPGraphQLRequest({
        httpGraphQLRequest: {
          method: 'POST',
          headers: new HeaderMap([['content-type', 'application/json'], ['host', 'localhost'], ...headers]),
          search: '',
          body: { query: WEATHER },
        },
        context: async () => ({}),
      })
    const member = await run([['x-api-key', 'good-key']])
    expect(member.status).toBe(402)
    expect(/amount="([^"]+)"/.exec(member.headers.get('www-authenticate') ?? '')?.[1]).toBe('0.00025')
    expect((await run([['x-api-key', 'stolen']])).status).toBe(403)
    await apollo.stop()
  })
})

// ── Real mppx loop: a Credential bought at the member price cannot be spent without the member proof ──
const testCharge = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string() }),
  },
})

describe('identity tiers through real mppx', () => {
  it('settles at the tier price and refuses the Credential when the proof is dropped', async () => {
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
      secretKey: 'identity-test-secret-key-000000000000000',
      realm: 'graphql.test',
    })
    const yoga = createYoga({
      schema: createSchema({ typeDefs, resolvers }),
      plugins: [useFareql({ charge: (o) => server.charge(o as never), tiers })],
    })
    let credential: string | undefined
    const client = ClientMppx.create({
      polyfill: false,
      fetch: async (input, init) => {
        const req = new Request(input, init)
        credential = req.headers.get('authorization') ?? credential
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
    const post = (headers: Record<string, string>) =>
      ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify({ query: WEATHER }) }) as RequestInit

    const paid = await client.fetch('http://localhost/graphql', post({ 'x-api-key': 'good-key' }))
    expect(paid.status).toBe(200)
    expect(settled).toEqual(['0.00025'])
    expect(credential).toMatch(/^Payment /)

    // Same Credential, proof removed: the request resolves to the anonymous tier, whose scope differs.
    const dropped = await yoga.fetch(new Request('http://localhost/graphql', post({ authorization: credential! })))
    expect(dropped.status).toBe(402)
    expect(settled).toEqual(['0.00025'])
  })
})
