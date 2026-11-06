import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vitest/config'

// graphql must load as a single instance: files vitest transforms and dependencies Node loads
// natively have to get the same build. This is a test-runner concern only; plain Node resolves
// one copy on its own (see scripts/smoke.mjs, which CI runs against the built package).
// graphql 17 does not export its package.json, so read it next to the resolved entry.
const entry = createRequire(import.meta.url).resolve('graphql')
const { version } = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string }
const major = Number(version.split('.')[0])

const conditions = ['module-sync', 'node', 'import', 'default']
export default defineConfig(
  major >= 17
    ? { resolve: { conditions }, ssr: { resolve: { conditions, externalConditions: conditions } } }
    : {
        resolve: { alias: { graphql: 'graphql/index.js' } },
        test: { server: { deps: { inline: ['graphql-yoga', /@graphql-yoga\//, /@envelop\//, /@graphql-tools\//] } } },
      },
)
