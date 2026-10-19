/**
 * Binds a {@link DurableEngine} to a Bot's internals (internal). Kept out of Bot.ts so the
 * Bot only holds a nullable engine and a handful of `if (durable)` seams.
 */

import type { ChatId, InboundInteraction, InboundMessage, IProvider, UserId } from '../core/provider.js'
import type { StoreNamespace } from '../store/NamespacedStore.js'
import type { HookSystem } from '../hooks/HookSystem.js'
import type { MessageLog } from '../core/ledger.js'
import { DurableEngine } from './engine.js'
import { SendDeferredError } from './errors.js'
import type { DurabilityConfig } from './types.js'

export { DurableEngine }
export type { DurabilityControl } from './engine.js'

/** The Bot internals the engine is wired to. */
export interface DurabilityHost {
  logger: { debug(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void }
  namespace: StoreNamespace
  hooks: HookSystem
  messageLog: MessageLog
  provider: IProvider
  persistRaw: boolean
  admits(ids: { chatId: ChatId; senderId: UserId }): boolean
  handleInbound(message: InboundMessage): Promise<boolean>
  handleInteraction(interaction: InboundInteraction): Promise<boolean>
  emit(event: string, payload: unknown): void
  reportError(error: unknown): void
}

/** `null` when `config` is `undefined` (durability off). @throws {ConfigValidationError} */
export function createDurability(config: DurabilityConfig | undefined, host: DurabilityHost): DurableEngine | null {
  if (config === undefined) return null
  return new DurableEngine(config, {
    logger: host.logger,
    namespace: host.namespace,
    replay: async (event) => {
      // Same gates as a live event; a sender blocked meanwhile is acknowledged and dropped.
      if (event.kind === 'message') {
        if (event.message.fromMe || !host.admits(event.message)) return true
        return host.handleInbound(event.message)
      }
      if (event.kind === 'interaction') {
        if (!host.admits(event.interaction)) return true
        return host.handleInteraction(event.interaction)
      }
      return true
    },
    transportSend: (chatId, content, options) => host.provider.send(chatId, content, options),
    beforeSend: (payload) => host.hooks.runBefore('send', payload as typeof payload & { abort(): void }),
    afterSend: async (payload, result) => {
      await host.hooks.runAfter('send', payload)
      await host.messageLog.outbound({
        ref: result.ref,
        chatId: payload.chatId,
        content: payload.content,
        options: payload.options,
        status: 'sent',
        raw: host.persistRaw ? result.raw : undefined,
      })
    },
    emit: host.emit,
    reportError: host.reportError,
  })
}

/** A durable send handed to the background sweeper (not a failure). */
export function isSendDeferred(error: unknown): error is SendDeferredError {
  return error instanceof SendDeferredError
}

