/**
 * End-to-end tests for the DNS-rebinding pin and the cross-origin credential
 * strip. These hit REAL loopback servers (not stubs) so they verify the actual
 * undici dispatcher/lookup contract — a wrong contract would break every
 * provider's media download, so it must be exercised for real.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { secureFetch } from '../src/index.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port)
  }))
}

describe('@bot-wa/http connection pinning', () => {
  it('connects to the pinned IP, not a re-resolution of the hostname', async () => {
    // Server is on 127.0.0.1; the hostname `pinned.test` only "resolves" via the
    // stub resolver → 127.0.0.1. If undici re-resolved `pinned.test` itself it
    // would fail (no such host); success proves the socket is pinned.
    const port = await listen((_req, res) => { res.statusCode = 200; res.end('pinned-ok') })
    const { body, response } = await secureFetch(`http://pinned.test:${port}/`, {
      allowHttp: true,
      allowPrivateHosts: true,
      resolver: async () => ['127.0.0.1'],
    })
    expect(response.status).toBe(200)
    expect(body.toString()).toBe('pinned-ok')
  })

  it('does not forward Authorization to a different origin on redirect', async () => {
    let target2Auth: string | undefined = 'NOT_CALLED'
    const port2 = await listen((req, res) => { target2Auth = req.headers.authorization; res.statusCode = 200; res.end('final') })
    const port1 = await listen((_req, res) => {
      res.statusCode = 302
      res.setHeader('location', `http://127.0.0.1:${port2}/next`) // different origin (different port)
      res.end()
    })
    const { body } = await secureFetch(`http://127.0.0.1:${port1}/`, {
      allowHttp: true,
      allowPrivateHosts: true,
      headers: { authorization: 'Bearer super-secret' },
    })
    expect(body.toString()).toBe('final')
    expect(target2Auth).toBeUndefined() // credential stripped on cross-origin hop
  })

  it('keeps Authorization on a same-origin redirect', async () => {
    let seen: string | undefined
    let first = true
    const port = await listen((req, res) => {
      if (first) { first = false; res.statusCode = 302; res.setHeader('location', '/again'); res.end(); return }
      seen = req.headers.authorization; res.statusCode = 200; res.end('done')
    })
    await secureFetch(`http://127.0.0.1:${port}/`, {
      allowHttp: true,
      allowPrivateHosts: true,
      headers: { authorization: 'Bearer keep-me' },
    })
    expect(seen).toBe('Bearer keep-me')
  })
})
