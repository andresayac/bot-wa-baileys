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
 * Bounded (oldest entries evicted) so a long-running bot cannot grow it forever.
 */

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

  constructor(private readonly maxEntries = 10_000) {}

  /**
   * Resolve one person seen under `primary` (plus any twin aliases the payload
   * carried) to their canonical id, linking every alias for later lookups.
   * Returns `undefined` only when no usable alias was given.
   */
  resolve(primary: unknown, ...alts: unknown[]): string | undefined {
    const aliases = [primary, ...alts]
      .map(normalizeJid)
      .filter((a): a is string => a !== undefined)
    if (aliases.length === 0) return undefined
    let canonical: string | undefined
    for (const alias of aliases) {
      canonical = this.canonicalOf.get(alias)
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
    return this.canonicalOf.get(jid) ?? jid
  }

  /** True when this alias has already been linked to a canonical id. */
  has(alias: unknown): boolean {
    const jid = normalizeJid(alias)
    return jid !== undefined && this.canonicalOf.has(jid)
  }

  get size(): number {
    return this.canonicalOf.size
  }

  private link(alias: string, canonical: string): void {
    if (this.canonicalOf.get(alias) === canonical) return
    this.canonicalOf.delete(alias)
    this.canonicalOf.set(alias, canonical)
    while (this.canonicalOf.size > this.maxEntries) {
      const oldest = this.canonicalOf.keys().next().value
      if (oldest === undefined) break
      this.canonicalOf.delete(oldest)
    }
  }
}
