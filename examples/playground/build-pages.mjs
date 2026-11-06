// Turns the Worker bundle (wrangler deploy --dry-run --outdir .build) into a single-file
// Cloudflare Pages `_worker.js` with the page inlined. See worker.ts for the full deploy steps.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const html = readdirSync('.build').find((f) => f.endsWith('-index.html'))
if (!html) throw new Error('Run `npx wrangler deploy --dry-run --outdir .build` first')
let worker = readFileSync('.build/worker.js', 'utf8')
const escaped = html.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const importLine = new RegExp(`import\\s+(\\w+)\\s+from\\s+"\\./${escaped}";`)
const match = importLine.exec(worker)
if (!match) throw new Error('Page import not found in the bundle')
// A replacer function, so "$" sequences in the page are not treated as replacement patterns.
const inlined = `const ${match[1]} = ${JSON.stringify(readFileSync(`.build/${html}`, 'utf8'))};`
worker = worker.replace(match[0], () => inlined)
worker = worker.replace(/\n\/\/# sourceMappingURL=.*$/, '')
mkdirSync('dist', { recursive: true })
writeFileSync('dist/_worker.js', worker)
console.log(`dist/_worker.js written (${Math.round(worker.length / 1024)} KiB)`)
