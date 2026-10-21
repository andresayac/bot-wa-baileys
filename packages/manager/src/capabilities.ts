/**
 * Optional bot capabilities the manager and its REST API use when present.
 * A core `Bot` has all of them; a `{ start, stop }` stub has none (the API
 * answers `501 NOT_SUPPORTED` for the missing ones).
 */

import type { CompiledFlow, ConversationSnapshot, FlowTriggerOptions, FlowTriggerTarget, OutboundContent, RegisteredFlowInfo, StoredMessage } from '@botmesh/core'
import type { ManageableBot } from './BotManager.js'

/** Everything the manager may call on a bot beyond `start`/`stop`. */
export interface BotCapabilities {
  sendTo(chatId: string, content: string | OutboundContent): Promise<unknown>
  registerFlow(flow: CompiledFlow): string
  replaceFlow(id: string, flow: CompiledFlow): void
  unregisterFlow(id: string): boolean
  hasFlow(id: string): boolean
  listFlows(): RegisteredFlowInfo[]
  /** Core `Bot.triggerFlow()` resolves (a wrapper over `bot.trigger()`); a sync stub may return directly. */
  triggerFlow(id: string, target: FlowTriggerTarget, opts?: FlowTriggerOptions): boolean | Promise<boolean>
  listConversations(): ConversationSnapshot[]
  abortConversation(key: string): boolean
  getStore(): { getMessagesByChat(chatId: string, limit?: number): Promise<StoredMessage[]> }
}

/** Return the bound method `name` of `bot`, or `undefined` when the bot lacks it. */
export function capability<K extends keyof BotCapabilities>(bot: ManageableBot | undefined, name: K): BotCapabilities[K] | undefined {
  if (!bot) return undefined
  const fn = (bot as unknown as Record<string, unknown>)[name]
  return typeof fn === 'function' ? (fn.bind(bot) as BotCapabilities[K]) : undefined
}

/** Error thrown when a bot lacks a capability an operation needs. */
export class CapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`bot does not support ${capability}()`)
    this.name = 'CapabilityError'
  }
}

/** Like {@link capability} but throws {@link CapabilityError} when missing. */
export function requireCapability<K extends keyof BotCapabilities>(bot: ManageableBot | undefined, name: K): BotCapabilities[K] {
  const fn = capability(bot, name)
  if (!fn) throw new CapabilityError(name)
  return fn
}
