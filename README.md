<h1 align="center">FareQL</h1>

<p align="center">
  <b>Every GraphQL query pays its own fare.</b><br>
  Price each operation by what it selects and charge for it over <a href="https://mpp.dev">MPP</a> (HTTP 402).
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/fareql"><img src="https://img.shields.io/npm/v/fareql?color=ffcb3d&labelColor=24211b" alt="npm"></a>
  <a href="https://github.com/Bruce039/fareql/actions/workflows/ci.yml"><img src="https://github.com/Bruce039/fareql/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/Bruce039/fareql/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/fareql?color=1f9d74&labelColor=24211b" alt="license"></a>
  <img src="https://img.shields.io/badge/graphql-16%20%7C%2017-e535ab?labelColor=24211b" alt="graphql 16 | 17">
</p>

<p align="center">
  <a href="https://fareql.pages.dev"><b>Live demo</b></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#pricing-rules">Pricing rules</a> ·
  <a href="#security-model">Security</a>
</p>

> **Try it in the browser at [fareql.pages.dev](https://fareql.pages.dev).** Type a query and the meter quotes it live. Pay with a demo method and you get the data and a receipt. No money moves.
> Shortcuts: [pay for a search](https://fareql.pages.dev/#ride=2&pay) · [slide a page size](https://fareql.pages.dev/#ride=7) · [try to ride for free](https://fareql.pages.dev/#dodge=0)

## Why FareQL

A GraphQL API is one endpoint, so a flat price per route doesn't fit it: `{ hello }` and `{ users(first: 100) { edges { node { email } } } }` hit the same URL. FareQL works out the fare of every operation from your schema and charges it through [`mppx`](https://github.com/wevm/mppx) with Tempo, Stripe or any other MPP method. Clients (apps, scripts, AI agents) pay per question. They don't need an account, an API key or a plan, and the money goes straight to your address.

| | |
|---|---|
| **Schema-driven prices** | `@price(amount: "0.001")` on fields and types, multiplied through lists, Relay connections and `@listSize` |
| **One Challenge per operation** | Bound to the exact document and variables. A Credential for a cheap query can't pay for an expensive one |
| **Charged after validation** | Persisted queries and depth limits run first, so nobody pays for an operation the server refuses |
| **Fails closed** | If FareQL can't read or price an operation, the operation doesn't run |
| **Red-teamed** | About 100 attack tests: parser differentials, cache bypasses, fragment bombs, scope collisions |
| **Works where you are** | GraphQL Yoga, Apollo Server 4/5 and any Fetch handler (Hono, Next.js, Workers), on graphql 16 and 17 |

## Quick start

```bash
npm install fareql mppx graphql
```

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

## How it works

1. **You price your schema.** Put `@price(amount: "0.001")` on whatever costs money.
2. **A client asks.** FareQL prices the operation from what it selects. Free operations run as usual.
3. **It gets a quote.** A priced operation answers `402 Payment Required` with an MPP Challenge for that exact operation, plus the price and its breakdown.
4. **It pays and asks again.** The client (an app, the `mppx` CLI, an AI agent) pays, for example in stablecoins on Tempo, and resends the query with the Credential.
5. **It gets the answer.** FareQL verifies the Credential through mppx, runs the operation and returns the data with a `Payment-Receipt`.

## Use it with your server

### GraphQL Yoga

Shown in [Quick start](#quick-start). Register `useFareql` after plugins that change what runs (APQ, persisted operations, validation rules). It hooks into execution, so it always prices the final document. A backstop before each response charges results that never reached execution, so a response cache or a plugin that short-circuits can't serve a priced result for free.

Yoga-only options:
- `getRequest(context)` supplies the HTTP request for transports that have none, such as graphql-ws. Without it, priced operations over those transports are refused.
- `maxSubscriptionEvents` (default 100) is how many events one payment buys on a priced subscription.

### Apollo Server

```ts
import { ApolloServer } from '@apollo/server'
import { fareqlApolloPlugin } from 'fareql/apollo'

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [fareqlApolloPlugin({ charge: (o) => mppx.charge(o) })],
})
```

The plugin charges in `didResolveOperation`. By then Apollo has parsed, validated and resolved the operation (APQ included), and its response cache hasn't answered yet. In an HTTP batch only one priced operation can be paid. Operations run in-process with `server.executeOperation()` have no HTTP request and are not charged.

### Any Fetch handler (Hono, Next.js, graphql-http, Cloudflare Workers)

```ts
import { withPayment } from 'fareql'

export const POST = withPayment((req) => handler(req), { schema, charge: (o) => mppx.charge(o) })
```

`withPayment` reads the request itself, so it refuses anything the wrapped handler could read differently:

- It accepts GET and `application/json` POST by default. Enable `application/graphql`, `application/graphql+json`, form-urlencoded or multipart uploads with `encodings: [...]`, but only if your handler accepts them too.
- It refuses the following with a 4xx before anything is charged:
  - URL fragments, duplicate or unknown parameters, and GraphQL parameters in a POST URL;
  - non-object `variables`, and `query` sent together with `documentId`;
  - bodies on other methods, and mutations over GET.
- `maxBodyBytes` (1 MB), `maxQueryLength` (100 000), `maxTokens` (15 000) and `maxBatchSize` (10) bound the work.
- `validationRules` adds your server's extra rules, so operations they would reject are refused before payment.
- APQ works without a hash store in the gate: a hash-only request gets `PersistedQueryNotFound` and the full query the client resends is priced, so nobody pays for a hash the handler doesn't know. To price hashes or trusted documents (`documentId`) from your own store, pass `resolveDocument`.
- Batches are refused unless you set `batching: true`. With it, the whole batch is charged in one payment and `maxPrice` applies to the total.

For full control, `createPaymentGate(options)(request)` returns one of `free`, `payment-required`, `paid` or `rejected`.

## Pricing rules

| Rule | Behaviour |
|---|---|
| Field `@price` | Charged once per resolved instance of the field |
| Type `@price` | Applies to every field returning that type, unless the field has its own |
| Field selected several times | Charged once per response key, as the executor resolves it |
| Lists | Children × list size from `first`, `last`, `limit`, `take`, `top`, `pageSize` or `perPage` (also inside an input object, e.g. `page: { limit }`), otherwise `defaultListSize` (10). Capped at `maxListSize` (100). `null` or unbounded counts as `maxListSize`; negative sizes are refused |
| Nested lists | `[[Cell]]`: each inner level multiplies by `defaultListSize` |
| Connections and page wrappers | A non-list field given a size (`users(first: 50)`) passes it to the lists it selects (`edges`, `nodes`, `items`…). Restrict with `connections: { sizedFields }`, or turn it off with `false` |
| `@listSize` | As in the IBM GraphQL Cost Directives draft: `slicingArguments`, `sizedFields`, `assumedSize`, `requireOneSlicingArgument` |
| Interfaces and unions | Every possible runtime type is priced and the most expensive one is charged. A `@price` on an interface field or type applies to its implementations |
| Code-first schemas | `extensions: { price: '0.001' }` or `extensions: { directives: { price: { amount: '0.001' } } }` |
| Fragments, `@skip`, `@include` | Followed and evaluated with the request variables |
| `__typename`, introspection | Free |
| `maxPrice` | Operations above it get `PRICE_LIMIT_EXCEEDED` before any Challenge |
| `maxFieldVisits`, `maxDepth` | Operations too complex to price get `TOO_COMPLEX` (10 000 selections, 100 levels) |
| No price anywhere | A schema with no `@price` at all (e.g. one that lost its directives) is refused with `NO_PRICES` instead of making everything free |

Other options:
- `decimals` (default 6) must match your payment method's token.
- `defaultFieldPrice`, `listSizeArguments`, `connections`.
- `fieldPrice(ctx)` prices fields in code.

`priceOperation()` is exported for quotes and tests.

## What clients get

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="…", realm="api.example.com", method="tempo", intent="charge", request="…"
Content-Type: application/json; charset=utf-8

{
  "errors": [{
    "message": "Payment required: this operation costs 0.0014",
    "extensions": {
      "code": "PAYMENT_REQUIRED",
      "price": {
        "amount": "0.0014",
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

In code, `mppx/client` wraps `fetch`, so 402s are paid and retried automatically. The paid response carries a `Payment-Receipt` and `Cache-Control: private`, so shared caches never store paid content. Set `exposePrice: false` to keep prices out of error bodies.

## Security model

- **Binding.** Each Challenge's `scope` is a hash of the printed document, the operation name and the declared variables. mppx keeps it in the HMAC-protected Challenge and refuses a Credential whose scope differs.
- **Price what runs.** Yoga and Apollo charge after the server's own parsing, validation and persisted-document lookup. `withPayment` refuses requests a handler could parse differently.
- **Fail closed.** Unreadable, unpriceable, over-limit or ambiguous requests are answered with an error and never run.
- **Bounded work.** Pricing is linear in the document, like graphql-js field collection. Token, length, depth, body and batch limits keep it cheap.
- **Tested by attack.** [`test/attacks-*.test.ts`](https://github.com/Bruce039/fareql/tree/main/test) hold the red-team suites. Each test asserts the secure behaviour.

## Reference

<details>
<summary><b>Shared options</b></summary>

| Option | |
|---|---|
| `charge` | `(o) => mppx.charge(o)`, or `(o) => mppx.tempo.charge(o)` when several methods are configured. Receives `{ amount, scope, description }` |
| `pricing` | See [Pricing rules](#pricing-rules) |
| `describe(op, price)` | Challenge description. Default: `GraphQL <operation name>` |
| `exposePrice` | Include the price breakdown in 402 bodies. Default: `true` |

</details>

<details>
<summary><b>Notes and limits</b></summary>

- Payment settles before execution, so a resolver error after payment is not refunded. Keep priced resolvers reliable.
- Subscriptions are charged once, when they start, for up to `maxSubscriptionEvents` events. Metered streams over MPP sessions are planned.
- Set `maxListSize` to your server's real page cap. If the server returns more items than `maxListSize`, the client is under-charged, because larger requested sizes are clamped.
- In production, give `tempo.charge()` a shared `store` so a Credential can't be replayed across instances.

</details>

## Examples

- [`examples/playground`](https://github.com/Bruce039/fareql/tree/main/examples/playground): the [live demo](https://fareql.pages.dev). Run it locally with `npx tsx examples/playground/server.ts`; set `RECIPIENT` and `MPP_SECRET_KEY` for real Moderato testnet Challenges.
- [`examples/yoga-tempo`](https://github.com/Bruce039/fareql/blob/main/examples/yoga-tempo/server.ts): a minimal GraphQL Yoga server on Moderato.
- [`examples/apollo-tempo`](https://github.com/Bruce039/fareql/blob/main/examples/apollo-tempo/server.ts): Apollo Server with a priced Relay-style connection.

## Development

```bash
npm test                                  # pricing, gate, Yoga, Apollo, attacks, real mppx loops
npm run build && node scripts/smoke.mjs   # the built package over real HTTP in plain Node
```

## License

MIT
