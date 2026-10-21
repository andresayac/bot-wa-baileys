/**
 * attachInbox — keeps an {@link Inbox} in sync with a running `Bot`: every inbound
 * message (`bot.on('message')`) and every accepted send (`after('send')`) is projected
 * into its conversation. Projection failures go to the bot's `'error'` event and never
 * block the bot. Installed as a plugin, so detaching unregisters the hook and the
 * listener.
 */

import type { Bot, ChatId, MessageContext, PluginSpec } from '@botmesh/core'
import type { Inbox } from './inbox.js'

export interface AttachInboxOptions {
  /** Tenant the conversations belong to (default `'local'`, the `BotConfig.tenantId` default). */
  tenantId?: string
}

/** The plugin behind {@link attachInbox}. */
export function inboxProjectionPlugin(inbox: Inbox, options: AttachInboxOptions = {}): PluginSpec {
  const tenantId = options.tenantId ?? 'local'
  return {
    name: 'inbox-projection',
    version: '0.1.0',
    install(ctx) {
      const bot = ctx.bot
      const report = (error: unknown) => { bot.emit('error', error) }
      const onMessage = (msg: MessageContext): void => {
        inbox
          .projectMessage({ ref: msg.ref, chatId: msg.from, timestamp: Date.now(), type: msg.type, tenantId, direction: 'inbound' })
          .then(() => undefined, report)
      }
      bot.on('message', onMessage)
      ctx.onDispose(() => { bot.off('message', onMessage) })
      bot.after('send', async (payload: { chatId: ChatId }, next: () => Promise<void>) => {
        await next()
        await inbox
          .projectMessage({ ref: { id: '', chatId: payload.chatId }, chatId: payload.chatId, timestamp: Date.now(), type: 'text', tenantId, direction: 'outbound' })
          .then(() => undefined, report)
      })
    },
  }
}

/**
 * Project the bot's traffic into `inbox`. Returns the detach function.
 *
 * @example
 * ```ts
 * const inbox = new Inbox(new KvInboxStore(store.durability().kv))
 * const detach = attachInbox(bot, inbox, { tenantId: 'acme' })
 * ```
 */
export function attachInbox(bot: Bot, inbox: Inbox, options: AttachInboxOptions = {}): () => void {
  return bot.plug(inboxProjectionPlugin(inbox, options))
}
