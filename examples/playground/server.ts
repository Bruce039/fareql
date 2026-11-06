// FareQL playground on Node: a priced GraphQL API plus a page that walks through the MPP flow.
//
//   npx tsx examples/playground/server.ts              # demo mode: settlement-free test method, no money
//   MPP_SECRET_KEY=$(openssl rand -hex 32) RECIPIENT=0x... npx tsx examples/playground/server.ts
//                                                     # real payments on Tempo mainnet (USDC.e)
//   TEMPO_NETWORK=testnet MPP_SECRET_KEY=... RECIPIENT=0x... npx tsx examples/playground/server.ts
//                                                     # real payments on the Moderato testnet
//
// Then open http://localhost:4000. The same app runs on Cloudflare Workers (worker.ts).
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServerAdapter } from '@whatwg-node/server'
import { createPlayground } from './app.js'

const PORT = Number(process.env.PORT ?? 4000)
if (process.env.RECIPIENT && !/^0x[0-9a-fA-F]{40}$/.test(process.env.RECIPIENT)) {
  console.error('RECIPIENT must be a 0x address (40 hex characters).')
  process.exit(1)
}
const handle = createPlayground({
  page: readFileSync(new URL('./index.html', import.meta.url), 'utf8'),
  recipient: process.env.RECIPIENT,
  secretKey: process.env.MPP_SECRET_KEY,
  network: process.env.TEMPO_NETWORK === 'testnet' ? 'testnet' : 'mainnet',
})

createServer(createServerAdapter(handle)).listen(PORT, () => {
  const real = process.env.RECIPIENT && process.env.MPP_SECRET_KEY
  const mode = !real ? 'demo payments, no money' : process.env.TEMPO_NETWORK === 'testnet' ? 'Moderato testnet' : 'Tempo MAINNET, real money'
  console.log(`FareQL playground on http://localhost:${PORT}  (${mode})`)
  console.log(`GraphQL endpoint:     http://localhost:${PORT}/graphql`)
})
