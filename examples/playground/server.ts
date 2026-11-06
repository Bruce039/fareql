// FareQL playground on Node: a priced GraphQL API plus a page that walks through the MPP flow.
//
//   npx tsx examples/playground/server.ts              # demo mode: settlement-free test method, no money
//   MPP_SECRET_KEY=$(openssl rand -hex 32) RECIPIENT=0x... npx tsx examples/playground/server.ts
//                                                     # Moderato mode: real Tempo testnet Challenges
//
// Then open http://localhost:4000. The same app runs on Cloudflare Workers (worker.ts).
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServerAdapter } from '@whatwg-node/server'
import { createPlayground } from './app.js'

const PORT = Number(process.env.PORT ?? 4000)
const handle = createPlayground({
  page: readFileSync(new URL('./index.html', import.meta.url), 'utf8'),
  recipient: process.env.RECIPIENT,
  secretKey: process.env.MPP_SECRET_KEY,
})

createServer(createServerAdapter(handle)).listen(PORT, () => {
  const mode = process.env.RECIPIENT && process.env.MPP_SECRET_KEY ? 'Moderato testnet' : 'demo payments, no money'
  console.log(`FareQL playground on http://localhost:${PORT}  (${mode})`)
  console.log(`GraphQL endpoint:     http://localhost:${PORT}/graphql`)
})
