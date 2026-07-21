/**
 * Hermetic websocket fake — the gateway tests drive the protocol through this
 * without ever opening a real connection.
 */

import type { SocketFactory, SocketLike } from '../src/types.js'

type Event = 'open' | 'message' | 'close' | 'error'

export class FakeSocket implements SocketLike {
  /** Every payload the client sent, already JSON-parsed. */
  sent: Array<Record<string, unknown>> = []
  /** close() calls made by the client. */
  closedWith: Array<[number | undefined, string | undefined]> = []
  private handlers: Partial<Record<Event, Array<(...a: unknown[]) => void>>> = {}

  on(event: Event, fn: (...a: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(fn)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code?: number, reason?: string): void {
    this.closedWith.push([code, reason])
    this.emit('close', code ?? 1000, reason ?? '')
  }

  emit(event: Event, ...args: unknown[]): void {
    for (const fn of this.handlers[event] ?? []) fn(...args)
  }

  /** Simulate a frame arriving from the gateway. */
  serverSend(payload: unknown): void {
    this.emit('message', JSON.stringify(payload))
  }
}

export function fakeSocketFactory(): { sockets: FakeSocket[]; urls: string[]; factory: SocketFactory } {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const factory: SocketFactory = (url) => {
    urls.push(url)
    const s = new FakeSocket()
    sockets.push(s)
    return s
  }
  return { sockets, urls, factory }
}

export const wait = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))
