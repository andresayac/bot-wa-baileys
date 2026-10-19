/**
 * The inbound pipeline of one bot: the provider's normalized event stream routed to
 * persistence, the Dispatcher, the hooks and the bot events.
 *
 * Messages/interactions: access lists → dedupe (`runInboundOnce`) → persistence →
 * groupMode → Dispatcher; the full order is documented on `Dispatcher.run`.
 */
import type { StoredMessage } from '../../store/IStore.js'
import type { DispatchContext } from '../Dispatcher.js'
import { callToInbound, RecentIds } from '../calls.js'
import { guardDownload } from '../mediaRefs.js'
import { receiveTimestamp } from '../ledger.js'
import type { CallEvent, ChatId, HookEvent, InboundEvent, InboundInteraction, InboundMessage, MessageContext, UserId } from '../types.js'
import type { ContextFactory } from './contextFactory.js'
import { admitAccess, admitHandoff } from './gates.js'
import { assertCoordinated, type BotKernel } from './kernel.js'
import type { Persistence } from './persistence.js'

/** The interaction projection a message-shaped context carries (`ctx.interaction`). */
export type InteractionInfo = { id: string; data: string; respondBy?: number }

/** Project an interaction (button/slash/callback) into the inbound message its context is built from. */
export function projectInteraction(it: InboundInteraction): { inbound: InboundMessage; interaction: InteractionInfo } {
  return {
    inbound: {
      ref: it.ref,
      chat: it.chat,
      senderInfo: it.senderInfo,
      from: it.from,
      sender: it.sender,
      chatId: it.chatId,
      senderId: it.senderId,
      isGroup: it.isGroup,
      isBroadcast: false,
      fromMe: false,
      type: 'buttons',
      body: it.data,
      timestamp: it.timestamp,
      mentions: [],
      raw: it.raw,
    },
    interaction: { id: it.interactionId, data: it.data, respondBy: it.respondBy },
  }
}

export class InboundPipeline {
  /** Call ids already handed to `CALL` triggers (fire once per call). */
  private readonly seenCalls = new RecentIds()

  constructor(
    private readonly k: BotKernel,
    private readonly contextFor: ContextFactory,
    private readonly persistence: Persistence,
  ) {}

  /** Subscribe to the provider's normalized event stream and route each kind. */
  attach(): () => void {
    return this.k.provider.onEvent((event: InboundEvent) => {
      const task = this.handleProviderEvent(event).catch((error) => this.k.events.error({ error }))
      this.k.inflightEvents.add(task)
      void task.finally(() => this.k.inflightEvents.delete(task))
    })
  }

  /** Route one provider event. */
  private async handleProviderEvent(event: InboundEvent): Promise<void> {
    const { state } = this.k
    switch (event.kind) {
      case 'message': {
        if (!state.acceptingInbound || event.message.fromMe) return
        const message = event.message
        if (!this.admitsSender(message)) return
        await this.runInboundOnce(event, () => this.handleInbound(message))
        return
      }
      case 'interaction': {
        if (!state.acceptingInbound) return
        const interaction = event.interaction
        if (!this.admitsSender(interaction)) return
        await this.runInboundOnce(event, () => this.handleInteraction(interaction))
        return
      }
      case 'connection': {
        const u = event.update
        state.connState = u.state
        this.k.coordination?.onConnection(u.state)
        this.k.events.emit('connection', u)
        if (typeof u.authPayload === 'string') this.k.events.emit('qr', u.authPayload)
        if (u.state === 'ready') this.k.events.emit('ready')
        return
      }
      case 'reaction': await this.dispatchHookEvent('reaction', event.reaction); return
      case 'poll-vote': await this.dispatchHookEvent('poll', event.vote); return
      case 'call': await this.handleCall(event.event); return
      case 'group': await this.dispatchHookEvent('group', event.event); return
      case 'presence': await this.dispatchHookEvent('presence', event.event); return
      case 'status':
        await this.k.messageLog.receipt(event.status)
        await this.dispatchHookEvent('status', event.status)
        return
    }
  }

  /**
   * Access gate (blacklist/whitelist) for a message or interaction. Runs BEFORE inbound dedupe,
   * so a blocked delivery is never recorded as seen (a redelivery after un-blocking is
   * processed), and before persistence, hooks and routing. Counts and debug-logs the drop.
   */
  admitsSender(ids: { chatId: ChatId; senderId: UserId }): boolean {
    return admitAccess(this.k, ids, 'inbound dropped by access list')
  }

  /**
   * Inbound idempotency gate: a redelivered message/interaction never reaches handlers twice.
   * `handle` resolving `false` (dropped unprocessed because the bot stopped) forgets the key.
   */
  private async runInboundOnce(event: InboundEvent, handle: () => Promise<boolean>): Promise<void> {
    // Durability: journal before dispatch (the in-memory deduper stays as a cheap first filter).
    const durable = this.k.durable
    if (durable) {
      const journaled = handle
      handle = () => durable.admit(event, journaled)
    }
    const dedupe = this.k.inboundDedupe
    if (!dedupe) { await handle(); return }
    await dedupe.run(event, handle, () => {
      this.k.counters.duplicateDropped()
      this.k.logger.debug({ kind: event.kind }, 'duplicate inbound event dropped')
    })
  }

  /** Persist and dispatch one inbound message; `false` when it was dropped because the bot stopped. */
  async handleInbound(inbound: InboundMessage, interaction?: InteractionInfo): Promise<boolean> {
    const { config, namespace } = this.k
    // The access lists already admitted this sender (admitsSender, before dedupe).
    this.k.counters.inbound()
    const timestamp = receiveTimestamp(inbound.timestamp)
    const stored: StoredMessage = {
      ref: inbound.ref,
      chatId: inbound.chatId,
      senderId: inbound.senderId,
      ...namespace,
      timestamp,
      type: inbound.type,
      body: inbound.body,
      fromMe: inbound.fromMe,
      direction: 'inbound',
      status: 'received',
      quoted: inbound.quoted?.ref,
      ...(inbound.location ? { location: { ...inbound.location } } : {}),
      raw: config.persistRaw ? inbound.raw : undefined,
    }
    await Promise.all([
      this.persistence.persistChat({
        id: inbound.chatId,
        ...namespace,
        kind: inbound.chat.kind,
        name: inbound.chat.name,
        lastMessageAt: timestamp,
        updatedAt: timestamp,
        raw: config.persistRaw ? inbound.chat.platformData : undefined,
      }),
      this.persistence.persistContact({
        id: inbound.senderId,
        ...namespace,
        name: inbound.senderInfo.displayName,
        username: inbound.senderInfo.username,
        phoneNumber: typeof inbound.senderInfo.platformData?.phoneNumber === 'string'
          ? inbound.senderInfo.platformData.phoneNumber
          : undefined,
        updatedAt: timestamp,
        raw: config.persistRaw ? inbound.senderInfo.platformData : undefined,
      }),
      this.k.store.saveMessage(stored),
    ])
    return this.processMessage(inbound, interaction)
  }

  /** Project an interaction (button/slash/callback) into a message-shaped context. */
  async handleInteraction(it: InboundInteraction): Promise<boolean> {
    const { inbound, interaction } = projectInteraction(it)
    return this.handleInbound(inbound, interaction)
  }

  /**
   * The context of a real inbound message (with the seams only a received message has:
   * read receipts, deletes, media download, interaction acknowledgement). Also used to
   * rebuild a conversation's recorded answer on the replica that takes the chat.
   */
  contextOf(inbound: InboundMessage, interaction?: InteractionInfo): MessageContext {
    const { provider } = this.k
    return this.contextFor(inbound, {
      markRead: async (ref) => { assertCoordinated(this.k); await provider.markRead?.([ref]) },
      deleteMessage: async (ref) => { assertCoordinated(this.k); await provider.deleteMessage?.(ref) },
      downloadMedia: guardDownload(provider.downloadMedia ? (ref) => provider.downloadMedia!(ref) : undefined),
      acknowledgeInteraction: provider.acknowledgeInteraction
        ? (id, text) => provider.acknowledgeInteraction!(id, { text })
        : undefined,
      interaction,
    })
  }

  /** `false` only when the message was dropped unprocessed because the bot stopped. */
  private async processMessage(inbound: InboundMessage, interaction?: InteractionInfo): Promise<boolean> {
    const { provider, config } = this.k
    const ctx = this.contextOf(inbound, interaction)

    // Group mode filter.
    if (ctx.isGroup && config.groupMode && config.groupMode !== 'all') {
      const prefix = config.commandPrefix ?? '/'
      if (config.groupMode === 'mentions') {
        const self = provider.selfId ?? null
        const mentioned = self ? ctx.mentions.includes(self) : ctx.mentions.length > 0
        if (!mentioned) return true
      }
      if (config.groupMode === 'commands' && !ctx.body.startsWith(prefix)) return true
    }

    this.k.logger.debug({ from: ctx.from, type: ctx.type }, 'dispatching message')
    return this.k.dispatcher.dispatch(ctx as unknown as DispatchContext)
  }

  /**
   * Run hooks + emit for a provider event: `before` → `after` → `bot.on(event)`. A `before`
   * hook that aborts (or skips `next()`) suppresses the after-hooks and the event.
   * Resolves `false` if a before-hook aborted or it threw.
   */
  private async dispatchHookEvent(event: HookEvent, payload: unknown): Promise<boolean> {
    const { hooks } = this.k
    try {
      // Same contract as 'message' / 'send': an aborted event runs no after-hook and is not emitted.
      if (!(await hooks.runBefore(event, payload as { abort(): void }))) return false
      await hooks.runAfter(event, payload)
      this.k.events.emit(event, payload)
      return true
    } catch (error) {
      try { await hooks.runError(event, payload, error) } catch { /* no error hook registered */ }
      this.k.events.error({ error })
      return false
    }
  }

  /**
   * A call event. Access lists (blacklist / whitelist) and human handoff gate it first, like a
   * message: a blocked call runs no `'call'` hooks, emits no `'call'` event and reaches no `CALL`
   * trigger (it is counted in `metrics().dropped` and debug-logged). An admitted call runs the
   * hooks + `'call'` event, then — only when a `CALL` type trigger is registered — the first event
   * of each call id is projected into a `type: 'call'` context and dispatched to the type-trigger
   * matchers. Group calls follow `groupMode`: anything but `'all'` keeps them away from triggers.
   */
  private async handleCall(call: CallEvent): Promise<void> {
    const { config } = this.k
    const inbound = callToInbound(call)
    if (!admitAccess(this.k, inbound, 'call dropped by access list')) return
    if (!admitHandoff(this.k, inbound, 'call dropped: chat handed off')) return
    const proceed = await this.dispatchHookEvent('call', call)
    if (!proceed || !this.k.state.acceptingInbound || !this.k.dispatcher.hasTypeMatcher('call')) return
    // A call can never mention the bot nor be a command: a restrictive groupMode keeps group calls out.
    if (call.isGroup === true && config.groupMode && config.groupMode !== 'all') return
    if (call.id && !this.seenCalls.add(call.id)) return
    const ctx = this.contextFor(inbound)
    ctx.call = call
    await this.k.dispatcher.dispatchEvent(ctx as unknown as DispatchContext)
  }
}
