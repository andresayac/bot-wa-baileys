#!/usr/bin/env node
/**
 * Throwaway npm registry for the packaging smoke test: serves the packed
 * `@bot-wa/*` tarballs (one version each) so a scaffolded project can
 * `npm install` its UNMODIFIED dependency ranges, routed here with a scoped
 * `@bot-wa:registry=` entry. npm resolves the ranges itself (prerelease rules
 * included); everything else still comes from the public registry.
 *
 *   node registry.mjs <packages.json>
 *     packages.json: [{ "manifest": { name, version, ... }, "file": "/abs/x.tgz" }]
 *
 * Listens on 127.0.0.1 (random port) and prints `LISTENING <port>`. Never
 * accepts publishes: GET only.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename } from 'node:path'

const entries = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const byName = new Map()
const byFile = new Map()
for (const { manifest, file } of entries) {
  const data = readFileSync(file)
  const tgz = basename(file)
  byFile.set(tgz, data)
  byName.set(manifest.name, {
    manifest,
    tgz,
    shasum: createHash('sha1').update(data).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(data).digest('base64')}`,
  })
}

const server = createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`
  const path = decodeURIComponent(new URL(req.url ?? '/', base).pathname).replace(/^\/+/, '')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  if (path.startsWith('-/')) {
    const data = byFile.get(path.slice(2))
    if (!data) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length })
    res.end(req.method === 'HEAD' ? undefined : data)
    return
  }
  const pkg = byName.get(path)
  if (!pkg) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
    return
  }
  const { manifest } = pkg
  const body = JSON.stringify({
    name: manifest.name,
    'dist-tags': { latest: manifest.version },
    versions: {
      [manifest.version]: {
        ...manifest,
        _id: `${manifest.name}@${manifest.version}`,
        dist: { tarball: `${base}/-/${pkg.tgz}`, shasum: pkg.shasum, integrity: pkg.integrity },
      },
    },
  })
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`)
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
