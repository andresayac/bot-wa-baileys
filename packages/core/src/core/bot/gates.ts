/**
 * Admission gates shared by every inbound path of one bot (messages, interactions, calls,
 * `bot.trigger()`, the Dispatcher's handoff gate): the access lists (blacklist /
 * whitelist) and human handoff, each with its drop accounting (`metrics().dropped`) and,
 * when the caller names one, its debug log line. Decides admission only; no routing.
 */
import { checkAccess } from '../../gates/accessList.js'
import type { HandoffRegistry } from '../../gates/handoff.js'
import type { ChatId, UserId } from '../types.js'
import type { BotKernel } from './kernel.js'

/**
 * Access-list gate: `true` when the subject is allowed. A refused one is counted as
 * `dropped.blocked` and, with `log`, debug-logged as `{ gate, chatId, senderId }`.
 */
export function admitAccess(
  k: Pick<BotKernel, 'access' | 'counters' | 'logger'>,
  ids: { chatId: ChatId; senderId: UserId },
  log?: string,
): boolean {
  const gate = checkAccess(k.access.blacklist, k.access.whitelist, ids)
  if (gate === 'allowed') return true
  k.counters.blockedDropped()
  if (log !== undefined) k.logger.debug({ gate, chatId: ids.chatId, senderId: ids.senderId }, log)
  return false
}

/**
 * Handoff gate: `true` unless the chat is handed off to a human (allowed commands pass).
 * A refused subject is counted as `dropped.handoff` and, with `log`, debug-logged as
 * `{ gate: 'handoff', chatId, senderId }`.
 */
export function admitHandoff(
  k: Pick<BotKernel, 'handoffs' | 'counters' | 'logger'>,
  subject: Parameters<HandoffRegistry['admits']>[0] & { sender?: UserId },
  log?: string,
): boolean {
  if (k.handoffs.admits(subject)) return true
  k.counters.handoffDropped()
  if (log !== undefined) k.logger.debug({ gate: 'handoff', chatId: subject.from, senderId: subject.sender }, log)
  return false
}
