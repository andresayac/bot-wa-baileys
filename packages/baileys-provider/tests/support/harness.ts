/**
 * Test harness: a BaileysProvider wired to a fake socket, so tests can push raw
 * Baileys event maps through the provider's real `ev.process` pipeline and
 * assert on the normalized events it emits. No network.
 *
 * Test files must mock `@whiskeysockets/baileys` so `makeWASocket` returns
 * {@link fakeMakeWASocket}; see `poll-votes.test.ts` for the pattern.
 */
import { vi } from 'vitest'
import type { InboundEvent } from '@botmesh/core'
import type { BaileysProvider, BaileysProviderConfig } from '../../src/BaileysProvider.js'

/** The bot's own identity (device-qualified, as Baileys stores it in creds.me). */
export const ME_PN = '573000000000@s.whatsapp.net'
export const ME_LID = '900000000000001@lid'
export const ME = { id: '573000000000:12@s.whatsapp.net', lid: '900000000000001:12@lid', name: 'bot' }

type EventMap = Record<string, unknown>
type ProcessHandler = (events: EventMap) => Promise<void>

export interface FakeSocket {
  ev: { process: (handler: ProcessHandler) => void }
  end: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  signalRepository: { lidMapping: { getPNForLID: ReturnType<typeof vi.fn> } }
  /** LID → device-qualified PN answers for `lidMapping.getPNForLID`. */
  lidMap: Map<string, string>
  /** The config the provider passed to `makeWASocket` (e.g. its `getMessage`). */
  config: Record<string, unknown>
  handler?: ProcessHandler
}

const sockets: FakeSocket[] = []

export function fakeMakeWASocket(config: Record<string, unknown> = {}): FakeSocket {
  const lidMap = new Map<string, string>()
  const sock: FakeSocket = {
    ev: { process: (handler) => { sock.handler = handler } },
    end: vi.fn(),
    sendMessage: vi.fn(async (jid: string) => ({ key: { remoteJid: jid, fromMe: true, id: 'OUT-1' }, message: {} })),
    signalRepository: {
      lidMapping: { getPNForLID: vi.fn(async (lid: string) => lidMap.get(lid) ?? null) },
    },
    lidMap,
    config,
  }
  sockets.push(sock)
  return sock
}

type Internals = { authState: unknown; version: [number, number, number]; buildSocket(): Promise<void> }

export interface Harness {
  provider: BaileysProvider
  sock: FakeSocket
  events: InboundEvent[]
  /** Push one Baileys event map through the provider's `ev.process` handler. */
  emit(events: EventMap): Promise<void>
  ofKind<K extends InboundEvent['kind']>(kind: K): Array<Extract<InboundEvent, { kind: K }>>
}

export async function connect(
  Provider: typeof BaileysProvider,
  config: BaileysProviderConfig = {},
): Promise<Harness> {
  const provider = new Provider({ session: 'harness', rateLimit: { enabled: false }, qr: { terminal: false }, ...config })
  const internals = provider as unknown as Internals
  internals.authState = { state: { creds: { me: ME, registered: true }, keys: {} }, saveCreds: async () => {} }
  internals.version = [2, 3000, 1]
  await internals.buildSocket()
  const sock = sockets.at(-1)!
  const events: InboundEvent[] = []
  provider.onEvent((e) => { events.push(e) })
  return {
    provider,
    sock,
    events,
    emit: async (map) => { await sock.handler!(map) },
    ofKind: (kind) => events.filter((e) => e.kind === kind) as never,
  }
}
