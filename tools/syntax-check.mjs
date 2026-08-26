// Syntax check for dynamic plugin source (host + client halves).
// Both files are *function bodies* (top-level `return {...}`), meant to be
// wrapped/executed by cordis_define or `new Function` — so we validate them by
// parsing as a function body, not as a standalone module (node --check rejects
// a top-level `return`).
// Run: node tools/syntax-check.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = ['lib/host.js', 'lib/client.js']
let failed = 0

for (const f of files) {
  const abs = join(root, f)
  const body = readFileSync(abs, 'utf8')
  try {
    // `new Function(body)` parses body as a function body: top-level `return`
    // is legal, and any syntax error throws before execution.
    new Function(body)
    console.log(`[OK]   ${f}`)
  } catch (err) {
    console.error(`[FAIL] ${f}\n${err.message}`)
    failed++
  }
}

process.exit(failed ? 1 : 0)
