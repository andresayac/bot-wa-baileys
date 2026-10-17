import type { HostResolver } from '@bot-wa/http'

export interface CapturedRequest {
  url: string
  method: string
  headers: Headers
  body: Buffer
}

/** A fake fetch that records requests and answers with `respond(req)`. */
export function fakeFetch(respond: (req: CapturedRequest) => Response | Promise<Response>) {
  const calls: CapturedRequest[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = init.body === undefined || init.body === null
      ? Buffer.alloc(0)
      : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array)
    const req: CapturedRequest = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body,
    }
    calls.push(req)
    return respond(req)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** Public-looking DNS answer so `secureFetch` never hits real DNS. */
export const publicResolver: HostResolver = async () => ['93.184.216.34']

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** A minimal OGG/Opus stream whose last page reports `seconds` of audio. */
export function makeOgg(seconds: number, preSkip = 312): Buffer {
  const page = (granule: bigint, payload: Buffer) => {
    const header = Buffer.alloc(27)
    header.write('OggS', 0, 'latin1')
    header.writeBigInt64LE(granule, 6)
    return Buffer.concat([header, payload])
  }
  const opusHead = Buffer.alloc(19)
  opusHead.write('OpusHead', 0, 'latin1')
  opusHead[8] = 1 // version
  opusHead[9] = 1 // channels
  opusHead.writeUInt16LE(preSkip, 10)
  opusHead.writeUInt32LE(16_000, 12)
  const audio = Buffer.alloc(64, 7)
  return Buffer.concat([
    page(0n, opusHead),
    page(BigInt(Math.round(seconds * 48_000) + preSkip), audio),
  ])
}

export interface RecordedLog { level: string; args: unknown[] }

/** LoggerLike that records every call. */
export function recordingLogger() {
  const logs: RecordedLog[] = []
  const logger = {
    debug: (...args: unknown[]) => { logs.push({ level: 'debug', args }) },
    info: (...args: unknown[]) => { logs.push({ level: 'info', args }) },
    warn: (...args: unknown[]) => { logs.push({ level: 'warn', args }) },
    error: (...args: unknown[]) => { logs.push({ level: 'error', args }) },
    child: () => logger,
  }
  return { logger, logs }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
