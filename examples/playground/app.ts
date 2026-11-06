// The playground app as a Fetch handler, shared by the Node server (server.ts) and the
// Cloudflare Worker (worker.ts). It imports FareQL from the repository sources so the
// playground always runs the current code; an app would import from 'fareql'.
import { createSchema, createYoga } from 'graphql-yoga'
import { Challenge, Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, tempo } from 'mppx/server'
import { fareDirectiveTypeDefs } from '../../src/index.js'
import { useFareql } from '../../src/yoga.js'

export type PlaygroundConfig = {
  /** The page (index.html). */
  page: string
  /** Real payments to this address (with `secretKey`). Without both, the playground uses a demo method. */
  recipient?: string
  /** Tempo network for real payments. Default: mainnet (USDC.e). */
  network?: 'mainnet' | 'testnet'
  secretKey?: string
  /** HMAC secret for the demo method's Challenges. */
  demoSecret?: string
}

export const typeDefs = /* GraphQL */ `
  ${fareDirectiveTypeDefs}
  type Query {
    hello: String
    weather(city: String!): Forecast @price(amount: "0.001")
    search(query: String!, first: Int = 5): [Hit!]! @price(amount: "0.0005")
    users(first: Int!): UserConnection!
    node(id: ID!): Node
  }
  type Forecast {
    temperature: Float
    hourly(limit: Int): [Hour!]!
  }
  type Hour {
    hour: Int
    detail: String @price(amount: "0.0001")
  }
  type Hit {
    title: String
    snippet: String @price(amount: "0.0002")
  }
  type UserConnection {
    edges: [UserEdge!]!
  }
  type UserEdge {
    node: User!
  }
  type User {
    name: String
    email: String @price(amount: "0.001")
  }
  interface Node {
    id: ID!
  }
  type Article implements Node {
    id: ID!
    title: String
  }
  type Report implements Node @price(amount: "0.02") {
    id: ID!
    pages: Int
  }
`

const resolvers = {
  Query: {
    hello: () => 'Hello, this field is free.',
    weather: (_: unknown, { city }: { city: string }) => ({ city, temperature: Math.round(city.length * 3.7 * 10) / 10 }),
    search: (_: unknown, { query, first }: { query: string; first: number }) =>
      Array.from({ length: Math.min(first, 100) }, (_, i) => ({ title: `${query} #${i + 1}`, snippet: `Result ${i + 1} for "${query}"` })),
    users: (_: unknown, { first }: { first: number }) => ({
      edges: Array.from({ length: Math.min(first, 100) }, (_, i) => ({ node: { name: `user ${i + 1}`, email: `user${i + 1}@example.com` } })),
    }),
    node: (_: unknown, { id }: { id: string }) => (id.startsWith('r') ? { __typename: 'Report', id, pages: 12 } : { __typename: 'Article', id, title: 'Hello' }),
  },
  Forecast: {
    hourly: (f: { temperature: number }, { limit }: { limit?: number }) =>
      Array.from({ length: Math.min(limit ?? 10, 100) }, (_, hour) => ({ hour, detail: `${f.temperature + hour / 10}°` })),
  },
  Node: { __resolveType: (n: { __typename: string }) => n.__typename },
}

// Demo payment method: real mppx Challenges, Credentials and Receipts, but no money moves.
const demoCharge = Method.from({
  name: 'demo',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string() }),
  },
})

const TEMPO = {
  mainnet: { currency: '0x20C000000000000000000000b9537d11c60E8b50', testnet: false }, // USDC.e on Tempo mainnet
  testnet: { currency: '0x20c0000000000000000000000000000000000001', testnet: true }, // pathUSD on Moderato
} as const
const fromBase64Url = (s: string) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/')
  return decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4))))
}

const headersOf = (r: Response) => Object.fromEntries([...r.headers].filter(([k]) => k !== 'content-length'))

async function snapshot(r: Response) {
  const text = await r.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: r.status, headers: headersOf(r), body }
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

export function createPlayground(config: PlaygroundConfig): (request: Request) => Promise<Response> {
  const real = Boolean(config.recipient && config.secretKey)
  const network = config.network ?? 'mainnet'
  const mode = real ? network : 'demo'
  const mppx = real
    ? Mppx.create({
        methods: [
          tempo.charge({ ...TEMPO[network], recipient: config.recipient as `0x${string}` }),
        ],
        secretKey: config.secretKey!,
      })
    : Mppx.create({
        methods: [
          Method.toServer(demoCharge, {
            defaults: { currency: 'DEMO' },
            async verify({ credential }) {
              return { method: 'demo', status: 'success', reference: `demo-${credential.challenge.id.slice(0, 8)}`, timestamp: new Date().toISOString() }
            },
          }),
        ],
        secretKey: config.demoSecret ?? 'playground-demo-secret-key-not-for-production',
        realm: 'fareql-playground',
      })

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: '/graphql',
    graphiql: false,
    logging: false,
    plugins: [useFareql({ charge: (o) => mppx.charge(o as never), pricing: { maxPrice: '1' } })],
  })

  /** An MPP client (as an app or agent would run it) that records the Credential it sends. */
  const demoClient = (sent: string[]) =>
    ClientMppx.create({
      polyfill: false,
      fetch: (input, init) => {
        const request = new Request(input, init)
        const auth = request.headers.get('authorization')
        if (auth) sent.push(auth)
        return Promise.resolve(yoga.fetch(request))
      },
      methods: [
        Method.toClient(demoCharge, {
          async createCredential({ challenge }) {
            return Credential.serialize(Credential.from({ challenge, payload: { token: 'demo' } }))
          },
        }),
      ],
    })

  /** Runs one operation the way an MPP client would and records every step. */
  async function walk(origin: string, query: string, variables: unknown, pay: boolean) {
    const endpoint = `${origin}/graphql`
    const init = () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const steps: unknown[] = []
    const first = await yoga.fetch(new Request(endpoint, init()))
    const firstSnap = await snapshot(first.clone())
    let challenge: unknown
    if (first.status === 402) {
      try {
        const c = Challenge.fromHeaders(first.headers) as { opaque?: string }
        // mppx keeps the scope in the HMAC-protected opaque field (base64url JSON).
        const opaque = c.opaque ? JSON.parse(fromBase64Url(c.opaque)) : {}
        challenge = { ...c, scope: opaque._mppx_scope }
      } catch {}
    }
    steps.push({ kind: 'request', label: 'Request without payment', ...firstSnap, challenge })
    if (first.status !== 402 || !pay || real) return { mode, steps }

    const sent: string[] = []
    const paid = await demoClient(sent).fetch(endpoint, init())
    const paidSnap = await snapshot(paid.clone())
    let receipt: unknown
    try {
      receipt = Receipt.fromResponse(paid)
    } catch {}
    steps.push({ kind: 'credential', label: 'The mppx client pays the Challenge and retries with a Credential', credential: sent.at(-1) })
    steps.push({ kind: 'response', label: 'Paid response', ...paidSnap, receipt })
    return { mode: 'demo', steps }
  }

  const page = config.page
    .replace('__MODE__', mode)
    .replace('__SCHEMA__', JSON.stringify(typeDefs.replace(fareDirectiveTypeDefs, '').trim()))

  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } })
    }
    if (url.pathname === '/demo/run' && request.method === 'POST') {
      try {
        const { query, variables, pay } = (await request.json()) as { query?: string; variables?: unknown; pay?: boolean }
        return json(200, await walk(url.origin, String(query ?? ''), variables ?? {}, Boolean(pay)))
      } catch (e) {
        return json(400, { error: (e as Error).message })
      }
    }
    if (url.pathname === '/demo/replay' && request.method === 'POST') {
      // Re-sends a Credential issued for one operation with another operation, as an attacker would.
      try {
        const { query, variables, credential } = (await request.json()) as { query?: string; variables?: unknown; credential?: string }
        const r = await yoga.fetch(
          new Request(`${url.origin}/graphql`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', authorization: String(credential ?? '') },
            body: JSON.stringify({ query, variables: variables ?? {} }),
          }),
        )
        return json(200, await snapshot(r))
      } catch (e) {
        return json(400, { error: (e as Error).message })
      }
    }
    if (url.pathname === '/graphql') return yoga.fetch(request)
    return new Response('Not found', { status: 404 })
  }
}
