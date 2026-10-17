/**
 * toCallEvent — project a Baileys `WACallEvent` into a transport-neutral
 * {@link CallEvent}.
 *
 * Identity is NOT resolved here: the provider canonicalises the caller (and
 * the group JID) through the same LID/PN rule as every other event
 * (`IdentityStore.resolve`, seeded from `getPNForLID` for bare LIDs) and passes
 * the results in. This module only adds the call-specific shape: which chat a
 * call belongs to across its status updates, and the `isVideo`/`offline` flags.
 */

import type { WACallEvent } from '@whiskeysockets/baileys'
import type { CallEvent, ChatId, UserId } from '@bot-wa/core'

/** Cap on remembered group calls (one entry per call in progress). */
const CALL_GROUPS_MAX = 500
/** Statuses after which Baileys forgets a call (mirrors its own offer cache). */
const FINAL_STATUSES = new Set(['reject', 'accept', 'timeout', 'terminate'])

/**
 * @param from    the caller's canonical id (same id their messages carry as `senderId`).
 * @param groupId the canonical group id when this update carries `groupJid` (Baileys only
 *                sends it on the offer).
 * @param groups  call id → group id, so later updates of a group call stay in the group.
 */
export function toCallEvent(
  call: WACallEvent,
  from: UserId,
  groupId: ChatId | undefined,
  groups: Map<string, ChatId>,
): CallEvent {
  if (groupId) {
    groups.set(call.id, groupId)
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
