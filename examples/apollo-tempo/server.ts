// The same priced API on Apollo Server 5 (standalone), on Tempo (mainnet by default, TEMPO_NETWORK=testnet for Moderato).
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

const testnet = process.env.TEMPO_NETWORK === 'testnet'
if (!/^0x[0-9a-fA-F]{40}$/.test(process.env.RECIPIENT ?? '') || !process.env.MPP_SECRET_KEY) {
  console.error('Set RECIPIENT (the 0x address that receives payments) and MPP_SECRET_KEY (e.g. `openssl rand -hex 32`).')
  process.exit(1)
}
console.log(`Charging on ${testnet ? 'the Moderato testnet (pathUSD)' : 'Tempo MAINNET (USDC.e, real money)'} to ${process.env.RECIPIENT}`)

const mppx = Mppx.create({
  methods: [
    tempo.charge({
      ...(testnet
        ? { currency: '0x20c0000000000000000000000000000000000001', testnet: true } // pathUSD on Moderato
        : { currency: '0x20C000000000000000000000b9537d11c60E8b50' }), // USDC.e on Tempo mainnet
      recipient: process.env.RECIPIENT as `0x${string}`,
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
