// The same priced API on Apollo Server 5 (standalone), Moderato testnet.
//
//   MPP_SECRET_KEY=$(openssl rand -hex 32) RECIPIENT=0x... npx tsx examples/apollo-tempo/server.ts
import { ApolloServer } from '@apollo/server'
import { startStandaloneServer } from '@apollo/server/standalone'
import { Mppx, tempo } from 'mppx/server'
import { fareDirectiveTypeDefs } from 'fareql'
import { fareqlApolloPlugin } from 'fareql/apollo'

const typeDefs = /* GraphQL */ `
  ${fareDirectiveTypeDefs}
  type Query {
    hello: String
    users(first: Int!): UserConnection!
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
`

const resolvers = {
  Query: {
    hello: () => 'free',
    users: (_: unknown, { first }: { first: number }) => ({
      edges: Array.from({ length: Math.min(first, 100) }, (_, i) => ({ node: { name: `user ${i}`, email: `user${i}@example.com` } })),
    }),
  },
}

const mppx = Mppx.create({
  methods: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000001', // pathUSD on Moderato
      recipient: process.env.RECIPIENT as `0x${string}`,
      testnet: true,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
})

const server = new ApolloServer({
  typeDefs,
  resolvers,
  // `{ users(first: 20) { edges { node { email } } } }` costs 20 × 0.001 = 0.02
  plugins: [fareqlApolloPlugin({ charge: (o) => mppx.charge(o), pricing: { maxPrice: '1' } })],
})

const { url } = await startStandaloneServer(server, { listen: { port: 4000 } })
console.log(`priced GraphQL on ${url}`)
