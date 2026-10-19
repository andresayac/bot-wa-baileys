/**
 * Builds the {@link MessageContext} of an inbound message — real, a projected call or the
 * synthetic one of `bot.trigger()` — wired to every seam the bot offers (sends through
 * the hook pipeline, typing, handoff, `ctx.user`, i18n, pacing, edits, streaming,
 * native forms).
 */
import { buildMessageContext } from '../context.js'
import type { BuildContextDeps } from '../provider.js'
import type { ChatId, InboundMessage, MessageContext } from '../types.js'
import type { HandoffOptions } from '../../gates/handoff.js'
import type { BotKernel } from './kernel.js'
import type { OutboundPipeline } from './outbound.js'

/** `extra` adds the seams that only make sense for a real inbound message. */
export type ContextFactory = (inbound: InboundMessage, extra?: Partial<BuildContextDeps>) => MessageContext

export function createContextFactory(
  k: BotKernel,
  out: OutboundPipeline,
  /** Late-bound `bot.handoff` (`ctx.handoff()`). */
  handoff: (chatId: ChatId, opts?: HandoffOptions) => Promise<boolean>,
): ContextFactory {
  return (inbound, extra = {}) => buildMessageContext({
    inbound,
    tools: k.tools,
    send: (chatId, content, opts) => out.send(chatId, content, opts, chatId === inbound.from ? 'ctx' : 'api'),
    canRenderForm: k.provider.canRenderForm ? (d, o) => k.provider.canRenderForm!(d, o) : undefined,
    typing: (chatId, state) => out.typing(chatId, state),
    handoff: (chatId, opts) => handoff(chatId, opts),
    user: k.users.for(inbound.senderId),
    i18n: k.i18n,
    ...out.messagingDeps(),
    ...out.streamDeps(),
    ...extra,
  })
}
