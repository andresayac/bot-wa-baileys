/**
 * toCallEvent — normalize a Baileys `WACallEvent` into a transport-neutral
 * {@link CallEvent} whose caller is the SAME canonical id their messages carry.
 *
 * Baileys 7 reports a call's `from` as `infoChild.attrs.from || call-creator`:
 * often a (device-qualified) LID, with the PN twin in `callerPn` only sometimes.
 * Emitting it raw would key a `flow(CALL)` conversation under the LID while the
 * caller's text answers arrive keyed by the PN (see {@link IdentityStore}).
 */

import type { WACallEvent } from '@whiskeysockets/baileys'
import type { CallEvent } from '@bot-wa/core'
import { normalize, isPnUser } from './jid.js'
import type { IdentityStore } from './identity.js'

/** Cap on remembered group calls (one entry per call in progress). */
const CALL_GROUPS_MAX = 500
/** Statuses after which Baileys forgets a call (mirrors its own offer cache). */
const FINAL_STATUSES = new Set(['reject', 'accept', 'timeout', 'terminate'])

/**
 * @param identity learns the `from`/`callerPn` pairing and canonicalises the caller.
 * @param groups   call id → group JID. Baileys only sends `groupJid` on the offer;
 *                 this keeps later updates of a group call in the same chat.
 */
export function toCallEvent(call: WACallEvent, identity: IdentityStore, groups: Map<string, string>): CallEvent {
  identity.observe(call.from, call.callerPn)
  const pn = call.callerPn ? normalize(call.callerPn) : undefined
  const from = pn && isPnUser(pn) ? pn : normalize(identity.canonical(call.from ?? ''))

  if (call.groupJid) {
    groups.set(call.id, normalize(call.groupJid))
    if (groups.size > CALL_GROUPS_MAX) {
      const oldest = groups.keys().next()
      if (!oldest.done) groups.delete(oldest.value)
    }
  }
  const group = groups.get(call.id)
  if (FINAL_STATUSES.has(String(call.status))) groups.delete(call.id)

  const event: CallEvent = {
    id: call.id,
    from,
    status: String(call.status),
    // A group call whose group is unknown (its offer was never seen) falls back to the DM.
    chatId: group ?? from,
    isGroup: group !== undefined,
  }
  if (call.isVideo !== undefined) event.isVideo = call.isVideo
  if (call.offline !== undefined) event.offline = call.offline
  return event
}
