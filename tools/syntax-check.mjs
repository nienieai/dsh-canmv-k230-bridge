// Syntax check for dynamic plugin source (host + client halves).
// Pure JS, no build step. Run: node tools/syntax-check.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = ['lib/host.js', 'lib/client.js']
let failed = 0

for (const f of files) {
  const abs = join(root, f)
  const res = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(`[FAIL] ${f}\n${res.stderr}`)
    failed++
  } else {
    console.log(`[OK]   ${f}`)
  }
}

process.exit(failed ? 1 : 0)
