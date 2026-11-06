// Smoke test of the built package in plain Node (no test runner, no bundler):
// a real HTTP server with GraphQL Yoga + FareQL + mppx's Tempo method, and Apollo when available.
//   npm run build && node scripts/smoke.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createSchema, createYoga } from 'graphql-yoga'
import { Mppx, tempo } from 'mppx/server'
import { fareDirectiveTypeDefs, withPayment } from 'fareql'
import { useFareql } from 'fareql/yoga'

const typeDefs = /* GraphQL */ `
  ${fareDirectiveTypeDefs}
  type Query {
    hello: String
    search(query: String!, first: Int = 5): [Hit!]! @price(amount: "0.0005")
  }
  type Hit {
    title: String
    snippet: String @price(amount: "0.0002")
  }
`
const resolvers = { Query: { hello: () => 'hi', search: () => [] } }
const payment = Mppx.create({
  methods: [tempo.charge({ currency: '0x20c0000000000000000000000000000000000001', recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', testnet: true })],
  secretKey: 'smoke-test-secret-key-000000000000000000',
  realm: 'smoke.local',
})
const charge = (o) => payment.charge(o)
const amountOf = (res) => JSON.parse(Buffer.from(/request="([^"]+)"/.exec(res.headers.get('www-authenticate'))[1], 'base64url')).amount
const post = (query) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query }) })

const yoga = createYoga({ schema: createSchema({ typeDefs, resolvers }), plugins: [useFareql({ charge })] })
const server = createServer(yoga)
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/graphql`
try {
  const free = await fetch(url, post('{ hello }'))
  assert.equal(free.status, 200)
  assert.equal((await free.json()).data.hello, 'hi')

  const priced = await fetch(url, post('{ search(query: "x", first: 2) { snippet } }'))
  assert.equal(priced.status, 402)
  assert.equal(amountOf(priced), '1400')
  assert.equal((await priced.json()).errors[0].extensions.price.amount, '0.0014')
  console.log('yoga over HTTP: ok')
} finally {
  server.close()
}

const handler = withPayment((req) => yoga.fetch(req), { schema: yoga.getEnveloped().schema, charge })
const wrapped = await handler(new Request('http://smoke.local/graphql', post('{ search(query: "x") { title } }')))
assert.equal(wrapped.status, 402)
assert.equal(amountOf(wrapped), '2500')
console.log('withPayment: ok')

let apollo
try {
  apollo = await import('@apollo/server')
} catch {
  console.log('apollo: skipped (not installed)')
}
if (apollo && Number((await import('graphql')).version.split('.')[0]) < 17) {
  const { fareqlApolloPlugin } = await import('fareql/apollo')
  const server = new apollo.ApolloServer({ typeDefs, resolvers, plugins: [fareqlApolloPlugin({ charge })] })
  await server.start()
  const r = await server.executeHTTPGraphQLRequest({
    httpGraphQLRequest: { method: 'POST', headers: new apollo.HeaderMap([['content-type', 'application/json']]), search: '', body: { query: '{ search(query: "x", first: 2) { snippet } }' } },
    context: async () => ({}),
  })
  assert.equal(r.status, 402)
  assert.equal(amountOf({ headers: r.headers }), '1400')
  console.log('apollo: ok')
}
console.log(`smoke passed with graphql ${(await import('graphql')).version}`)
