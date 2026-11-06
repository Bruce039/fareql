/**
 * Offensive tests against the Fetch payment gate (src/fetch.ts + src/core.ts).
 *
 * Every test asserts the SECURE behaviour. A failing test means the attack works.
 */
import { createHash } from 'node:crypto'
import { graphql } from 'graphql'
import { createSchema, createYoga } from 'graphql-yoga'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPaymentGate, operationScope, withPayment } from '../src/index.js'
import { parse } from 'graphql'
import { type ChargeLog, challengeOf, fakeCharge, gql, payFor, schema, typeDefs } from './fixtures.js'

const URL_ = 'http://localhost/graphql'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// ── An executable copy of the fixture schema that records what actually ran ───

const executed: string[] = []
beforeEach(() => {
  executed.length = 0
})

const execSchema = createSchema({
  typeDefs,
  resolvers: {
    Query: {
      hello: () => 'hi',
      expensive: () => {
        executed.push('expensive')
        return { id: 'r', pages: 3 }
      },
      weather: () => ({ temperature: 21.5, hourly: [] }),
      users: (_: unknown, a: { first?: number | null }) => {
        executed.push(`users:${a.first}`)
        const n = a.first ?? 10
        return { edges: [], nodes: Array.from({ length: n }, (_x, i) => ({ name: `u${i}`, email: `u${i}@x` })), pageInfo: { hasNextPage: false } }
      },
    },
    Mutation: {
      generateImage: () => {
        executed.push('generateImage')
        return 'https://img'
      },
      upload: () => 'stored',
    },
  },
})

const yoga = createYoga({ schema: execSchema, logging: false, maskedErrors: false })

const CHEAP = '{ hello }'
const EXPENSIVE = '{ expensive { pages } }' // 0.02
const USERS = 'query($n: Int) { users(first: $n) { nodes { email } } }' // n missing -> 10 x 0.001 = 0.01; n=100 -> 0.1

async function run(source: unknown, variables?: unknown, operationName?: unknown): Promise<Response> {
  const r = await graphql({
    schema: execSchema,
    source: String(source ?? ''),
    variableValues: (variables ?? undefined) as Record<string, unknown> | undefined,
    operationName: (operationName ?? undefined) as string | undefined,
  })
  return Response.json(r)
}

// ── Simulated real-world handlers ─────────────────────────────────────────────

/** Hono `app.all('/graphql')` style: any method, JSON body if present, else URL params. */
const anyMethodHandler = async (req: Request) => {
  const ct = req.headers.get('content-type') ?? ''
  const p: Record<string, unknown> = ct.includes('json') ? await req.json() : Object.fromEntries(new URL(req.url).searchParams)
  const vars = typeof p.variables === 'string' ? JSON.parse(p.variables) : p.variables
  return run(p.query, vars, p.operationName)
}

/** express-graphql's getGraphQLParams: URL params win over the body, string variables are JSON-parsed. */
const expressGraphqlLike = async (req: Request) => {
  const url = new URL(req.url)
  const ct = req.headers.get('content-type') ?? ''
  let body: Record<string, unknown> = {}
  if (req.body) {
    if (ct.includes('application/json')) body = await req.json()
    else if (ct.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(await req.text()))
    else if (ct.includes('application/graphql')) body = { query: await req.text() }
  }
  const query = url.searchParams.get('query') ?? body.query
  let variables = url.searchParams.get('variables') ?? body.variables
  if (typeof variables === 'string') variables = JSON.parse(variables)
  const operationName = url.searchParams.get('operationName') ?? body.operationName
  return run(query, variables, operationName)
}

/** Common idiom: Object.fromEntries(searchParams) / last multipart field wins. */
const lastWinsHandler = async (req: Request) => {
  const ct = req.headers.get('content-type') ?? ''
  let p: Record<string, unknown>
  if (req.method === 'GET') p = Object.fromEntries(new URL(req.url).searchParams)
  else if (ct.startsWith('application/x-www-form-urlencoded')) p = Object.fromEntries(new URLSearchParams(await req.text()))
  else if (ct.startsWith('multipart/form-data')) {
    const f = await req.formData()
    p = JSON.parse(String(f.getAll('operations').at(-1)))
  } else p = await req.json()
  const vars = typeof p.variables === 'string' ? JSON.parse(p.variables) : p.variables
  return run(p.query, vars, p.operationName)
}

/** graphql-http style: GET, or POST application/json only. */
const strictJsonHandler = async (req: Request) => {
  if (req.method === 'GET') {
    const s = new URL(req.url).searchParams
    return run(s.get('query'), s.get('variables') ? JSON.parse(s.get('variables') as string) : undefined, s.get('operationName'))
  }
  if (req.method !== 'POST') return new Response('method', { status: 405 })
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return new Response('unsupported', { status: 415 })
  const b = await req.json()
  return run(b.query, b.variables, b.operationName)
}

/** Handler with a persisted-document store that prefers an id over the query text. */
const persistedPreferring = (store: Record<string, string>) => async (req: Request) => {
  const b = await req.json()
  const id = b.documentId ?? b.id ?? b.doc_id ?? b.extensions?.persistedQuery?.sha256Hash
  return run((id && store[id]) ?? b.query, b.variables, b.operationName)
}

/** Sends a request; if challenged, pays exactly what was asked and resends. */
async function sendAndPay(handler: (r: Request) => Promise<Response>, make: (h?: Record<string, string>) => Request) {
  const first = await handler(make())
  if (first.status !== 402) return { first, final: first, paid: false }
  const final = await handler(make(payFor(challengeOf(first))))
  return { first, final, paid: final.headers.get('payment-receipt') !== null }
}

const json = (body: unknown, headers: Record<string, string> = {}, method = 'POST', url = URL_) =>
  new Request(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

// ── 1. Non-GET/POST methods ──────────────────────────────────────────────────

describe('1: methods', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    it(`ATTACK 1: ${method} with a JSON body runs a priced query for free on an app.all handler`, async () => {
      const h = withPayment(anyMethodHandler, { schema, charge: fakeCharge() })
      const r = await h(json({ query: EXPENSIVE }, {}, method))
      expect(executed).not.toContain('expensive')
      expect(r.status).not.toBe(200)
    })
  }

  it('ATTACK 1: OPTIONS ?query= runs a priced query for free on an app.all handler', async () => {
    const h = withPayment(anyMethodHandler, { schema, charge: fakeCharge() })
    await h(new Request(`${URL_}?query=${encodeURIComponent(EXPENSIVE)}`, { method: 'OPTIONS' }))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 1: bodyless POST with ?query= is free at the gate but executed by express-graphql style handlers', async () => {
    const h = withPayment(expressGraphqlLike, { schema, charge: fakeCharge() })
    await h(new Request(`${URL_}?query=${encodeURIComponent(EXPENSIVE)}`, { method: 'POST' }))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 1: POST with a cheap JSON body and an expensive ?query= (URL wins in express-graphql)', async () => {
    const h = withPayment(expressGraphqlLike, { schema, charge: fakeCharge() })
    await h(json({ query: CHEAP }, {}, 'POST', `${URL_}?query=${encodeURIComponent(EXPENSIVE)}`))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 1: Yoga refuses PUT itself (control)', async () => {
    const h = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    const r = await h(json({ query: EXPENSIVE }, {}, 'PUT'))
    expect(executed).not.toContain('expensive')
    expect(r.status).toBe(405)
  })
})

// ── 2. Duplicate parameters ──────────────────────────────────────────────────

describe('2: duplicate parameters', () => {
  it('ATTACK 2: GET ?query=cheap&query=expensive (handler uses the last value)', async () => {
    const h = withPayment(lastWinsHandler, { schema, charge: fakeCharge() })
    await h(new Request(`${URL_}?query=${encodeURIComponent(CHEAP)}&query=${encodeURIComponent(EXPENSIVE)}`))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 2: GET duplicate variables (priced on the first, executed with the last)', async () => {
    const h = withPayment(lastWinsHandler, { schema, charge: fakeCharge() })
    const make = (hd: Record<string, string> = {}) =>
      new Request(`${URL_}?query=${encodeURIComponent(USERS)}&variables=${encodeURIComponent('{"n":1}')}&variables=${encodeURIComponent('{"n":100}')}`, { headers: hd })
    await sendAndPay(h, make)
    expect(executed).not.toContain('users:100')
  })

  it('ATTACK 2: form-urlencoded duplicate query', async () => {
    const h = withPayment(lastWinsHandler, { schema, charge: fakeCharge() })
    const body = `query=${encodeURIComponent(CHEAP)}&query=${encodeURIComponent(EXPENSIVE)}`
    await h(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 2: multipart duplicate "operations" field', async () => {
    const h = withPayment(lastWinsHandler, { schema, charge: fakeCharge() })
    const form = new FormData()
    form.append('operations', JSON.stringify({ query: CHEAP }))
    form.append('operations', JSON.stringify({ query: EXPENSIVE }))
    await h(new Request(URL_, { method: 'POST', body: form }))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 2: Yoga uses the first value too (control)', async () => {
    const h = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    await h(new Request(`${URL_}?query=${encodeURIComponent(CHEAP)}&query=${encodeURIComponent(EXPENSIVE)}`))
    expect(executed).not.toContain('expensive')
  })
})

// ── 3. variables / extensions as JSON strings ────────────────────────────────

describe('3: stringified variables', () => {
  const make = (hd: Record<string, string> = {}) => json({ query: USERS, variables: JSON.stringify({ n: 100 }) }, hd)

  it('ATTACK 3: string variables priced at the default (10) but executed with n=100 by express-graphql style handlers', async () => {
    const log: ChargeLog = []
    const h = withPayment(expressGraphqlLike, { schema, charge: fakeCharge(log) })
    await sendAndPay(h, make)
    expect(executed).not.toContain('users:100')
  })

  it('ATTACK 3: string variables are charged, then Yoga rejects them (pay-then-reject)', async () => {
    const h = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    const { final, paid } = await sendAndPay(h, make)
    expect(executed).not.toContain('users:100')
    expect(paid && final.status >= 400).toBe(false)
  })

  it('ATTACK 3: array variables are priced as "no variables"', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const r = await gate(json({ query: USERS, variables: [{ n: 100 }] }))
    expect(r.status).toBe('rejected')
  })
})

// ── 4. Persisted-document ids next to a cheap query ──────────────────────────

describe('4: persisted ids', () => {
  const store = { exp: EXPENSIVE, [sha256(EXPENSIVE)]: EXPENSIVE }
  for (const key of ['documentId', 'id', 'doc_id']) {
    it(`ATTACK 4: cheap query + ${key} of an expensive stored document`, async () => {
      const h = withPayment(persistedPreferring(store), { schema, charge: fakeCharge(), resolveDocument: (p) => (p.documentId ? store[p.documentId] : undefined) })
      await h(json({ query: CHEAP, [key]: 'exp' }))
      expect(executed).not.toContain('expensive')
    })
  }

  it('ATTACK 4: cheap query + extensions.persistedQuery of an expensive doc is caught by the hash check', async () => {
    const h = withPayment(persistedPreferring(store), { schema, charge: fakeCharge() })
    await h(json({ query: CHEAP, extensions: { persistedQuery: { version: 1, sha256Hash: sha256(EXPENSIVE) } } }))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 4: documentId (resolved cheap by resolveDocument) + APQ hash the handler prefers', async () => {
    const docs: Record<string, string> = { cheapdoc: CHEAP }
    const handlerStore = { [sha256(EXPENSIVE)]: EXPENSIVE } // registered once, legitimately, by the attacker
    const handler = async (req: Request) => {
      const b = await req.json()
      return run(handlerStore[b.extensions?.persistedQuery?.sha256Hash] ?? docs[b.documentId], b.variables)
    }
    const h = withPayment(handler, { schema, charge: fakeCharge(), resolveDocument: (p) => (p.documentId ? docs[p.documentId] : undefined) })
    await h(json({ documentId: 'cheapdoc', extensions: { persistedQuery: { version: 1, sha256Hash: sha256(EXPENSIVE) } } }))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 4: documentId next to a query is charged, then plain Yoga rejects the unknown param (pay-then-reject)', async () => {
    const h = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    const { final, paid } = await sendAndPay(h, (hd) => json({ query: EXPENSIVE, documentId: 'x' }, hd))
    expect(paid && final.status >= 400).toBe(false)
  })
})

// ── 5. Scope binding ─────────────────────────────────────────────────────────

describe('5: scope collisions', () => {
  const scopeOf = (ops: { query: string; operationName?: string | null; variables?: Record<string, unknown> | null }[]) =>
    operationScope(ops.map((o) => ({ document: parse(o.query), operationName: o.operationName, variables: o.variables })))

  it('ATTACK 5: block strings containing the batch separator cannot fake a batch', async () => {
    const a = '{ search(query: "a") { title } }'
    const b = '{ search(query: "b") { title } }'
    const batch = await scopeOf([{ query: a }, { query: b }])
    const sep = `\n\n{}\n--\n`
    const forged = `{ search(query: """x${sep}""") { title } }`
    const forged2 = `query A { search(query: """\nA\n{}\n--\n""") { title } }`
    expect(await scopeOf([{ query: forged }])).not.toBe(batch)
    expect(await scopeOf([{ query: forged2 }])).not.toBe(await scopeOf([{ query: 'query A { search(query: "") { title } }', operationName: 'A' }]))
    // variables and names are JSON-escaped, so they cannot inject separators
    const withX = 'query($x: String!) { search(query: $x) { title } }'
    expect(await scopeOf([{ query: withX, variables: { x: '\n--\n' } }])).not.toBe(await scopeOf([{ query: withX, variables: { x: '\\n--\\n' } }]))
  })

  it('ATTACK 5: a File variable and the string "blob:<name>:<type>:<size>" share a scope', async () => {
    const q = 'mutation($f: Upload!) { upload(file: $f) }'
    const file = await scopeOf([{ query: q, variables: { f: new File(['hello'], 'a.txt', { type: 'text/plain' }) } }])
    const str = await scopeOf([{ query: q, variables: { f: 'blob:a.txt:text/plain:5' } }])
    expect(file).not.toBe(str)
  })

  it('ATTACK 5: undeclared variables cannot change what runs, so they are left out of the scope', async () => {
    const q = '{ weather(city: "x") { temperature } }'
    expect(await scopeOf([{ query: q, variables: { junk: 1 } }])).toBe(await scopeOf([{ query: q }]))
    const declared = 'query($c: String!) { weather(city: $c) { temperature } }'
    expect(await scopeOf([{ query: declared, variables: { c: 'a' } }])).not.toBe(await scopeOf([{ query: declared, variables: { c: 'b' } }]))
  })

  it('ATTACK 5: a credential for one variable set does not pay for another (end to end)', async () => {
    const h = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    const first = await h(json({ query: USERS, variables: { n: 10 } }))
    const reuse = await h(json({ query: USERS, variables: { n: 100 } }, payFor(challengeOf(first))))
    expect(reuse.status).toBe(402)
    expect(executed).not.toContain('users:100')
  })
})

// ── 6. DoS ───────────────────────────────────────────────────────────────────

describe('6: denial of service', () => {
  it('ATTACK 6: deeply nested (undeclared) variables crash stableStringify instead of a 400', { timeout: 10000 }, async () => {
    const depth = 50_000
    const body = `{"query":${JSON.stringify(EXPENSIVE)},"variables":{"x":${'['.repeat(depth)}${']'.repeat(depth)}}}`
    const h = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    let status: number | string
    try {
      status = (await h(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body }))).status
    } catch (e) {
      status = `threw ${(e as Error).name}`
    }
    // Undeclared variables are ignored, as the executor ignores them: no crash, priced normally.
    expect([400, 402]).toContain(status)
  })

  it('ATTACK 6: no token limit; parse + validate of a large flat selection is slow and unbounded', { timeout: 10000 }, async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    // Identical repeated fields are aborted by graphql-js ("Validation aborted."); distinct aliases are not.
    const q = `{ ${Array.from({ length: 200_000 }, (_x, i) => `a${i}: hello`).join(' ')} }`
    const t = performance.now()
    const r = await gate(json({ query: q }))
    const ms = performance.now() - t
    // secure: rejected quickly by a token / size limit
    expect({ status: r.status, fast: ms < 250 }).toEqual({ status: 'rejected', fast: true })
  })

  it('ATTACK 6: multi-megabyte documents are parsed and kept in the 1000-entry LRU (no size limit)', { timeout: 10000 }, async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const big = `${EXPENSIVE}\n#${'a'.repeat(2 * 1024 * 1024)}`
    const r = await gate(json({ query: big, extensions: { persistedQuery: { version: 1, sha256Hash: sha256(big) } } }))
    // secure: refused (413) instead of cached in both the document LRU and the APQ map
    expect(r.status).toBe('rejected')
  })

  it('ATTACK 6: giant batches are priced op by op with no length limit', { timeout: 10000 }, async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge(), batching: true })
    const ops = Array.from({ length: 5000 }, (_x, i) => ({ query: `{ weather(city: "${i}") { temperature } }` }))
    const r = await gate(json(ops))
    expect(r.status).toBe('rejected')
  })
})

// ── 7. Pay-then-reject on stricter handlers ──────────────────────────────────

describe('7: pay-then-reject', () => {
  const h = () => withPayment(strictJsonHandler, { schema, charge: fakeCharge() })
  const cases: [string, (hd?: Record<string, string>) => Request][] = [
    ['application/graphql', (hd = {}) => new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/graphql', ...hd }, body: EXPENSIVE })],
    [
      'form-urlencoded',
      (hd = {}) => new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...hd }, body: new URLSearchParams({ query: EXPENSIVE }).toString() }),
    ],
    [
      'multipart',
      (hd = {}) => {
        const f = new FormData()
        f.set('operations', JSON.stringify({ query: EXPENSIVE }))
        return new Request(URL_, { method: 'POST', headers: hd, body: f })
      },
    ],
    ['application/graphql+json', (hd = {}) => new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/graphql+json', ...hd }, body: JSON.stringify({ query: EXPENSIVE }) })],
  ]
  for (const [name, make] of cases) {
    it(`ATTACK 7: ${name} is charged, then a JSON-only handler answers 415`, async () => {
      const { final, paid } = await sendAndPay(h(), make)
      expect(paid && final.status >= 400).toBe(false)
    })
  }

  it('ATTACK 7: HEAD with a priced query is charged, then Yoga answers 405', async () => {
    const y = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    const { final, paid } = await sendAndPay(y, (hd = {}) => new Request(`${URL_}?query=${encodeURIComponent(EXPENSIVE)}`, { method: 'HEAD', headers: hd }))
    expect(paid && final.status >= 400).toBe(false)
  })
})

// ── 8. Content-type tricks ───────────────────────────────────────────────────

describe('8: content types', () => {
  it('ATTACK 8: Application/JSON is charged by the (case-insensitive) gate, then Yoga refuses it', async () => {
    const y = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    const { final, paid } = await sendAndPay(y, (hd = {}) => json({ query: EXPENSIVE }, { 'content-type': 'Application/JSON', ...hd }))
    expect(paid && final.status >= 400).toBe(false)
  })

  it('ATTACK 8: content-type lists, odd params and missing content-type fail closed', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const body = JSON.stringify({ query: EXPENSIVE })
    for (const ct of ['text/plain, application/json', 'application/json ;charset=utf-8', 'application/graphql-response+json', 'application/jsonx', '']) {
      const r = await gate(new Request(URL_, { method: 'POST', headers: ct ? { 'content-type': ct } : {}, body }))
      expect(r.status === 'rejected' || r.status === 'payment-required', ct).toBe(true)
    }
    // A Blob body without type gets no content-type at all
    const r = await gate(new Request(URL_, { method: 'POST', body: new Blob([body]) }))
    expect(r.status).not.toBe('free')
  })

  it('ATTACK 8: application/json, text/plain (list) is priced the same way Yoga reads it', async () => {
    const y = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    const r = await y(json({ query: EXPENSIVE }, { 'content-type': 'application/json, text/plain' }))
    expect(r.status).toBe(402)
    expect(executed).not.toContain('expensive')
  })
})

// ── 9. Everything else ───────────────────────────────────────────────────────

describe('9: misc', () => {
  it('ATTACK 9: URL fragment hides ?query= from the gate but Yoga parses request.url after the first "?"', async () => {
    const y = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
    await y(new Request(`${URL_}#?query=${encodeURIComponent(EXPENSIVE)}`))
    await y(new Request(`${URL_}?#&query=${encodeURIComponent(EXPENSIVE)}`))
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 9: uppercase APQ hash is accepted and charged, then Yoga APQ rejects it as a mismatch', async () => {
    const { useAPQ } = await import('@graphql-yoga/plugin-apq')
    const apqYoga = createYoga({ schema: execSchema, logging: false, plugins: [useAPQ()] })
    const y = withPayment((r) => apqYoga.fetch(r), { schema, charge: fakeCharge() })
    const make = (hd: Record<string, string> = {}) => json({ query: EXPENSIVE, extensions: { persistedQuery: { version: 1, sha256Hash: sha256(EXPENSIVE).toUpperCase() } } }, hd)
    const { final, paid } = await sendAndPay(y, make)
    expect(paid && final.status >= 400).toBe(false)
  })

  it('ATTACK 9: operationName "" / 0 select the only operation at the gate, but graphql-js finds none (pay-then-reject)', async () => {
    for (const operationName of ['', 0]) {
      const y = withPayment((r) => yoga.fetch(r), { schema, charge: fakeCharge() })
      const { final, paid } = await sendAndPay(y, (hd) => json({ query: 'query Q { expensive { pages } }', operationName }, hd))
      const b = (await final.clone().json()) as { data?: unknown }
      expect(paid && !b.data, `operationName=${JSON.stringify(operationName)}`).toBe(false)
    }
  })

  it('ATTACK 9: query as an object / array / number is rejected', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    for (const query of [{ kind: 'Document' }, [EXPENSIVE], 1]) expect((await gate(json({ query }))).status).toBe('rejected')
  })

  it('ATTACK 9: __proto__ in the body, variables and multipart map does not smuggle a query', async () => {
    const h = withPayment(async (req) => {
      const b = Object.assign({}, await req.json())
      return run(b.query, b.variables)
    }, { schema, charge: fakeCharge() })
    const r = await h(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"__proto__":{"query":${JSON.stringify(EXPENSIVE)}}}` }))
    expect(executed).not.toContain('expensive')
    expect(r.status).toBe(400)

    const y = withPayment((rq) => yoga.fetch(rq), { schema, charge: fakeCharge(), encodings: ['multipart/form-data'] })
    const form = new FormData()
    form.set('operations', JSON.stringify({ query: 'mutation($f: Upload!) { upload(file: $f) }', variables: { f: null } }))
    form.set('map', JSON.stringify({ 0: ['__proto__.query', 'constructor.prototype.query', 'variables.f'] }))
    form.set('0', new File(['x'], 'a.txt'))
    const m = await y(new Request(URL_, { method: 'POST', body: form }))
    expect(m.status).toBe(402)
    expect(({} as { query?: unknown }).query).toBeUndefined()
  })

  it('ATTACK 9: multipart map can overwrite "query" with a text field, consistently with Yoga', async () => {
    const y = withPayment((rq) => yoga.fetch(rq), { schema, charge: fakeCharge(), encodings: ['multipart/form-data'] })
    const form = new FormData()
    form.set('operations', JSON.stringify({ query: CHEAP }))
    form.set('map', JSON.stringify({ q: ['query'] }))
    form.set('q', EXPENSIVE)
    const r = await y(new Request(URL_, { method: 'POST', body: form }))
    expect(r.status).toBe(402)
    expect(executed).not.toContain('expensive')
  })

  it('ATTACK 9: mutations over GET/HEAD are refused before payment', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    for (const method of ['GET', 'HEAD']) {
      const r = await gate(new Request(`${URL_}?query=${encodeURIComponent('mutation { generateImage(prompt: "x") }')}`, { method }))
      expect(r.status).toBe('rejected')
    }
  })

  it('ATTACK 9: error messages do not reflect attacker-controlled header text', async () => {
    const gate = createPaymentGate({ schema, charge: fakeCharge() })
    const r = await gate(new Request(URL_, { method: 'POST', headers: { 'content-type': 'text/<script>alert(1)</script>' }, body: 'x' }))
    expect(r.status).toBe('rejected')
    const text = await (r as { response: Response }).response.text()
    expect(text).not.toContain('<script>')
  })
})
