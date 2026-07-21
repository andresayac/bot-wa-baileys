import { describe, it, expect, vi, afterEach } from 'vitest'
import pino from 'pino'
import { GatewaySocket, type GatewaySocketConfig } from '../src/gateway.js'
import { fakeSocketFactory, wait } from './_fakeSocket.js'

const logger = pino({ level: 'silent' })

const live: GatewaySocket[] = []

function setup(overrides: Partial<GatewaySocketConfig> = {}) {
  const { sockets, urls, factory } = fakeSocketFactory()
  const dispatch = vi.fn()
  const connection = vi.fn()
  const gw = new GatewaySocket({
    token: 'TOK',
    intents: 33281,
    gatewayUrl: 'wss://gateway.discord.gg',
    socketFactory: factory,
    logger,
    reconnectDelayMs: 0,
    dispatch,
    connection,
    ...overrides,
  })
  live.push(gw)
  return { gw, sockets, urls, dispatch, connection }
}

// Always stop every gateway so no heartbeat interval leaks between tests.
afterEach(async () => {
  while (live.length) await live.pop()!.stop()
})

describe('GatewaySocket', () => {
  it('connects to the documented URL and IDENTIFYs after HELLO', async () => {
    const { gw, sockets, urls, connection } = setup()
    await gw.connect()
    expect(urls[0]).toBe('wss://gateway.discord.gg/?v=10&encoding=json')

    sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 41_250 } })
    const identify = sockets[0].sent.find((p) => p.op === 2)
    expect(identify).toBeDefined()
    expect((identify!.d as { token: string; intents: number }).token).toBe('TOK')
    expect((identify!.d as { token: string; intents: number }).intents).toBe(33281)
    expect(connection.mock.calls.map((c) => (c[0] as { state: string }).state))
      .toEqual(['connecting', 'authenticating'])
  })

  it('heartbeats (op 1) every heartbeat_interval with the last sequence number', async () => {
    const { gw, sockets } = setup()
    await gw.connect()
    sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 30 } })
    sockets[0].serverSend({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: {} })

    await wait(120)
    const beats = sockets[0].sent.filter((p) => p.op === 1)
    expect(beats.length).toBeGreaterThanOrEqual(1)
    expect(beats[beats.length - 1].d).toBe(7)
  })

  it('answers a server HEARTBEAT request (op 1) with the current seq', async () => {
    const { gw, sockets } = setup()
    await gw.connect()
    sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    sockets[0].serverSend({ op: 0, t: 'X', s: 3, d: {} })
    sockets[0].serverSend({ op: 1, d: null })

    expect(sockets[0].sent.some((p) => p.op === 1 && p.d === 3)).toBe(true)
  })

  it('RESUMEs (op 6) with session_id + seq after a resumable close, on the resume URL', async () => {
    const { gw, sockets, urls, dispatch, connection } = setup()
    await gw.connect()
    sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    sockets[0].serverSend({
      op: 0, t: 'READY', s: 1,
      d: { session_id: 'SESS', resume_gateway_url: 'wss://resume.discord.gg' },
    })
    expect(dispatch).toHaveBeenCalledWith('READY', expect.objectContaining({ session_id: 'SESS' }))

    sockets[0].close(4000) // resumable
    await wait(40)
    expect(sockets).toHaveLength(2)
    expect(urls[1]).toBe('wss://resume.discord.gg/?v=10&encoding=json')

    sockets[1].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    const resume = sockets[1].sent.find((p) => p.op === 6)
    expect(resume).toMatchObject({ op: 6, d: { token: 'TOK', session_id: 'SESS', seq: 1 } })
    expect(connection.mock.calls.map((c) => c[0]))
      .toContainEqual(expect.objectContaining({ state: 'closed', reason: 'transient' }))
  })

  it('does NOT reconnect on a fatal close code (4004 auth failed)', async () => {
    const { gw, sockets, connection } = setup()
    await gw.connect()
    sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    sockets[0].close(4004)
    await wait(40)

    expect(sockets).toHaveLength(1)
    expect(connection.mock.calls.at(-1)![0]).toMatchObject({ state: 'closed', reason: 'sessionInvalid' })
  })

  it('INVALID_SESSION (not resumable) reconnects with a fresh IDENTIFY', async () => {
    const { gw, sockets } = setup()
    await gw.connect()
    sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    sockets[0].serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'SESS' } })
    sockets[0].serverSend({ op: 9, d: false })

    await wait(40)
    expect(sockets).toHaveLength(2)
    sockets[1].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    expect(sockets[1].sent.some((p) => p.op === 2)).toBe(true)
    expect(sockets[1].sent.some((p) => p.op === 6)).toBe(false)
  })

  it('stop() closes the socket and suppresses reconnects', async () => {
    const { gw, sockets } = setup()
    await gw.connect()
    sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 60_000 } })
    await gw.stop()

    expect(sockets[0].closedWith).toHaveLength(1)
    await wait(40)
    expect(sockets).toHaveLength(1)
  })
})
