// A priced GraphQL API on Tempo (mainnet by default, TEMPO_NETWORK=testnet for Moderato), served by GraphQL Yoga.
//
//   MPP_SECRET_KEY=$(openssl rand -hex 32) RECIPIENT=0x... npx tsx examples/yoga-tempo/server.ts
//
// Pay for a query with the mppx CLI (add --network testnet with TEMPO_NETWORK=testnet):
//   npx mppx account create && npx mppx account fund
//   npx mppx http://localhost:4000/graphql -X POST -H 'content-type: application/json' \
//     -d '{"query":"{ search(query: \"tempo\", first: 3) { title snippet } }"}'
import { createServer } from 'node:http'
import { createSchema, createYoga } from 'graphql-yoga'
import { Mppx, tempo } from 'mppx/server'
import { fareDirectiveTypeDefs } from 'fareql'
import { useFareql } from 'fareql/yoga'

const typeDefs = /* GraphQL */ `
  ${fareDirectiveTypeDefs}
  type Query {
    hello: String
    weather(city: String!): Forecast @price(amount: "0.001")
    search(query: String!, first: Int = 5): [Hit!]! @price(amount: "0.0005")
  }
  type Forecast {
    temperature: Float
  }
  type Hit {
    title: String
    snippet: String @price(amount: "0.0002")
  }
`

const resolvers = {
  Query: {
    hello: () => 'free',
    weather: (_: unknown, { city }: { city: string }) => ({ temperature: city.length * 3.5 }),
    search: (_: unknown, { query, first }: { query: string; first: number }) =>
      Array.from({ length: first }, (_, i) => ({ title: `${query} #${i + 1}`, snippet: `Result ${i + 1} for ${query}` })),
  },
}

const mppx = Mppx.create({
  methods: [
    tempo.charge({
      ...(process.env.TEMPO_NETWORK === 'testnet'
        ? { currency: '0x20c0000000000000000000000000000000000001', testnet: true } // pathUSD on Moderato
        : { currency: '0x20C000000000000000000000b9537d11c60E8b50' }), // USDC.e on Tempo mainnet
      recipient: process.env.RECIPIENT as `0x${string}`,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
})

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  plugins: [useFareql({ charge: (o) => mppx.charge(o), pricing: { maxPrice: '1' } })],
})

createServer(yoga).listen(4000, () => console.log('priced GraphQL on http://localhost:4000/graphql'))
