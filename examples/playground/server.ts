// FareQL playground: a priced GraphQL API plus a page that walks through the MPP flow.
//
//   npx tsx examples/playground/server.ts              # demo mode: settlement-free test method, no money
//   MPP_SECRET_KEY=$(openssl rand -hex 32) RECIPIENT=0x... npx tsx examples/playground/server.ts
//                                                     # Moderato mode: real Tempo testnet Challenges
//
// Then open http://localhost:4000
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createSchema, createYoga } from 'graphql-yoga'
import { Challenge, Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, tempo } from 'mppx/server'
import { fareDirectiveTypeDefs } from 'fareql'
import { useFareql } from 'fareql/yoga'

const PORT = Number(process.env.PORT ?? 4000)
const MODERATO = Boolean(process.env.RECIPIENT && process.env.MPP_SECRET_KEY)

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

const mppx = MODERATO
  ? Mppx.create({
      methods: [
        tempo.charge({
          currency: '0x20c0000000000000000000000000000000000001', // pathUSD on Moderato
          recipient: process.env.RECIPIENT as `0x${string}`,
          testnet: true,
        }),
      ],
      secretKey: process.env.MPP_SECRET_KEY!,
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
      secretKey: 'playground-demo-secret-key-not-for-production',
      realm: 'localhost',
    })

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  graphiql: false,
  logging: false,
  plugins: [useFareql({ charge: (o) => mppx.charge(o as never), pricing: { maxPrice: '1' } })],
})

/** An MPP client (as an app or agent would run it) that records the Credential it sends. */
function demoClient(sent: string[]) {
  return ClientMppx.create({
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

/** Runs one operation the way an MPP client would and records every step. */
async function walk(query: string, variables: unknown, pay: boolean) {
  const init = () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const steps: unknown[] = []
  const first = await yoga.fetch(new Request(`http://localhost:${PORT}/graphql`, init()))
  const firstSnap = await snapshot(first.clone())
  let challenge: unknown
  if (first.status === 402) {
    try {
      const c = Challenge.fromHeaders(first.headers) as { opaque?: string }
      // mppx keeps the scope in the HMAC-protected opaque field (base64url JSON).
      const opaque = c.opaque ? JSON.parse(Buffer.from(c.opaque, 'base64url').toString('utf8')) : {}
      challenge = { ...c, scope: opaque._mppx_scope }
    } catch {}
  }
  steps.push({ kind: 'request', label: 'Request without payment', ...firstSnap, challenge })
  if (first.status !== 402 || !pay || MODERATO) return { mode: MODERATO ? 'moderato' : 'demo', steps }

  const sent: string[] = []
  const paid = await demoClient(sent).fetch(`http://localhost:${PORT}/graphql`, init())
  const credential = sent.at(-1)
  const paidSnap = await snapshot(paid.clone())
  let receipt: unknown
  try {
    receipt = Receipt.fromResponse(paid)
  } catch {}
  steps.push({ kind: 'credential', label: 'The mppx client pays the Challenge and retries with a Credential', credential })
  steps.push({ kind: 'response', label: 'Paid response', ...paidSnap, receipt })
  return { mode: 'demo', steps }
}

const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page.replace('__MODE__', MODERATO ? 'moderato' : 'demo').replace('__SCHEMA__', JSON.stringify(typeDefs.replace(fareDirectiveTypeDefs, '').trim())))
    return
  }
  if (url.pathname === '/demo/run' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    try {
      const { query, variables, pay } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const result = await walk(String(query ?? ''), variables ?? {}, Boolean(pay))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (e as Error).message }))
    }
    return
  }
  return yoga(req, res)
})

server.listen(PORT, () => {
  console.log(`FareQL playground on http://localhost:${PORT}  (${MODERATO ? 'Moderato testnet' : 'demo payments, no money'})`)
  console.log(`GraphQL endpoint:     http://localhost:${PORT}/graphql`)
})
