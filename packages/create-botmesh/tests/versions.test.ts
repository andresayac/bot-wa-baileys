import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TEMPLATE_NAMES, TEMPLATES } from '../src/templates.js'
import { BOTMESH_VERSIONS } from '../src/versions.js'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PKG_DIR, '..', '..')
const GENERATOR = join(PKG_DIR, 'scripts', 'gen-versions.mjs')

const tempDirs: string[] = []
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

/** name â†’ version of every public `@botmesh/*` workspace package. */
async function workspaceVersions(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const dir of await readdir(join(REPO_ROOT, 'packages'))) {
    const file = join(REPO_ROOT, 'packages', dir, 'package.json')
    if (!existsSync(file)) continue
    const pkg = JSON.parse(await readFile(file, 'utf8')) as { name: string; version: string; private?: boolean }
    if (!pkg.private && pkg.name.startsWith('@botmesh/')) out.set(pkg.name, pkg.version)
  }
  return out
}

describe('stamped @botmesh versions', () => {
  it('src/versions.ts is in sync with the workspace package.json files', () => {
    const res = spawnSync(process.execPath, [GENERATOR, '--check'], { cwd: PKG_DIR, encoding: 'utf8' })
    expect(res.stderr + res.stdout).not.toMatch(/out of date/)
    expect(res.status).toBe(0)
  })

  it('stamps a caret over the exact current version of every public package', async () => {
    const versions = await workspaceVersions()
    expect(Object.keys(BOTMESH_VERSIONS).sort()).toEqual([...versions.keys()].sort())
    for (const [name, version] of versions) {
      expect(BOTMESH_VERSIONS[name as keyof typeof BOTMESH_VERSIONS]).toBe(`^${version}`)
    }
  })

  it('every template depends on the generated range of each @botmesh package', () => {
    for (const t of TEMPLATE_NAMES) {
      const pj = TEMPLATES[t].files('demo').find((f) => f.path === 'package.json')
      expect(pj, t).toBeTruthy()
      const deps = (JSON.parse(pj!.contents) as { dependencies: Record<string, string> }).dependencies
      for (const [dep, range] of Object.entries(deps)) {
        if (!dep.startsWith('@botmesh/')) continue
        expect(range, `${t}: ${dep}`).toBe(BOTMESH_VERSIONS[dep as keyof typeof BOTMESH_VERSIONS])
      }
    }
  })

  it('generates prerelease-aware ranges (npm only resolves a prerelease named in the range)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-botmesh-versions-'))
    tempDirs.push(root)
    const pkgs: Array<[string, Record<string, unknown>]> = [
      ['core', { name: '@botmesh/core', version: '2.0.0-alpha.2' }],
      ['baileys-provider', { name: '@botmesh/baileys', version: '0.1.1-alpha.0' }],
      ['sqlite-store', { name: '@botmesh/sqlite-store', version: '0.2.0' }],
      ['nlu', { name: '@botmesh/nlu', version: '0.1.0', private: true }],
      ['create-botmesh', { name: 'create-botmesh', version: '0.1.1-alpha.0' }],
    ]
    for (const [dir, pkg] of pkgs) {
      await mkdir(join(root, 'packages', dir), { recursive: true })
      await writeFile(join(root, 'packages', dir, 'package.json'), JSON.stringify(pkg))
    }
    const out = join(root, 'versions.ts')
    execFileSync(process.execPath, [GENERATOR, '--root', root, '--out', out])
    const src = await readFile(out, 'utf8')
    expect(src).toContain("'@botmesh/core': '^2.0.0-alpha.2'")
    expect(src).toContain("'@botmesh/baileys': '^0.1.1-alpha.0'")
    expect(src).toContain("'@botmesh/sqlite-store': '^0.2.0'")
    expect(src).not.toContain('@botmesh/nlu')
    expect(src).not.toContain('create-botmesh')

    // --check against the freshly generated file passes; after a version bump it fails.
    expect(spawnSync(process.execPath, [GENERATOR, '--root', root, '--out', out, '--check']).status).toBe(0)
    await writeFile(join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@botmesh/core', version: '2.0.0-alpha.3' }))
    const stale = spawnSync(process.execPath, [GENERATOR, '--root', root, '--out', out, '--check'], { encoding: 'utf8' })
    expect(stale.status).not.toBe(0)
    expect(stale.stderr).toMatch(/out of date/)
  })
})
