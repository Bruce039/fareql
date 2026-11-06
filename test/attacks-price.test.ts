/**
 * Offensive tests against the pricing engine. Every test asserts the SECURE / CORRECT
 * behaviour, so a FAILING test means the attack works.
 */
import {
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  buildClientSchema,
  buildSchema,
  execute,
  introspectionFromSchema,
  parse,
  validate,
} from 'graphql'
import { describe, expect, it } from 'vitest'
import { type PricingOptions, PricingError, chargeOperations, fareDirectiveTypeDefs, priceOperation } from '../src/index.js'
import { fakeCharge, schema } from './fixtures.js'

const quote = (query: string, variables?: Record<string, unknown>, opts: PricingOptions = {}, s: GraphQLSchema = schema) =>
  priceOperation({ schema: s, document: parse(query), variables }, opts)
const price = (query: string, variables?: Record<string, unknown>, opts: PricingOptions = {}, s: GraphQLSchema = schema) =>
  quote(query, variables, opts, s).amount

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

const valid = (s: GraphQLSchema, q: string) => expect(validate(s, parse(q)).map((e) => e.message)).toEqual([])

// A schema with a resolver that behaves like typical servers do.
const listSchema = buildSchema(/* GraphQL */ `
  ${fareDirectiveTypeDefs}
  type Query {
    items(first: Int): [Item!]! @price(amount: "0.001")
    floats(limit: Float): [Item!]! @price(amount: "0.001")
    grid(rows: Int): [[Cell!]!]!
    usersPage(first: Int): UserPage!
    top(top: Int): [Item!]! @price(amount: "0.001")
    filtered(page: PageInput): [Item!]! @price(amount: "0.001")
    assumed(first: Int): [Item!]! @price(amount: "0.001") @listSize(assumedSize: 2)
  }
  input PageInput { limit: Int }
  type Item { id: Int }
  type Cell { v: String @price(amount: "0.001") }
  type UserPage { items: [PageUser!]! }
  type PageUser { email: String @price(amount: "0.001") }
`)
const all = Array.from({ length: 1000 }, (_, i) => ({ id: i }))

describe('ATTACK 1: negative list size', () => {
  it('ATTACK 1: first: -5 is priced as a free list while slice(0, -5) returns 995 items', async () => {
    const q = '{ items(first: -5) { id } }'
    valid(listSchema, q)
    const res = await execute({
      schema: listSchema,
      document: parse(q),
      rootValue: { items: ({ first }: { first: number }) => all.slice(0, first) },
    })
    const returned = (res.data?.['items'] as unknown[]).length
    expect(returned).toBe(995)
    // secure: either reject negative sizes or charge the worst case (maxListSize)
    const e = errorOf(() => quote(q, undefined, {}, listSchema))
    if (!(e instanceof PricingError)) expect(quote(q, undefined, {}, listSchema).units).toBe(100n * 1000n)
  })

  it('ATTACK 1b: negative slicing argument under @listSize', () => {
    const e = errorOf(() => price('{ repos(first: -1) { edges { node { stars } } } }'))
    if (!(e instanceof PricingError)) expect(price('{ repos(first: -1) { edges { node { stars } } } }')).not.toBe('0')
  })
})

describe('ATTACK 2: explicit null size', () => {
  it('ATTACK 2: first: null falls back to defaultListSize, while servers read null as "no limit"', () => {
    // fixture default is first: Int = 5; explicit null overrides the default at execution time
    const q = '{ search(query: "x", first: null) { snippet } }'
    valid(schema, q)
    // secure: null = unbounded = maxListSize (100) → 100 × (0.0005 + 0.0002) = 0.07
    expect(price(q)).toBe('0.07')
  })

  it('ATTACK 2b: same via a null variable', () => {
    const q = 'query($n: Int) { items(first: $n) { id } }'
    expect(price(q, { n: null }, {}, listSchema)).toBe('0.1')
  })
})

describe('ATTACK 3: exponential fragment bombs without counted visits', () => {
  const bomb = (leaf: string, depth: number, on = 'Query') => {
    const frags = [`fragment F0 on ${on} { ${leaf} }`]
    for (let i = 1; i <= depth; i++) frags.push(`fragment F${i} on ${on} { ...F${i - 1} ...F${i - 1} }`)
    return frags.join(' ')
  }
  // depth 20 = 1M spreads (bounded); depth 30 would be 1024× longer.
  const DEPTH = 20

  it('ATTACK 3: __typename-only fragment bomb is not stopped by maxFieldVisits', { timeout: 5000 }, () => {
    const q = `{ ...F${DEPTH} } ${bomb('__typename', DEPTH)}`
    valid(schema, q)
    const t = Date.now()
    const e = errorOf(() => price(q))
    const ms = Date.now() - t
    // Fixed by graphql-js field collection: repeated spreads are visited once, so the bomb is linear.
    expect(e === undefined || (e as PricingError).code === 'TOO_COMPLEX').toBe(true)
    expect(ms).toBeLessThan(200)
  })

  it('ATTACK 3b: @skip(if: true)-only fragment bomb', { timeout: 5000 }, () => {
    const q = `{ ...F${DEPTH} } ${bomb('hello @skip(if: true)', DEPTH)}`
    valid(schema, q)
    const t = Date.now()
    const e = errorOf(() => price(q))
    const ms = Date.now() - t
    expect(e === undefined || (e as PricingError).code === 'TOO_COMPLEX').toBe(true)
    expect(ms).toBeLessThan(200)
  })

  it('ATTACK 3c: bomb whose leaf only applies to another union member', { timeout: 5000 }, () => {
    const frags = ['fragment F0 on Pricey { secret }']
    for (let i = 1; i <= DEPTH; i++) frags.push(`fragment F${i} on Item { ...F${i - 1} ...F${i - 1} }`)
    const q = `{ item(id: "1") { ...F${DEPTH} } } ${frags.join(' ')}`
    valid(schema, q)
    const t = Date.now()
    errorOf(() => price(q))
    expect(Date.now() - t).toBeLessThan(200)
  })

  it('ATTACK 3d: the executor and validator handle the same bomb linearly (pricer is the only exponential stage)', { timeout: 5000 }, () => {
    const q = `{ ...F${DEPTH} } ${bomb('__typename', DEPTH)}`
    const t = Date.now()
    validate(schema, parse(q))
    execute({ schema, document: parse(q) })
    expect(Date.now() - t).toBeLessThan(200)
  })
})

describe('ATTACK 4: deep nesting', () => {
  const deep = buildSchema(/* GraphQL */ `
    ${fareDirectiveTypeDefs}
    type Query { t: T }
    type T { t: T, v: String @price(amount: "0.000001") }
  `)
  const nest = (n: number, open: string, leaf: string) => `{ ${open.repeat(n)} ${leaf} ${'}'.repeat(n)} }`

  it('ATTACK 4: deep field nesting gives a PricingError, never a RangeError', { timeout: 5000 }, () => {
    for (let n = 1000; n <= 6000; n += 250) {
      const q = nest(n, 't {', 'v')
      let doc
      try {
        doc = parse(q)
        if (validate(deep, doc).length > 0) continue
      } catch {
        continue // parse/validate already refuse this depth, so the pricer is not the weak link
      }
      const e = errorOf(() => priceOperation({ schema: deep, document: doc }))
      expect(e === undefined || e instanceof PricingError, `depth ${n}: ${String(e)}`).toBe(true)
    }
  })

  it('ATTACK 4b: deep inline-fragment nesting (no field visits counted)', { timeout: 5000 }, () => {
    for (const n of [2000, 5000, 9000]) {
      let doc
      try {
        doc = parse(nest(n, '... on Query {', 'hello'))
      } catch {
        continue // the parser itself refused it
      }
      const e = errorOf(() => priceOperation({ schema, document: doc }))
      expect(e === undefined || e instanceof PricingError, `depth ${n}: ${String(e)}`).toBe(true)
    }
  })
})

describe('ATTACK 5: interface prices', () => {
  const iface = buildSchema(/* GraphQL */ `
    ${fareDirectiveTypeDefs}
    type Query { s: Secretive, a: Account, acc: Account }
    interface Secretive { secret: String @price(amount: "1") }
    type Account implements Secretive & Premium { secret: String, id: ID }
    interface Premium @price(amount: "2") { id: ID }
  `)

  it('ATTACK 5: @price on an interface field is ignored when the implementation has none', () => {
    // Account also implements Premium (@price 2), so each Account costs 2 + secret 1.
    expect(price('{ s { secret } }', undefined, {}, iface)).toBe('3')
    expect(price('{ a { secret } }', undefined, {}, iface)).toBe('3')
  })

  it('ATTACK 5b: type-level @price on an implemented interface is ignored for concrete return types', () => {
    expect(price('{ acc { id } }', undefined, {}, iface)).not.toBe('0')
  })
})

describe('ATTACK 6: nested lists', () => {
  it('ATTACK 6: [[Cell]] is multiplied by both list dimensions', () => {
    // 10 rows × 10 (default) cells × 0.001 = 0.1
    expect(price('{ grid(rows: 10) { v } }', undefined, {}, listSchema)).toBe('0.1')
  })
})

describe('ATTACK 7: pagination wrappers and size arguments the heuristics miss', () => {
  it('ATTACK 7: non-*Connection wrapper ignores first: 100', () => {
    expect(price('{ usersPage(first: 100) { items { email } } }', undefined, {}, listSchema)).toBe('0.1')
  })

  it('ATTACK 7b: size argument with an unlisted name (top)', () => {
    expect(price('{ top(top: 100) { id } }', undefined, {}, listSchema)).toBe('0.1')
  })

  it('ATTACK 7c: size argument nested in an input object', () => {
    expect(price('{ filtered(page: { limit: 100 }) { id } }', undefined, {}, listSchema)).toBe('0.1')
  })
})

describe('ATTACK 8: overcharge versus what the executor resolves', () => {
  const countCalls = async (q: string) => {
    let calls = 0
    await execute({
      schema,
      document: parse(q),
      rootValue: {
        weather: () => {
          calls++
          return { temperature: 1, hourly: [] }
        },
      },
    })
    return calls
  }

  it('ATTACK 8: same field twice (same response key) is resolved once and must be charged once', async () => {
    const q = '{ weather(city: "x") { temperature } weather(city: "x") { temperature } }'
    valid(schema, q)
    expect(await countCalls(q)).toBe(1)
    expect(price(q)).toBe('0.001')
  })

  it('ATTACK 8b: the same fragment spread twice', async () => {
    const q = '{ ...F ...F } fragment F on Query { weather(city: "x") { temperature } }'
    valid(schema, q)
    expect(await countCalls(q)).toBe(1)
    expect(price(q)).toBe('0.001')
  })

  it('ATTACK 8c: Relay-style overlapping fragments', async () => {
    const q =
      '{ ...A ...B } fragment A on Query { weather(city: "x") { temperature } } fragment B on Query { weather(city: "x") { temperature } }'
    valid(schema, q)
    expect(await countCalls(q)).toBe(1)
    expect(price(q)).toBe('0.001')
  })
})

describe('ATTACK 9: other vectors', () => {
  it('ATTACK 9a: Float size argument 1e400 = Infinity passes validation and is priced at the default', () => {
    const q = '{ floats(limit: 1e400) { id } }'
    valid(listSchema, q)
    // secure: unbounded → maxListSize → 100 × 0.001
    expect(price(q, undefined, {}, listSchema)).toBe('0.1')
  })

  it('ATTACK 9b: duplicate operation names: pricer picks the first, executor runs the last', async () => {
    const q = 'query A { hello } query A { expensive { pages } }'
    // Fixed: ambiguous operation names are refused instead of guessing.
    const refused = errorOf(() => priceOperation({ schema, document: parse(q), operationName: 'A' }))
    expect((refused as PricingError).code).toBe('UNKNOWN_OPERATION')
    const pricedAmount = '0.02'
    const res = await execute({
      schema,
      document: parse(q),
      operationName: 'A',
      rootValue: { hello: () => 'hi', expensive: () => ({ pages: 3 }) },
    })
    expect(res.data).toHaveProperty('expensive') // executor ran the expensive one
    expect(pricedAmount).toBe('0.02')
  })

  it('ATTACK 9c: schema without AST nodes (code-first or buildClientSchema) prices everything at 0 instead of failing closed', () => {
    const client = buildClientSchema(introspectionFromSchema(schema))
    const e = errorOf(() => price('{ expensive { pages } }', undefined, {}, client))
    if (!(e instanceof PricingError)) expect(price('{ expensive { pages } }', undefined, {}, client)).toBe('0.02')
  })

  it('ATTACK 9c2: code-first schema with directives in extensions is free', () => {
    const Query = new GraphQLObjectType({
      name: 'Query',
      fields: {
        secret: { type: GraphQLString, extensions: { directives: { price: { amount: '1' } } } },
        list: { type: new GraphQLList(GraphQLInt), args: { first: { type: GraphQLInt } } },
      },
    })
    const s = new GraphQLSchema({ query: Query })
    expect(price('{ secret }', undefined, {}, s)).toBe('1')
  })

  it('ATTACK 9d: maxPrice is per operation, a batch can exceed it', async () => {
    const op = { document: parse('{ search(query: "x", first: 100) { snippet } }') }
    const out = await chargeOperations(new Request('http://x/graphql', { method: 'POST' }), schema, [op, op, op, op, op], {
      charge: fakeCharge(),
      pricing: { maxPrice: '0.07' },
    })
    expect(out.status).toBe('rejected')
  })

  it('ATTACK 9e: @listSize(assumedSize) silences an explicit first argument', () => {
    // first: 100 is honoured by the resolver; @listSize without slicingArguments ignores it
    expect(price('{ assumed(first: 100) { id } }', undefined, {}, listSchema)).toBe('0.1')
  })

  it('ATTACK 9f: breakdown / path memory amplification with long aliases on deep priced chains', { timeout: 5000 }, () => {
    const deep = buildSchema(/* GraphQL */ `
      ${fareDirectiveTypeDefs}
      type Query { t: T }
      type T { t: T @price(amount: "0.000001") }
    `)
    const depth = 300
    const alias = 'a'.repeat(300)
    const q = `{ ${`${alias}: t {`.repeat(depth)} __typename ${'}'.repeat(depth)} }`
    // depth 300 is now refused by maxDepth; measure amplification just under the limit too.
    expect((errorOf(() => quote(q, undefined, {}, deep)) as PricingError).code).toBe('TOO_COMPLEX')
    const q90 = `{ ${`${alias}: t {`.repeat(90)} __typename ${'}'.repeat(90)} }`
    const t = Date.now()
    const r = quote(q90, undefined, {}, deep)
    const ms = Date.now() - t
    const out = JSON.stringify(r.breakdown).length
    // secure: the 402 body should not be orders of magnitude bigger than the request
    expect({ ratio: Math.round(out / q90.length), ms }).toEqual({ ratio: expect.any(Number), ms: expect.any(Number) })
    expect(out / q90.length).toBeLessThan(10)
  })

  it('ATTACK 9g: @include(if: false) on a priced field is free and the executor also skips it (control)', () => {
    expect(price('{ weather(city: "x") @include(if: false) { temperature } }')).toBe('0')
  })

  it('ATTACK 9h: aliases are each charged (control)', () => {
    expect(price('{ a: search(query: "x", first: 100) { snippet } b: search(query: "x", first: 100) { snippet } }')).toBe('0.14')
  })
})
