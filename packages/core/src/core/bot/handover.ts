/**
 * Conversation hand-over between replicas — the Bot side of `coordination.handover`
 * (internal). Built only when `BotConfig.coordination` is set.
 *
 * - The {@link AnswerCodec} the conversation runtime uses to record the answer of a flow
 *   step's first wait in its checkpoint (`FlowCheckpoint.answer`) and to rebuild it as a
 *   full `MessageContext` on the replica that takes the chat: by inbox record id when
 *   durability journals the message, else the encoded message itself (bounded by
 *   `handover.maxAnswerBytes`). The before-hooks are not run again: the body/lang they
 *   produced travel with the answer.
 * - The runtime's resolved hand-over policy ({@link runtimeHandover}).
 *
 * No routing, no transport concepts: the message is the provider's normalized
 * `InboundMessage`, encoded opaquely.
 */
import type { AnswerCodec, RuntimeHandover } from '../../conversations/handover.js'
import { DEFAULT_HANDOVER_TTL_MS } from '../../conversations/handover.js'
import type { RuntimeMessage } from '../../conversations/ConversationRuntime.js'
import type { ConversationHandoverConfig, ConversationHandoverEvent } from '../../coordination/types.js'
import { decodeInbound, decodeJson, encodeJson, encodedSize } from '../../durability/codec.js'
import type { JsonValue } from '../../durability/types.js'
import { parseTimerDuration } from '../../utils/timers.js'
import type { CheckpointAnswer } from '../provider.js'
import type { InboundMessage, MessageContext } from '../types.js'
import type { ContextFactory } from './contextFactory.js'
import { projectInteraction, type InboundPipeline, type InteractionInfo } from './inbound.js'
import type { BotKernel } from './kernel.js'

/** Default `handover.maxAnswerBytes`. */
export const DEFAULT_MAX_ANSWER_BYTES = 16_384

export interface HandoverBridge {
  readonly answers: AnswerCodec
  /** Wrap the bot's context factory so a context can be traced back to the message it was built from. */
  track(factory: ContextFactory): ContextFactory
}

interface Origin { inbound: InboundMessage; interaction?: InteractionInfo }

/**
 * @param k        the kernel (read lazily: `durable` is wired after the runtime)
 * @param inbound  late-bound inbound pipeline (rebuilds contexts like a received message)
 */
export function createHandoverBridge(
  k: Pick<BotKernel, 'durable'>,
  config: ConversationHandoverConfig | undefined,
  inbound: () => InboundPipeline,
): HandoverBridge {
  const origins = new WeakMap<object, Origin>()
  const maxAnswerBytes = config?.maxAnswerBytes ?? DEFAULT_MAX_ANSWER_BYTES

  const answers: AnswerCodec = {
    capture(rctx, causeId) {
      const origin = origins.get(rctx)
      if (!origin) return undefined
      const ctx = rctx as unknown as MessageContext
      // What the before('message') hooks made of it (a voice transcript, a detected language).
      const seen = {
        ...(typeof ctx.body === 'string' && ctx.body !== origin.inbound.body ? { body: ctx.body } : {}),
        ...(typeof ctx.type === 'string' && ctx.type !== origin.inbound.type ? { type: ctx.type } : {}),
        ...(typeof ctx.lang === 'string' ? { lang: ctx.lang } : {}),
      }
      // Durability: the journal holds the message; the checkpoint only points at it.
      if (k.durable && causeId !== undefined) return { inboundId: causeId, ...seen }
      if (maxAnswerBytes <= 0) return undefined
      const { raw: _raw, ...message } = origin.inbound
      const encoded = encodeJson(message)
      if (encoded === undefined || encodedSize(encoded) > maxAnswerBytes) return undefined
      return { message: encoded, ...(origin.interaction ? { interaction: { ...origin.interaction } } : {}), ...seen }
    },

    async rehydrate(answer: CheckpointAnswer) {
      let message: InboundMessage | undefined
      let interaction: InteractionInfo | undefined
      if (answer.inboundId !== undefined) {
        const record = await k.durable?.inbox.get(answer.inboundId)
        if (!record) return undefined
        const event = decodeInbound(record.payload)
        if (event.kind === 'message') message = event.message
        else if (event.kind === 'interaction') ({ inbound: message, interaction } = projectInteraction(event.interaction))
      } else if (answer.message !== undefined) {
        message = decodeJson<InboundMessage>(answer.message as JsonValue)
        interaction = answer.interaction as InteractionInfo | undefined
      }
      if (!message || typeof message.chatId !== 'string' || typeof message.from !== 'string') return undefined
      const ctx = inbound().contextOf(message, interaction)
      if (answer.body !== undefined) ctx.body = answer.body
      if (answer.type !== undefined) ctx.type = answer.type as MessageContext['type']
      if (answer.lang !== undefined) ctx.lang = answer.lang
      return ctx as unknown as RuntimeMessage
    },
  }

  return {
    answers,
    track: (factory) => (message, extra) => {
      const ctx = factory(message, extra)
      origins.set(ctx, { inbound: message, ...(extra?.interaction ? { interaction: extra.interaction } : {}) })
      return ctx
    },
  }
}

/** The runtime's hand-over policy, or `undefined` when `coordination.handover` is not set. */
export function runtimeHandover(
  config: ConversationHandoverConfig | undefined,
  conversationTimeoutMs: number | undefined,
  onHandover: (event: ConversationHandoverEvent) => void,
): RuntimeHandover | undefined {
  if (!config) return undefined
  const ttlMs = config.ttl !== undefined
    ? parseTimerDuration(config.ttl, 'coordination.handover.ttl')
    : conversationTimeoutMs ?? DEFAULT_HANDOVER_TTL_MS
  return {
    flows: config.flows ?? 'drop',
    fallback: config.fallback ?? 'drop',
    ...(config.notifyMessage !== undefined ? { notifyMessage: config.notifyMessage } : {}),
    ttlMs: Math.max(1, ttlMs),
    onHandover,
  }
}
