/**
 * IdentityStore — stabilises Baileys 7 LID/PN identity across messages.
 *
 * Baileys 7 addresses a DM partner (or group participant) by their opaque LID
 * (`…@lid`) and rides the phone-number twin (`…@s.whatsapp.net`, "PN") alongside
 * in `remoteJidAlt`/`participantAlt`. That twin is NOT present on every message:
 * the same partner can arrive as `LID + PN twin` on one message and as a bare
 * `LID` on the next. Because the conversation runtime keys active flows by
 * identity, an inconsistent identity silently splits one person across two keys —
 * the active `ask` never receives the answer and the flow re-prompts forever
 * (the "flujos tienen líos" bug seen live).
 *
 * This store LEARNS a LID↔PN pairing the first time it sees both forms together,
 * then CANONICALISES any later bare LID back to its PN. With it, all three
 * representations (PN-only, LID+twin, bare-LID-once-learned) collapse to a single
 * stable PN identity, so `keyFor()` never flips mid-conversation.
 */
import { normalize, isLidUser, isPnUser } from '../utils/jid.js'
import { putBounded } from '../utils/boundedMap.js'

/** Cap on stored pairs — one bot rarely talks to more than a few thousand LIDs. */
const IDENTITY_MAX = 4000

export class IdentityStore {
  /** Bidirectional: lid→pn AND pn→lid (see {@link putBounded}). */
  private map = new Map<string, string>()

  /**
   * Record a `primary`/`alt` pair from an inbound key. `alt` is the PN twin of
   * `primary` (or vice-versa); the pair is stored only when one side is a LID and
   * the other a PN. Null/empty inputs are ignored.
   */
  observe(primary?: string | null, alt?: string | null): void {
    if (!primary || !alt) return
    const p = normalize(primary)
    const a = normalize(alt)
    if (isLidUser(p) && isPnUser(a)) putBounded(this.map, p, a, IDENTITY_MAX)
    else if (isPnUser(p) && isLidUser(a)) putBounded(this.map, a, p, IDENTITY_MAX)
  }

  /**
   * Map a LID to its learned PN. Returns `jid` unchanged when it is not a LID, or
   * when no PN twin has been learned yet (best-effort: it stabilises once learned).
   */
  canonical(jid: string): string {
    if (!jid || !isLidUser(jid)) return jid
    const pn = this.map.get(normalize(jid))
    return pn && isPnUser(pn) ? pn : jid
  }

  /** True if a PN twin is already known for this LID (skips redundant async lookups). */
  knowsPnFor(lid: string): boolean {
    if (!lid || !isLidUser(lid)) return false
    const pn = this.map.get(normalize(lid))
    return !!pn && isPnUser(pn)
  }
}
