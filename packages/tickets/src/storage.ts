import type { IStore } from '@botmesh/core'
import type { TicketKeyValue } from './types.js'

/** In-memory {@link TicketKeyValue} (lost on restart). Handy for tests or ephemeral bots. */
export function memoryTicketStorage(): TicketKeyValue {
  const map = new Map<string, string>()
  return {
    async get(key) { return map.get(key) },
    async set(key, value) { map.set(key, value) },
  }
}

/**
 * {@link TicketKeyValue} over the store's cursor API (`getCursor`/`setCursor`), which
 * all six bundled stores implement. Returns `undefined` when the store has no cursor
 * support, so the caller can fall back to memory.
 */
export function storeTicketStorage(store: Pick<IStore, 'getCursor' | 'setCursor'>): TicketKeyValue | undefined {
  if (typeof store.getCursor !== 'function' || typeof store.setCursor !== 'function') return undefined
  return {
    get: (key) => store.getCursor!(key),
    set: (key, value) => store.setCursor!(key, value),
  }
}
