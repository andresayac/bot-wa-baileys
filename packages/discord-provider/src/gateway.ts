/**
 * gateway — minimal-but-correct Discord Gateway (v10) client over an
 * injectable socket. Implements the lifecycle the bot needs and nothing more:
 *
 *   HELLO (op 10)      → start heartbeating + IDENTIFY (op 2) or RESUME (op 6)
 *   DISPATCH (op 0)    → track sequence `s`, capture session_id on READY
 *   HEARTBEAT (op 1)   → answer immediately with our seq
 *   HEARTBEAT_ACK      → mark the connection live (missing ack → zombie → reconnect)
 *   RECONNECT (op 7)   → drop and resume
 *   INVALID_SESSION    → resume when `d` is true, else fresh IDENTIFY
 *   close codes        → fatal (4004/4010-4014) stop; 4007/4009 fresh session;
 *                        anything else resumes with exponential backoff
 *
 * The socket is created through `socketFactory`, so tests inject a fake and no
 * real websocket is ever opened.
 */

import WebSocket from 'ws'
import type { LoggerLike } from '@botmesh/core'
import type { ConnectionUpdate, DisconnectReason } from '@botmesh/core'
import {
  FATAL_CLOSE_CODES,
  FRESH_SESSION_CODES,
  GatewayOpcode,
  type GatewayPayload,
  type SocketFactory,
  type SocketLike,
} from './types.js'

/** Default factory — the `ws` package. */
export const defaultSocketFactory: SocketFactory = (url) => {
  const ws = new WebSocket(url)
  const on = ws.on.bind(ws) as unknown as (e: string, l: (...a: unknown[]) => void) => void
  return {
    send: (d: string) => ws.send(d),
    close: (c?: number, r?: string) => ws.close(c, r),
    terminate: () => ws.terminate(),
    on: (e, l) => on(e, l),
    removeAllListeners: () => { ws.removeAllListeners() },
  }
}

/** `{gatewayUrl}/?v=10&encoding=json` — the connect URL Discord documents. */
export function gatewayConnectUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/?v=10&encoding=json`
}

export interface GatewaySocketConfig {
  token: string
  intents: number
  gatewayUrl: string
  socketFactory: SocketFactory
  logger: LoggerLike
  /** Base reconnect delay in ms (exponential backoff applies on top). Default 500. */
  reconnectDelayMs?: number
  /** Called for every DISPATCH frame (op 0) with its event name + payload. */
  dispatch: (t: string, d: unknown) => void
  /** Connection state transitions (connecting / authenticating / closed). */
  connection: (update: ConnectionUpdate) => void
}

const CLOSE_MEANINGS: Record<number, string> = {
  4004: 'Authentication failed (bad token)',
  4007: 'Invalid sequence',
  4008: 'Rate limited',
  4009: 'Session timed out',
  4010: 'Invalid shard',
  4011: 'Sharding required',
  4012: 'Invalid API version',
  4013: 'Invalid intents',
  4014: 'Disallowed intents (enable them in the Developer Portal)',
}

export class GatewaySocket {
  private socket: SocketLike | null = null
  private seq: number | null = null
  private sessionId: string | null = null
  private resumeGatewayUrl: string | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatAcked = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private stopped = false

  constructor(private readonly cfg: GatewaySocketConfig) {}

  /** The live socket (debug handle — core must NOT reach through it). */
  get rawSocket(): unknown { return this.socket }
  /** Current gateway session id (for resume). */
  get session(): string | null { return this.sessionId }

  async connect(): Promise<void> {
    this.stopped = false
    this.open()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    const s = this.socket
    this.socket = null
    s?.removeAllListeners?.()
    try { s?.close(1000, 'shutdown') } catch { /* already gone */ }
  }

  /** Send an arbitrary gateway payload (op/d object). */
  send(payload: Record<string, unknown>): void {
    if (!this.socket) return
    this.socket.send(JSON.stringify(payload))
  }

  /* --- lifecycle ---------------------------------------------------------- */

  private open(): void {
    this.cfg.connection({ state: 'connecting' })
    const base = this.sessionId ? (this.resumeGatewayUrl ?? this.cfg.gatewayUrl) : this.cfg.gatewayUrl
    const socket = this.cfg.socketFactory(gatewayConnectUrl(base))
    this.socket = socket
    socket.on('open', () => { this.reconnectAttempts = 0 })
    socket.on('message', (data) => this.onMessage(data))
    socket.on('close', (code) => {
      if (this.socket !== socket) return // superseded socket
      this.handleClose(typeof code === 'number' ? code : Number(code) || 1006)
    })
    socket.on('error', (err) => this.cfg.logger.warn({ err }, 'discord gateway socket error'))
  }

  private onMessage(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    let frame: GatewayPayload
    try {
      frame = JSON.parse(text) as GatewayPayload
    } catch {
      this.cfg.logger.warn('discord gateway: dropped non-JSON frame')
      return
    }

    switch (frame.op) {
      case GatewayOpcode.Hello: {
        const interval = (frame.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41_250
        this.startHeartbeat(interval)
        if (this.sessionId) this.resume()
        else this.identify()
        break
      }
      case GatewayOpcode.Dispatch: {
        if (typeof frame.s === 'number') this.seq = frame.s
        const t = frame.t ?? ''
        if (t === 'READY') {
          const d = frame.d as { session_id?: string; resume_gateway_url?: string } | undefined
          this.sessionId = d?.session_id ?? null
          this.resumeGatewayUrl = d?.resume_gateway_url ?? null
        }
        this.cfg.dispatch(t, frame.d)
        break
      }
      case GatewayOpcode.Heartbeat:
        // Server asked for an immediate heartbeat.
        this.send({ op: GatewayOpcode.Heartbeat, d: this.seq })
        break
      case GatewayOpcode.HeartbeatAck:
        this.heartbeatAcked = true
        break
      case GatewayOpcode.Reconnect:
        this.cfg.logger.debug('discord gateway: server requested reconnect')
        this.teardown(4000)
        break
      case GatewayOpcode.InvalidSession: {
        const resumable = frame.d === true
        this.cfg.logger.warn({ resumable }, 'discord gateway: invalid session')
        if (!resumable) this.invalidateSession()
        this.teardown(4000)
        break
      }
      default:
        break
    }
  }

  private identify(): void {
    this.cfg.connection({ state: 'authenticating' })
    this.send({
      op: GatewayOpcode.Identify,
      d: {
        token: this.cfg.token,
        intents: this.cfg.intents,
        properties: { os: process.platform, browser: '@botmesh/discord', device: '@botmesh/discord' },
      },
    })
  }

  private resume(): void {
    this.cfg.connection({ state: 'authenticating' })
    this.send({
      op: GatewayOpcode.Resume,
      d: { token: this.cfg.token, session_id: this.sessionId, seq: this.seq },
    })
  }

  /* --- heartbeat ----------------------------------------------------------- */

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat()
    this.heartbeatAcked = true
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.cfg.logger.warn('discord gateway: heartbeat not acked — zombie connection, reconnecting')
        this.teardown(4000)
        return
      }
      this.heartbeatAcked = false
      this.send({ op: GatewayOpcode.Heartbeat, d: this.seq })
    }, intervalMs)
  }

  /* --- disconnect handling --------------------------------------------------- */

  /** Drop the current socket (no reconnect from the close event) and reconnect. */
  private teardown(code: number): void {
    this.clearHeartbeat()
    const s = this.socket
    this.socket = null
    s?.removeAllListeners?.()
    try { s?.close(code) } catch { /* already gone */ }
    this.scheduleReconnect()
  }

  private handleClose(code: number): void {
    this.clearHeartbeat()
    this.socket = null
    if (this.stopped) return

    if (FATAL_CLOSE_CODES.has(code)) {
      this.cfg.connection({
        state: 'closed',
        reason: 'sessionInvalid',
        detail: { code, message: CLOSE_MEANINGS[code] ?? 'Fatal gateway close' },
      })
      return
    }
    if (FRESH_SESSION_CODES.has(code)) this.invalidateSession()

    const reason: DisconnectReason = code === 4008 ? 'rateLimited' : 'transient'
    this.cfg.connection({
      state: 'closed',
      reason,
      ...(reason === 'rateLimited' ? { retryAfterMs: 5_000 } : {}),
      detail: { code, message: CLOSE_MEANINGS[code] },
    })
    this.scheduleReconnect()
  }

  private invalidateSession(): void {
    this.sessionId = null
    this.seq = null
    this.resumeGatewayUrl = null
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const base = this.cfg.reconnectDelayMs ?? 500
    const delay = base === 0 ? 0 : Math.min(base * 2 ** this.reconnectAttempts, 30_000)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
