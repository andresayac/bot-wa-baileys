/**
 * Baileys 7.0.0-rc14 socket configuration.
 *
 * WhatsApp started closing older/non-standard clients with 428 "Connection
 * Terminated" before the QR. rc14 ships a refreshed handshake whose default
 * identity is `Browsers.macOS('Chrome')` (DeviceProps CHROME, companion web
 * client CHROME). Because `makeWASocket` merges `{ ...DEFAULT_CONNECTION_CONFIG,
 * ...config }`, any `browser` key we pass, even `undefined`, replaces that
 * default. These tests pin that the provider leaves the default alone unless
 * the caller explicitly opts out, and that the presets stay on the Chrome
 * platform type end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { Browsers } from '@whiskeysockets/baileys'

const captured: Array<Record<string, unknown>> = []

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return {
    ...actual,
    // No network: the fake socket only records the config it was built with.
    default: vi.fn((config: Record<string, unknown>) => {
      captured.push(config)
      return { ev: { process: vi.fn() }, end: vi.fn() }
    }),
    makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  }
})

const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { resolveBrowser } = await import('../src/browser.js')

type Internals = { authState: unknown; version: [number, number, number]; buildSocket(): Promise<void> }

async function socketConfigFor(config: ConstructorParameters<typeof BaileysProvider>[0]) {
  const p = new BaileysProvider({ session: 'socket-config', ...config })
  const internals = p as unknown as Internals
  internals.authState = { state: { creds: {}, keys: {} }, saveCreds: async () => {} }
  internals.version = [2, 3000, 1043857760]
  await internals.buildSocket()
  return captured.at(-1)!
}

beforeEach(() => { captured.length = 0 })

describe('resolveBrowser (rc14 handshake identity)', () => {
  it('returns undefined by default so Baileys keeps its own default (macOS Chrome)', () => {
    expect(resolveBrowser(undefined)).toBeUndefined()
  })

  it.each([
    ['macOS', Browsers.macOS('Chrome')],
    ['ubuntu', Browsers.ubuntu('Chrome')],
    ['windows', Browsers.windows('Chrome')],
    ['appropriate', Browsers.appropriate('Chrome')],
  ] as const)('preset %s maps to the Chrome browser on that OS', (preset, expected) => {
    const tuple = resolveBrowser(preset)
    expect(tuple).toEqual(expected)
    expect(tuple?.[1]).toBe('Chrome') // DeviceProps CHROME + companion CHROME, never 'Desktop'/'Bot'
  })

  it('passes an explicit tuple through verbatim (caller-owned escape hatch)', () => {
    const custom: [string, string, string] = ['Mac OS', 'Desktop', '14.4.1']
    expect(resolveBrowser(custom)).toEqual(custom)
  })
})

describe('BaileysProvider socket options', () => {
  it('does not set a browser key at all when none is configured', async () => {
    const cfg = await socketConfigFor({})
    expect(Object.prototype.hasOwnProperty.call(cfg, 'browser')).toBe(false)
  })

  it('uses the Chrome preset tuple when a preset is configured', async () => {
    const cfg = await socketConfigFor({ browser: 'ubuntu' })
    expect(cfg.browser).toEqual(Browsers.ubuntu('Chrome'))
  })

  it('forwards the fetched WA Web version and keeps bot-friendly presence/history settings', async () => {
    const cfg = await socketConfigFor({})
    expect(cfg.version).toEqual([2, 3000, 1043857760])
    expect(cfg.markOnlineOnConnect).toBe(false)
    expect(cfg.syncFullHistory).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(cfg, 'shouldSyncHistoryMessage')).toBe(false) // never disable LID-mapping sync
  })

  it('warns once when a custom browser tuple overrides the default handshake', () => {
    const lines: Array<{ msg: string; browser?: unknown }> = []
    const logger = pino({ level: 'warn' }, { write: (s: string) => { lines.push(JSON.parse(s)) } })
    new BaileysProvider({ session: 'socket-config', logger, browser: ['Mac OS', 'Desktop', '14.4.1'] })
    new BaileysProvider({ session: 'socket-config', logger, browser: 'macOS' })
    new BaileysProvider({ session: 'socket-config', logger })
    const warns = lines.filter((l) => l.msg.includes('custom browser tuple'))
    expect(warns).toHaveLength(1)
    expect(warns[0]?.browser).toEqual(['Mac OS', 'Desktop', '14.4.1'])
  })
})
