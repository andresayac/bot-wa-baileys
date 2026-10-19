#!/usr/bin/env node
// Removes every workspace package's compiled `lib/` folder. `tsc` never deletes
// stale output, so a renamed or removed source file would otherwise linger in
// lib/ and end up in a published tarball. `pnpm release` runs this first.
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let removed = 0
for (const root of ['packages', 'examples']) {
  if (!existsSync(root)) continue
  for (const name of readdirSync(root)) {
    const lib = join(root, name, 'lib')
    if (existsSync(lib)) {
      rmSync(lib, { recursive: true, force: true })
      removed++
    }
  }
}
console.log(`clean-lib: removed ${removed} lib/ folder(s)`)
