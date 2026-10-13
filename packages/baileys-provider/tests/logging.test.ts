/**
 * Regression: pino only runs its Error serializer on the `err` key. Logging
 * `{ error }` printed failures as `"error":{}` (an Error's own properties are
 * non-enumerable), so the operator never saw WHY a reconnect or pairing failed.
 * These tests inject a real pino logger writing to a capturing stream and assert
 * the serialized JSON line carries the error message under `err`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { BaileysProvider } from '../src/BaileysProvider.js'
import { MAX_RECONNECT_ATTEMPTS } from '../src/reconnect.js'

type LogLine = {
  level: number
  msg: string
  err?: { type?: string; message?: string; stack?: string }
  error?: unknown
  statusCode?: number
  detail?: string
}

type Internals = {
  start: () => Promise<void>
  scheduleReconnect(ms: number): void
  onConnectionUpdate(u: { qr?: string; connection?: string; lastDisconnect?: { error?: unknown } }): Promise<void>
  sock: unknown
  authState: unknown
}

function capturingLogger() {
  const lines: LogLine[] = []
  const logger = pino({ level: 'debug' }, { write: (chunk: string) => { lines.push(JSON.parse(chunk) as LogLine) } })
  return { logger, lines }
}

const byMsg = (lines: LogLine[], fragment: string) => lines.filter((l) => l.msg.includes(fragment))

afterEach(() => { vi.useRealTimers() })

describe('BaileysProvider logs errors under the pino `err` key', () => {
  it('reconnect retry and give-up lines carry the start() failure message', async () => {
    const { logger, lines } = capturingLogger()
    const p = new BaileysProvider({ session: 'log-test', logger })
    vi.useFakeTimers()
    ;(p as unknown as Internals).start = vi.fn(async () => { throw new Error('dns lookup failed') })

    ;(p as unknown as Internals).scheduleReconnect(0)
    await vi.runAllTimersAsync()

    const retries = byMsg(lines, 'reconnect start() failed')
    expect(retries).toHaveLength(MAX_RECONNECT_ATTEMPTS)
    for (const line of retries) {
      expect(line.err?.message).toBe('dns lookup failed')
      expect(line.err?.type).toBe('Error')
      expect(line.error).toBeUndefined()
    }

    const [givingUp] = byMsg(lines, 'giving up: start() failed')
    expect(givingUp?.err?.message).toBe('dns lookup failed')
    expect(givingUp?.err?.stack).toContain('dns lookup failed')
    expect(givingUp?.error).toBeUndefined()
  })

  it('connection-close line carries the disconnect reason (e.g. 428 Connection Terminated)', async () => {
    const { logger, lines } = capturingLogger()
    const p = new BaileysProvider({ sessionsDir: tmpdir(), session: 'log-test', logger })
    vi.useFakeTimers() // the backoff timer is armed but never fired, so start() never runs
    const error = new Boom('Connection Terminated', { statusCode: 428 })

    await (p as unknown as Internals).onConnectionUpdate({ connection: 'close', lastDisconnect: { error } })

    const [line] = byMsg(lines, 'connection closed — reconnecting with backoff')
    expect(line?.statusCode).toBe(428)
    expect(line?.detail).toBe('Connection Terminated')
  })

  it('pairing-code failure line carries the request error message', async () => {
    const { logger, lines } = capturingLogger()
    const p = new BaileysProvider({ session: 'log-test', logger, pairingCode: '+57 300 000 0000', qr: { terminal: false } })
    const internals = p as unknown as Internals
    internals.authState = { state: { creds: { registered: false } }, saveCreds: async () => {} }
    internals.sock = { requestPairingCode: vi.fn(async () => { throw new Error('pairing rejected by server') }) }

    await internals.onConnectionUpdate({ qr: 'qr-payload' })

    const [line] = byMsg(lines, 'pairing code request failed')
    expect(line?.err?.message).toBe('pairing rejected by server')
    expect(line?.error).toBeUndefined()
  })
})
