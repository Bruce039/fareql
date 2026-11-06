import { buildSchema, parse } from 'graphql'
import { describe, expect, it } from 'vitest'
import { type PricingOptions, PriceLimitError, PricingError, formatUnits, parseUnits, priceOperation } from '../src/index.js'
import { schema } from './fixtures.js'

const quote = (query: string, variables?: Record<string, unknown>, opts: PricingOptions = {}) =>
  priceOperation({ schema, document: parse(query), variables }, opts)
const price = (query: string, variables?: Record<string, unknown>, opts: PricingOptions = {}) => quote(query, variables, opts).amount

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as PricingError).code
  }
  return undefined
}

describe('units', () => {
  it('round-trips decimal amounts exactly', () => {
    expect(parseUnits('0.000001', 6)).toBe(1n)
    expect(formatUnits(parseUnits('12.5', 6), 6)).toBe('12.5')
    expect(formatUnits(0n, 6)).toBe('0')
    expect(() => parseUnits('0.0000001', 6)).toThrow(PricingError)
    expect(() => parseUnits('-1', 6)).toThrow(PricingError)
    expect(() => parseUnits('1e3', 6)).toThrow(PricingError)
  })
})

describe('field and type prices', () => {
  it('is free for unpriced fields and introspection', () => {
    expect(price('{ hello __typename }')).toBe('0')
    expect(price('{ __schema { types { name } } }')).toBe('0')
  })

  it('charges a field directive once per alias', () => {
    expect(price('{ weather(city: "Denver") { temperature } }')).toBe('0.001')
    expect(price('{ a: weather(city: "x") { temperature } b: weather(city: "y") { temperature } }')).toBe('0.002')
  })

  it('applies a type-level @price to fields returning the type', () => {
    expect(price('{ expensive { pages } }')).toBe('0.02')
  })

  it('lets fieldPrice override directives', () => {
    const opts: PricingOptions = { fieldPrice: ({ field }) => (field.name === 'hello' ? '0.1' : undefined) }
    expect(price('{ hello }', undefined, opts)).toBe('0.1')
  })
})

describe('lists', () => {
  it('multiplies by the size argument, its default, or defaultListSize', () => {
    expect(price('{ search(query: "x") { title snippet } }')).toBe('0.0035') // default first: 5
    expect(price('query($n: Int) { search(query: "x", first: $n) { snippet } }', { n: 2 })).toBe('0.0014')
    expect(price('{ weather(city: "x") { hourly { detail } } }')).toBe('0.002') // 0.001 + 10 × 0.0001
    expect(price('{ ids }')).toBe('0.00001')
  })

  it('clamps sizes to maxListSize (default 100)', () => {
    expect(price('{ weather(city: "x") { hourly(limit: 99999) { detail } } }')).toBe('0.011')
    expect(price('{ weather(city: "x") { hourly(limit: 99999) { detail } } }', undefined, { maxListSize: 24 })).toBe('0.0034')
  })

  it('reads @listSize(assumedSize)', () => {
    expect(price('{ tags }', undefined, { defaultFieldPrice: '0.000001' })).toBe('0.000003')
  })
})

describe('connections', () => {
  it('passes a Relay connection size argument to edges and nodes', () => {
    expect(price('{ users(first: 50) { edges { node { email } } pageInfo { hasNextPage } } }')).toBe('0.05')
    expect(price('{ users(first: 20) { nodes { email } } }')).toBe('0.02')
    expect(price('{ users { nodes { email } } }')).toBe('0.01')
  })

  it('can turn the connection heuristic off', () => {
    expect(price('{ users(first: 50) { edges { node { email } } } }', undefined, { connections: false })).toBe('0.01')
  })

  it('follows @listSize(slicingArguments, sizedFields) and requires one slicing argument', () => {
    expect(price('{ repos(first: 30) { edges { node { stars } } } }')).toBe('0.003')
    expect(price('{ repos(last: 7) { edges { node { stars } } } }')).toBe('0.0007')
    expect(codeOf(() => price('{ repos { edges { node { stars } } } }'))).toBe('SLICING_ARGUMENT_REQUIRED')
    expect(codeOf(() => price('{ repos(first: 1, last: 2) { edges { node { stars } } } }'))).toBe('SLICING_ARGUMENT_REQUIRED')
  })
})

describe('abstract types', () => {
  it('charges the most expensive branch of a union, never the sum of branches', () => {
    expect(price('{ item(id: "1") { ... on Cheap { name } ... on Pricey { secret } } }')).toBe('0.01')
  })

  it('includes type-level prices of possible runtime types', () => {
    // node can resolve to a Report, which costs 0.02 by itself
    expect(price('{ node(id: "1") { id ... on Pricey { secret } ... on Cheap { name } } }')).toBe('0.02')
    expect(price('{ entity(id: "1") { ... on Cheap { name } } }')).toBe('0.02')
  })

  it('reports only the winning branch in the breakdown', () => {
    const q = quote('{ item(id: "1") { ... on Cheap { name } ... on Pricey { secret } } }')
    expect(q.breakdown).toEqual([{ path: 'item.secret', unitAmount: '0.01', count: '1', amount: '0.01' }])
  })
})

describe('documents', () => {
  it('follows named fragments and respects @skip / @include', () => {
    const q = 'query($s: Boolean!) { weather(city: "x") { ...F } } fragment F on Forecast { hourly(limit: 3) @skip(if: $s) { detail } }'
    expect(price(q, { s: true })).toBe('0.001')
    expect(price(q, { s: false })).toBe('0.0013')
    expect(price('query($i: Boolean = false) { weather(city: "x") @include(if: $i) { temperature } }')).toBe('0')
  })

  it('prices mutations and picks the named operation', () => {
    const doc = 'query A { hello } mutation B { generateImage(prompt: "cat") }'
    expect(priceOperation({ schema, document: parse(doc), operationName: 'B' }).amount).toBe('0.05')
    expect(codeOf(() => priceOperation({ schema, document: parse(doc) }))).toBe('UNKNOWN_OPERATION')
    expect(codeOf(() => priceOperation({ schema, document: parse(doc), operationName: 'C' }))).toBe('UNKNOWN_OPERATION')
  })

  it('rejects invalid variables before pricing', () => {
    expect(codeOf(() => price('query($n: Int) { search(query: "x", first: $n) { title } }', { n: 'many' }))).toBe('INVALID_VARIABLES')
  })

  it('itemises the price so the breakdown adds up to the total', () => {
    const q = quote('{ search(query: "x", first: 2) { snippet } weather(city: "x") { temperature } }')
    expect(q.amount).toBe('0.0024')
    expect(q.breakdown).toEqual([
      { path: 'search', unitAmount: '0.0005', count: '2', amount: '0.001' },
      { path: 'search.snippet', unitAmount: '0.0002', count: '2', amount: '0.0004' },
      { path: 'weather', unitAmount: '0.001', count: '1', amount: '0.001' },
    ])
    const sum = q.breakdown.reduce((s, b) => s + parseUnits(b.amount, 6), 0n)
    expect(sum).toBe(q.units)
  })
})

describe('limits', () => {
  it('enforces maxPrice', () => {
    expect(() => price('{ search(query: "x", first: 1000) { snippet } }', undefined, { maxPrice: '0.01' })).toThrow(PriceLimitError)
    expect(price('{ search(query: "x", first: 1000) { snippet } }', undefined, { maxPrice: '0.07' })).toBe('0.07')
  })

  it('terminates on fragment cycles even without validation', () => {
    expect(price('query { ...A } fragment A on Query { ...A hello }')).toBe('0')
    const nested = 'query { weather(city: "x") { ...F } } fragment F on Forecast { hourly { detail } ...F }'
    expect(price(nested)).toBe('0.002')
  })

  it('collects fields like the executor, so fragment bombs are linear', () => {
    const frags = ['fragment F0 on Query { expensive { pages } }']
    for (let i = 1; i <= 30; i++) frags.push(`fragment F${i} on Query { ...F${i - 1} ...F${i - 1} }`)
    const started = Date.now()
    expect(price(`{ ...F30 } ${frags.join(' ')}`)).toBe('0.02')
    expect(Date.now() - started).toBeLessThan(200)
    expect(codeOf(() => price('{ search(query: "x") { snippet } }', undefined, { maxFieldVisits: 1 }))).toBe('TOO_COMPLEX')
  })

  it('charges a field selected twice under one response key once, like the executor resolves it', () => {
    expect(price('{ weather(city: "x") { temperature } ...W } fragment W on Query { weather(city: "x") { temperature } }')).toBe('0.001')
  })

  it('refuses negative list sizes and charges null or unbounded sizes at maxListSize', () => {
    expect(codeOf(() => price('{ search(query: "x", first: -5) { snippet } }'))).toBe('INVALID_LIST_SIZE')
    expect(price('{ search(query: "x", first: null) { snippet } }')).toBe('0.07')
  })

  it('refuses deep nesting', () => {
    expect(codeOf(() => price('{ weather(city: "x") { hourly { detail } } }', undefined, { maxDepth: 1 }))).toBe('TOO_COMPLEX')
  })

  it('fails closed on a schema without any price', () => {
    const bare = buildSchema('type Query { a: Int }')
    expect(codeOf(() => priceOperation({ schema: bare, document: parse('{ a }') }))).toBe('NO_PRICES')
    expect(priceOperation({ schema: bare, document: parse('{ a }') }, { defaultFieldPrice: '0.1' }).amount).toBe('0.1')
  })
})
