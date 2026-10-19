/**
 * Regression tests: an already-aborted caller signal, and redirect responses
 * whose body is never read by the manual redirect loop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { secureFetch } from '../src/index.js'

const servers: Server[] = []
const open: ServerResponse[] = []
afterEach(async () => {
  for (const res of open.splice(0)) res.destroy()
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()) })))
})

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port)
  }))
}

describe('secureFetch abort signal', () => {
  it('rejects without any request when the signal is already aborted', async () => {
    const fetch = vi.fn(async () => new Response('should not happen'))
    const controller = new AbortController()
    controller.abort(new Error('caller gave up'))
    await expect(secureFetch('https://example.com/', {
      signal: controller.signal,
      resolver: async () => ['93.184.216.34'],
      fetch,
    })).rejects.toThrow('caller gave up')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('secureFetch redirect bodies', () => {
  it('does not hang on a redirect whose body never finishes', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/final') { res.end('done'); return }
      res.statusCode = 302
      res.setHeader('location', '/final')
      // A body that keeps the response open: the redirect loop never reads it.
      res.write('x'.repeat(64 * 1024))
      open.push(res)
    })
    const started = Date.now()
    const { body } = await secureFetch(`http://127.0.0.1:${port}/start`, { allowHttp: true, allowPrivateHosts: true, timeoutMs: 5_000 })
    expect(body.toString()).toBe('done')
    expect(Date.now() - started).toBeLessThan(4_000)
  })
})

describe('secureFetch body timeout', () => {
  it('reports a body that stalls past timeoutMs as a TIMEOUT SecureHttpError', async () => {
    const port = await listen((_req, res) => {
      res.write('partial')
      open.push(res)
    })
    await expect(secureFetch(`http://127.0.0.1:${port}/`, { allowHttp: true, allowPrivateHosts: true, timeoutMs: 200 }))
      .rejects.toMatchObject({ name: 'SecureHttpError', code: 'TIMEOUT' })
  })
})

