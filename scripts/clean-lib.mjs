#!/usr/bin/env node
// Removes every workspace package's compiled `lib/` folder. `tsc` never deletes
// stale output, so a renamed or removed source file would otherwise linger in
// lib/ and end up in a published tarball. `pnpm release` runs this first.
// Paths resolve from the repo root (not the cwd), so it works from any directory.
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let removed = 0
for (const group of ['packages', 'examples']) {
  const dir = join(ROOT, group)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    const lib = join(dir, name, 'lib')
    if (existsSync(lib)) {
      rmSync(lib, { recursive: true, force: true })
      removed++
    }
  }
}
console.log(`clean-lib: removed ${removed} lib/ folder(s)`)
