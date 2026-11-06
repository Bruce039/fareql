import { buildSchema } from 'graphql'
import { type ChargeFactory, fareDirectiveTypeDefs } from '../src/index.js'

export const typeDefs = /* GraphQL */ `
  ${fareDirectiveTypeDefs}
  type Query {
    hello: String
    weather(city: String!): Forecast @price(amount: "0.001")
    search(query: String!, first: Int = 5): [Hit!]! @price(amount: "0.0005")
    node(id: ID!): Node
    entity(id: ID!): Entity
    item(id: ID!): Item
    expensive: Report
    users(first: Int, after: String): UserConnection!
    repos(first: Int, last: Int): RepoConnection! @listSize(slicingArguments: ["first", "last"], sizedFields: ["edges"])
    tags: [String!]! @listSize(assumedSize: 3)
    ids: [ID!]! @price(amount: "0.000001")
  }
  type Mutation {
    generateImage(prompt: String!): String @price(amount: "0.05")
    upload(file: Upload!): String @price(amount: "0.01")
  }
  scalar Upload
  type Forecast {
    temperature: Float
    hourly(limit: Int): [Hour!]!
  }
  type Hour {
    t: Int
    detail: String @price(amount: "0.0001")
  }
  type Hit {
    title: String
    snippet: String @price(amount: "0.0002")
  }
  interface Node {
    id: ID!
  }
  type Cheap implements Node {
    id: ID!
    name: String @price(amount: "0.002")
  }
  type Pricey implements Node {
    id: ID!
    secret: String @price(amount: "0.01")
  }
  type Report implements Node @price(amount: "0.02") {
    id: ID!
    pages: Int
  }
  union Entity = Cheap | Pricey | Report
  union Item = Cheap | Pricey
  type UserConnection {
    edges: [UserEdge!]!
    nodes: [User!]!
    pageInfo: PageInfo!
  }
  type UserEdge {
    node: User!
  }
  type User {
    name: String
    email: String @price(amount: "0.001")
  }
  type PageInfo {
    hasNextPage: Boolean
  }
  type RepoConnection {
    edges: [RepoEdge!]!
  }
  type RepoEdge {
    node: Repo!
  }
  type Repo {
    stars: Int @price(amount: "0.0001")
  }
`

export const schema = buildSchema(typeDefs)

export const resolvers = {
  Query: {
    hello: () => 'hi',
    weather: () => ({ temperature: 21.5, hourly: [] }),
    search: () => [{ title: 't', snippet: 's' }],
    expensive: () => ({ id: 'r', pages: 3 }),
  },
  Mutation: { generateImage: () => 'https://img', upload: () => 'stored' },
}

export type ChargeLog = { amount: string; scope: string; description?: string }[]

/**
 * In-memory stand-in for an mppx charge handler. A request "pays" by sending
 * `Authorization: Payment <amount>|<scope>`; anything else gets a 402 Challenge
 * echoing the amount and scope, like mppx does in WWW-Authenticate.
 */
export function fakeCharge(log: ChargeLog = []): ChargeFactory {
  return (opts) => async (request) => {
    log.push(opts)
    const auth = request.headers.get('authorization') ?? ''
    if (auth === `Payment ${opts.amount}|${opts.scope}`) {
      return {
        status: 200,
        withReceipt: (response: Response) => {
          const headers = new Headers(response.headers)
          headers.set('Payment-Receipt', `ok;amount=${opts.amount}`)
          return new Response(response.body, { status: response.status, headers })
        },
      }
    }
    return {
      status: 402,
      challenge: new Response(JSON.stringify({ type: 'https://paymentauth.org/problems/payment-required', status: 402 }), {
        status: 402,
        headers: {
          'WWW-Authenticate': `Payment amount="${opts.amount}", scope="${opts.scope}"`,
          'Content-Type': 'application/problem+json',
          'Cache-Control': 'no-store',
        },
      }),
    }
  }
}

export function challengeOf(response: Response) {
  const h = response.headers.get('www-authenticate') ?? ''
  return { amount: /amount="([^"]+)"/.exec(h)?.[1], scope: /scope="([^"]+)"/.exec(h)?.[1] }
}

export const payFor = (c: { amount?: string; scope?: string }) => ({ authorization: `Payment ${c.amount}|${c.scope}` })

export function gql(query: string, variables?: Record<string, unknown>, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify({ query, variables, ...extra }),
  })
}
