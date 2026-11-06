// FareQL playground on Cloudflare (demo payments only, no money moves), served as a Pages
// project with this file as its `_worker.js`:
//   cd examples/playground
//   npx wrangler deploy --dry-run --outdir .build   # bundle (wrangler.toml holds the bundling config)
//   node build-pages.mjs                            # → dist/_worker.js
//   npx wrangler pages deploy dist --project-name fareql --branch main --no-bundle
import page from './index.html'
import { createPlayground } from './app.js'

type Env = { DEMO_SECRET?: string }

let handle: ((request: Request) => Promise<Response>) | undefined

// Best-effort limit per isolate: 60 API calls per minute per client IP.
const LIMIT = 60
const hits = new Map<string, { n: number; reset: number }>()
function limited(request: Request): boolean {
  const ip = request.headers.get('cf-connecting-ip') ?? 'anonymous'
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || h.reset < now) {
    hits.set(ip, { n: 1, reset: now + 60_000 })
    if (hits.size > 10_000) hits.clear()
    return false
  }
  return ++h.n > LIMIT
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path !== '/' && limited(request)) {
      return new Response(JSON.stringify({ error: 'Too many requests, slow down a little' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      })
    }
    handle ??= createPlayground({ page, demoSecret: env.DEMO_SECRET })
    return handle(request)
  },
}
