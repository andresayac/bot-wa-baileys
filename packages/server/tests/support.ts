import { createServer, request as httpRequest, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Headers = Record<string, string | string[] | undefined>

/** A fake webhook provider that records what the ingress handed it. */
export class FakeWebhookProvider {
  calls: Array<{ raw: unknown; headers?: Headers }> = []
  result: unknown = 200
  challenge: string | null = null
  challengeQueries: Array<Record<string, string>> = []
  ingest(raw: unknown, headers?: Headers): unknown {
    this.calls.push({ raw, headers })
    return typeof this.result === 'function' ? (this.result as (raw: unknown) => unknown)(raw) : this.result
  }
  verifyChallenge(query: Record<string, string>): string | null {
    this.challengeQueries.push(query)
    return this.challenge
  }
}

/** Ingest-only provider (Telegram-like: no GET handshake). */
export class IngestOnlyProvider {
  calls: unknown[] = []
  ingest(raw: unknown): number { this.calls.push(raw); return 200 }
}

export interface Running { url: string; port: number; server: Server; close(): Promise<void> }

export async function listen(handler: RequestListener | Server): Promise<Running> {
  const server = typeof handler === 'function' ? createServer(handler) : handler
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

export interface RawResponse { status: number; headers: IncomingHttpHeaders; body: string }

/**
 * Low-level request helper: lets a test send a body in chunks (no
 * Content-Length), stall mid-body, or lie about the length. Resolves with the
 * response, or with `{ status: 0 }` when the server reset the connection.
 */
export function rawRequest(port: number, opts: {
  method?: string
  path?: string
  headers?: Record<string, string>
  chunks?: Array<string | Buffer>
  /** Leave the request open after writing the chunks (to trigger body timeouts). */
  stall?: boolean
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/webhook', headers: opts.headers }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') resolve({ status: 0, headers: {}, body: '' })
      else reject(err)
    })
    for (const c of opts.chunks ?? []) req.write(c)
    if (!opts.stall) req.end()
  })
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Logger that records every call so tests can assert nothing sensitive leaked. */
export function recordingLogger() {
  const entries: Array<{ level: string; obj: unknown; msg?: string }> = []
  const make = (level: string) => (obj: unknown, msg?: string) => { entries.push({ level, obj, msg }) }
  return { entries, logger: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') } }
}

export const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
