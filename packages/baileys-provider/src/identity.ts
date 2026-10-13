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
import { normalize, normalizeInboundKey, isLidUser, isPnUser } from './jid.js'
import { putBounded } from './boundedMap.js'

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

  /** The learned twin of a user JID (the PN of a LID or the LID of a PN), if any. */
  alias(jid: string): string | undefined {
    if (!jid) return undefined
    return this.map.get(normalize(jid))
  }

  /**
   * Canonical id for a bare user/chat JID carried by a non-message event
   * (presence, call, group participant). Learns `alt`, the twin the event
   * carries alongside (`callerPn`, `authorPn`, a participant's `phoneNumber`),
   * then applies the same rule as messages: learned LID → PN, device suffix
   * stripped. Group/broadcast JIDs pass through normalised.
   */
  resolve(jid?: string | null, alt?: string | null): string {
    const primary = jid || alt
    if (!primary) return ''
    this.observe(jid, alt)
    return this.canonical(normalize(primary) || primary)
  }
}

/** The key fields canonicalisation reads; matches `WAMessageKey` and Baileys' reaction/vote keys. */
export interface IdentityKey {
  remoteJid?: string | null
  remoteJidAlt?: string | null
  participant?: string | null
  participantAlt?: string | null
  fromMe?: boolean | null
}

/**
 * The single LID/PN rule for a message key, shared by every emitted event
 * (messages, reactions, poll votes) so one person never shows up as a LID on
 * one event type and as a PN on another.
 *
 * Learns the LID↔PN pairs the key exposes, prefers the PN twin, maps a learned
 * LID back to its PN and strips device suffixes. `participant` overrides
 * `key.participant` (Baileys puts broadcast senders on `WAMessage.participant`).
 * For a `fromMe` DM key `senderId` is the chat partner, as for messages; callers
 * that need the author of their own action substitute the bot's id.
 */
export function canonicalKey(
  key: IdentityKey,
  identity: IdentityStore,
  participant?: string | null,
): { chatId: string; senderId: string; isGroup: boolean; rawParticipant: string | null } {
  const isGroup = (key.remoteJid ?? '').endsWith('@g.us')
  const rawParticipant = participant ?? key.participant ?? null
  identity.observe(key.remoteJid, key.remoteJidAlt)
  identity.observe(rawParticipant, key.participantAlt)
  const { chat, sender } = normalizeInboundKey(
    {
      remoteJid: key.remoteJid,
      remoteJidAlt: key.remoteJidAlt,
      participant: rawParticipant,
      participantAlt: key.participantAlt,
      fromMe: key.fromMe,
    },
    isGroup,
  )
  return {
    chatId: normalize(identity.canonical(chat) ?? chat),
    senderId: normalize(identity.canonical(sender) ?? sender),
    isGroup,
    rawParticipant,
  }
}
