#!/usr/bin/env node
/**
 * typedoc-docs.cjs — run TypeDoc from the monorepo root.
 *
 * `.cjs` because the workspace root is `"type": "module"`; this script uses
 * CommonJS (`require`) intentionally.
 *
 * TypeDoc 0.28 does not support TypeScript 7 (the version used for the build),
 * so the `typescript-5` alias (typescript@5.9.3) is installed at the root and
 * TypeDoc is resolved against it. We locate TypeDoc's bin via `require.resolve`
 * rather than hardcoding a pnpm store path (which changes across installs).
 */
'use strict'

const { spawnSync } = require('node:child_process')
const { resolve, dirname } = require('node:path')

let typedocBin
try {
  // typedoc exposes its bin path in package.json "bin"
  const pkg = require('typedoc/package.json')
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.typedoc
  typedocBin = resolve(dirname(require.resolve('typedoc/package.json')), rel)
} catch (err) {
  console.error('[typedoc-docs] Could not resolve the "typedoc" package. Is it installed at the root?')
  console.error(err && err.message)
  process.exit(1)
}

const result = spawnSync(process.execPath, [typedocBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: resolve(__dirname, '..'),
})
process.exit(result.status ?? 1)
