# FareQL

[![npm](https://img.shields.io/npm/v/fareql)](https://www.npmjs.com/package/fareql)
[![ci](https://github.com/Bruce039/fareql/actions/workflows/ci.yml/badge.svg)](https://github.com/Bruce039/fareql/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/fareql)](https://github.com/Bruce039/fareql/blob/main/LICENSE)

Charge for GraphQL operations over [MPP](https://mpp.dev) (HTTP 402), priced by what each operation selects.

**[Try the live playground →](https://fareql.pages.dev)** (demo payments, no money moves)

A GraphQL API is one endpoint, so a flat price per route doesn't fit it: `{ hello }` and `{ users(first: 100) { edges { node { email } } } }` hit the same URL. FareQL works out the fare of every operation from your schema and charges it through [`mppx`](https://github.com/wevm/mppx) with Tempo, Stripe or any other MPP method.

- **Schema-driven prices.** `@price(amount: "0.001")` on fields and types, multiplied through lists, Relay connections and `@listSize`.
- **One Challenge per operation**, bound to the exact document and variables. A Credential paid for a cheap query can't be replayed on an expensive one; mppx enforces this through the Challenge's HMAC.
- **Charged after validation, right before execution.** Persisted queries and depth limits are already applied when FareQL charges, so nobody pays for an operation the server then refuses.
- **Fails closed.** If FareQL can't read or price an operation, the operation doesn't run.
- **Ready for GraphQL clients.** The 402 keeps mppx's `WWW-Authenticate` Challenge and adds a GraphQL `errors` entry with the price and its breakdown.
- Works with **GraphQL Yoga**, **Apollo Server 4/5** and **any Fetch-API handler**, on graphql 16 and 17.

```bash
npm install fareql mppx graphql
```

## How it works

1. You mark what costs money in your schema: `@price(amount: "0.001")`.
2. A client sends a query. FareQL prices it from what it selects. Free operations run as usual.
3. A priced operation gets `402 Payment Required` with an MPP Challenge for that exact operation, plus the price and its breakdown.
4. The client (an app, the `mppx` CLI, an AI agent) pays, for example in stablecoins on Tempo, and resends the query with the Credential. FareQL verifies it through mppx, runs the operation, and returns the data with a `Payment-Receipt`.

Payments go straight to your own address. There is no account, API key or subscription for the client to set up.

## GraphQL Yoga

```ts
import { createSchema, createYoga } from 'graphql-yoga'
import { Mppx, tempo } from 'mppx/server'
import { fareDirectiveTypeDefs } from 'fareql'
import { useFareql } from 'fareql/yoga'

const mppx = Mppx.create({
  methods: [tempo.charge({ currency: '0x…' /* TIP-20 token */, recipient: '0x…' })],
})

const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      ${fareDirectiveTypeDefs}
      type Query {
        hello: String
        weather(city: String!): Forecast @price(amount: "0.001")
        search(query: String!, first: Int = 5): [Hit!]! @price(amount: "0.0005")
      }
      type Forecast { temperature: Float }
      type Hit { title: String, snippet: String @price(amount: "0.0002") }
    `,
    resolvers,
  }),
  plugins: [useFareql({ charge: (o) => mppx.charge(o), pricing: { maxPrice: '1' } })],
})
```

`{ hello }` is free. `{ search(query: "mpp", first: 2) { snippet } }` costs `2 × (0.0005 + 0.0002) = 0.0014`.

Register `useFareql` after plugins that change what runs (APQ, persisted operations, validation rules). It hooks into execution, so it always prices the final document. A backstop before each response charges results that never reached execution, so a response cache (`useResponseCache`) or a plugin that short-circuits cannot serve a priced result for free.

Yoga-only options: `getRequest(context)` supplies the HTTP request for transports that have none (graphql-ws); without it, priced operations over such transports are refused. `maxSubscriptionEvents` (default 100) is how many events one payment buys on a priced subscription; the stream then ends with `PAYMENT_EXHAUSTED`.

## Apollo Server

```ts
import { ApolloServer } from '@apollo/server'
import { fareqlApolloPlugin } from 'fareql/apollo'

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [fareqlApolloPlugin({ charge: (o) => mppx.charge(o) })],
})
```

The plugin charges in `didResolveOperation`, after Apollo has parsed, validated and resolved the operation, APQ included, and before Apollo's response cache can answer. In an HTTP batch only one priced operation can be paid. Operations you run in-process with `server.executeOperation()` have no HTTP request and are not charged.

## Any Fetch handler (Hono, Next.js, graphql-http, Cloudflare Workers)

```ts
import { withPayment } from 'fareql'

export const POST = withPayment((req) => handler(req), { schema, charge: (o) => mppx.charge(o) })
```

`withPayment` reads the request itself, so it is strict about anything the wrapped handler could read differently:

- It accepts GET and `application/json` POST by default. Enable `application/graphql`, `application/graphql+json`, form-urlencoded or multipart uploads with `encodings: [...]`, and only if your handler accepts them, so a client is never charged for a body the handler then refuses.
- It refuses the following with 4xx before anything is charged:
  - URL fragments (`#`), duplicate or unknown parameters, and GraphQL parameters in the URL of a POST;
  - non-object `variables`, and `query` sent together with `documentId`;
  - bodies on other methods, and mutations over GET.
- `maxBodyBytes` (default 1 MB), `maxQueryLength` (100 000), `maxTokens` (15 000) and `maxBatchSize` (10) bound the work.
- `validationRules` adds your server's extra rules (depth limits and so on), so operations they reject are refused before payment.
- It speaks APQ: a hash it hasn't seen gets `PersistedQueryNotFound`, the client resends the full query, and that query is priced. For trusted documents (`documentId`), pass `resolveDocument`.
- Batches are refused unless you set `batching: true`; then the whole batch is charged in one payment, and `maxPrice` applies to the total.

For full control, `createPaymentGate(options)(request)` returns `free`, `payment-required` (with the 402 `response`), `paid` (with `withReceipt`) or `rejected` (with the response to send).

## Pricing rules

| Rule | Behaviour |
|---|---|
| Field `@price` | Charged once per resolved instance of the field |
| Type `@price` | Applies to every field returning that type, unless the field has its own |
| Field selected several times | Charged once per response key, as the executor resolves it (fragments merged, repeated spreads ignored) |
| Lists | Children × list size, read from `first`, `last`, `limit`, `take`, `top`, `pageSize` or `perPage` (also one level inside an input object, e.g. `page: { limit }`); otherwise `defaultListSize` (10). Capped at `maxListSize` (100). `null` or an unbounded number counts as `maxListSize`; a negative size is refused (`INVALID_LIST_SIZE`) |
| Nested lists | `[[Cell]]`: each inner level multiplies by `defaultListSize` |
| Connections and page wrappers | A non-list field given a size (`users(first: 50)`) passes it to the lists it selects (`edges`, `nodes`, `items`…). Restrict with `connections: { sizedFields }` or turn off with `false` |
| `@listSize` | As in the IBM GraphQL Cost Directives draft: `slicingArguments`, `sizedFields`, `assumedSize`, `requireOneSlicingArgument` (default true) |
| Interfaces and unions | Each possible runtime type is priced and the most expensive one is charged. Branches are never added together. `@price` on an interface field or interface type applies to the types implementing it |
| Code-first schemas | `extensions: { price: '0.001' }` or `extensions: { directives: { price: { amount: '0.001' } } }` work like the directive |
| Fragments, `@skip`, `@include` | Followed and evaluated with the request variables |
| `__typename`, introspection | Free |
| `maxPrice` | Operations above it get `PRICE_LIMIT_EXCEEDED` before any Challenge is issued |
| `maxFieldVisits`, `maxDepth` | Operations too complex to price get `TOO_COMPLEX` (defaults 10 000 selections, 100 levels) |
| No price anywhere | A schema without any `@price` (lost directives, an introspection copy) is refused with `NO_PRICES` instead of making everything free |

Other options: `decimals` (default 6, which must match your payment method's token), `defaultFieldPrice`, `listSizeArguments`, `connections` (`false` or `{ sizedFields }`), and `fieldPrice(ctx)` to price fields in code. `priceOperation()` is exported for quotes and tests. The breakdown lists at most 100 items (`breakdownTruncated: true` when there are more).

## What clients get

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="…", realm="api.example.com", method="tempo", intent="charge", request="…"
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{
  "errors": [{
    "message": "Payment required: this operation costs 0.0014",
    "extensions": {
      "code": "PAYMENT_REQUIRED",
      "price": {
        "amount": "0.0014",
        "decimals": 6,
        "breakdown": [
          { "path": "search", "unitAmount": "0.0005", "count": "2", "amount": "0.001" },
          { "path": "search.snippet", "unitAmount": "0.0002", "count": "2", "amount": "0.0004" }
        ]
      }
    }
  }]
}
```

Clients need nothing from FareQL, only an MPP client. With the mppx CLI and a Tempo testnet wallet:

```bash
npx mppx account create && npx mppx account fund
npx mppx https://api.example.com/graphql -X POST -H 'content-type: application/json' \
  -d '{"query":"{ search(query: \"mpp\", first: 2) { snippet } }"}'
```

In code, `mppx/client` wraps `fetch` so 402s are paid and retried automatically, and MPP-aware agents do the same. The paid response carries `Payment-Receipt` and `Cache-Control: private` (or `private, no-store`), so no shared cache or CDN stores paid content. Set `exposePrice: false` to leave the price out of every error body.

## Security model

- **Binding.** Each Challenge's `scope` is a hash of the printed document, the operation name and the declared variables. mppx keeps it in the HMAC-protected Challenge and refuses a Credential whose scope differs. A payment for one operation never unlocks another.
- **Price what runs.** Yoga and Apollo are charged after the server's own parsing, validation and persisted-document lookup. `withPayment` refuses requests a handler could parse differently.
- **Fail closed.** Unreadable, unpriceable, over-limit or ambiguous requests are answered with an error and never executed. Batches can't hold more than one paid operation per Credential.
- **Bounded work.** Pricing is linear in the document, like graphql-js field collection. Token, length, depth, selection, body and batch limits keep it cheap.
- **Tested by attack.** [`test/attacks-*.test.ts`](https://github.com/Bruce039/fareql/tree/main/test) hold the red-team suites: pricing tricks, parser differentials, cache and plugin-order bypasses, scope collisions and DoS. Each test asserts the secure behaviour.

## Shared options

| Option | |
|---|---|
| `charge` | `(o) => mppx.charge(o)`, or `(o) => mppx.tempo.charge(o)` when several methods are configured. Receives `{ amount, scope, description }` |
| `pricing` | See [Pricing rules](#pricing-rules) |
| `describe(op, price)` | Challenge description. Default: `GraphQL <operation name>` |
| `exposePrice` | Include the price breakdown in 402 bodies. Default: `true` |

## Notes

- Payment settles before execution, so a resolver error after payment is not refunded. Keep priced resolvers reliable, or price them lower.
- Subscriptions are charged once, when they start, for up to `maxSubscriptionEvents` events. Metered streams over MPP sessions are planned.
- Set `maxListSize` to your server's real page cap. A larger requested size is clamped, so a server that returns more items than `maxListSize` is under-charged.
- With Yoga, priced operations can't share a batch, because one request carries one Credential. Free operations in a batch work as usual.
- In production, give `tempo.charge()` a shared `store` so a Credential can't be replayed across instances. This is an mppx setting.

## Examples

- [`examples/yoga-tempo`](https://github.com/Bruce039/fareql/blob/main/examples/yoga-tempo/server.ts): GraphQL Yoga on Tempo's Moderato testnet
- [`examples/apollo-tempo`](https://github.com/Bruce039/fareql/blob/main/examples/apollo-tempo/server.ts): Apollo Server with a priced Relay-style connection
- [`examples/playground`](https://github.com/Bruce039/fareql/blob/main/examples/playground/app.ts) ([live demo](https://fareql.pages.dev)): a page that walks through quote → Challenge → Credential → Receipt. It uses a settlement-free demo method by default (`npx tsx examples/playground/server.ts`, then open http://localhost:4000), and real Moderato Challenges when `RECIPIENT` and `MPP_SECRET_KEY` are set

```bash
MPP_SECRET_KEY=$(openssl rand -hex 32) RECIPIENT=0x… npx tsx examples/yoga-tempo/server.ts
npx mppx account create && npx mppx account fund
npx mppx http://localhost:4000/graphql -X POST -H 'content-type: application/json' \
  -d '{"query":"{ search(query: \"tempo\", first: 3) { title snippet } }"}'
```

## Development

```bash
npm test          # vitest: pricing, gate, Yoga, Apollo, and real mppx client ↔ server loops
npm run build && node scripts/smoke.mjs   # the built package over real HTTP in plain Node
```

## License

MIT
