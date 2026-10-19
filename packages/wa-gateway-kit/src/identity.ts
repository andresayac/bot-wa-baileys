/**
 * WhatsApp identity reconciliation for REST gateways built on WhatsApp Web
 * (Evolution API runs Baileys; WPPConnect runs WA-JS).
 *
 * The same person can reach us as a phone-number JID (`<pn>@s.whatsapp.net` /
 * `<pn>@c.us`) or as an opaque LID (`<lid>@lid`), and the gateway does not
 * always attach the twin. The core contract requires ONE stable `senderId` per
 * human, so every alias seen together is linked to a single canonical id:
 *
 *  - the phone-number JID when it is known the first time the person is seen;
 *  - otherwise the first alias seen (first-seen wins), so a later message that
 *    finally reveals the PN keeps the id the conversation already uses.
 *
 * Because "first seen" depends on message order, the map must outlive the
 * process for the id to survive restarts: pass an {@link IdentityPersistence}
 * (read-through + write-on-change) backed by durable storage.
 *
 * The in-memory map is a bounded LRU (every resolve/lookup refreshes the
 * entry), so an active contact is never evicted in favour of stale ones.
 */

/** Durable backing for {@link WaIdentityStore}. Both calls are synchronous and must not throw. */
export interface IdentityPersistence {
  /** Canonical id previously stored for `alias` (read-through for aliases not in memory). */
  get(alias: string): string | undefined
  /** Called whenever `alias` is linked to a (new) canonical id. */
  set(alias: string, canonical: string): void
}

/** Strip the multi-device suffix (`5730:12@s.whatsapp.net` → `5730@s.whatsapp.net`) and whitespace. */
export function normalizeJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string') return undefined
  const trimmed = jid.trim()
  if (!trimmed) return undefined
  const at = trimmed.indexOf('@')
  if (at < 0) return trimmed
  const user = trimmed.slice(0, at).replace(/:\d+$/, '')
  return `${user}${trimmed.slice(at)}`
}

export const isLidJid = (jid: string): boolean => jid.endsWith('@lid')
export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us')

export class WaIdentityStore {
  private readonly canonicalOf = new Map<string, string>()

  constructor(
    private readonly maxEntries = 10_000,
    private readonly persistence?: IdentityPersistence,
  ) {}

  /**
   * Resolve one person seen under `primary` (plus any twin aliases the payload
   * carried) to their canonical id, linking every alias for later lookups.
   * Returns `undefined` only when no usable alias was given.
   */
  resolve(primary: unknown, ...alts: unknown[]): string | undefined {
    const aliases = [...new Set([primary, ...alts].map(normalizeJid).filter((a): a is string => a !== undefined))]
    if (aliases.length === 0) return undefined
    let canonical: string | undefined
    for (const alias of aliases) {
      canonical = this.get(alias)
      if (canonical) break
    }
    canonical ??= aliases.find((a) => !isLidJid(a)) ?? aliases[0]
    for (const alias of aliases) this.link(alias, canonical)
    return canonical
  }

  /** Canonical id for an alias without learning anything new (mentions, quotes, receipts). */
  lookup(alias: unknown): string | undefined {
    const jid = normalizeJid(alias)
    if (!jid) return undefined
    return this.get(jid) ?? jid
  }

  /** True when this alias has already been linked to a canonical id. */
  has(alias: unknown): boolean {
    const jid = normalizeJid(alias)
    return jid !== undefined && this.get(jid) !== undefined
  }

  get size(): number {
    return this.canonicalOf.size
  }

  /** In-memory hit (refreshed as most recently used) or persisted value (cached back). */
  private get(alias: string): string | undefined {
    const hit = this.canonicalOf.get(alias)
    if (hit !== undefined) {
      this.canonicalOf.delete(alias)
      this.canonicalOf.set(alias, hit)
      return hit
    }
    const stored = this.persistence?.get(alias)
    if (stored !== undefined) this.remember(alias, stored)
    return stored
  }

  private link(alias: string, canonical: string): void {
    const known = this.canonicalOf.get(alias)
    this.remember(alias, canonical)
    if (known !== canonical && this.persistence?.get(alias) !== canonical) this.persistence?.set(alias, canonical)
  }

  private remember(alias: string, canonical: string): void {
    this.canonicalOf.delete(alias)
    this.canonicalOf.set(alias, canonical)
    while (this.canonicalOf.size > this.maxEntries) {
      const oldest = this.canonicalOf.keys().next().value
      if (oldest === undefined) break
      this.canonicalOf.delete(oldest)
    }
  }
}
