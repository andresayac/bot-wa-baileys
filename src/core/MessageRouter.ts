/**
 * MessageRouter — extracted from Bot to keep Bot as a thin facade.
 *
 * Responsibilities:
 *   - Receive raw Baileys messages from the provider.
 *   - Build MessageContext.
 *   - Run before-hooks pipeline.
 *   - Route to active flows (FlowEngine).
 *   - Route to pattern handlers (when()).
 *   - Route to type handlers (onImage, onAudio, ...).
 *   - Route to catch-all (onMessage).
 *   - Run after-hooks pipeline.
 *   - Emit public 'message' event.
 *   - Handle errors via error-hooks.
 */

import type { proto, WAMessage } from '@whiskeysockets/baileys'
import type {
  ChatId,
  HookEvent,
  MessageContext,
  MessageType,
  SentMessage,
} from './types.js'
import type { HookSystem } from '../hooks/HookSystem.js'
import type { FlowEngine } from '../flows/FlowEngine.js'
import type { IStore } from '../store/IStore.js'
import type { BaileysProvider } from '../provider/BaileysProvider.js'
import { buildMessageContext } from './context.js'
import { toMediaUpload, makeSticker, transcodeToOpus } from '../media/MediaProcessor.js'

type AnyHandler = (ctx: MessageContext) => void | Promise<void>

interface PatternHandler {
  id: string
  match: (ctx: MessageContext) => boolean
  handler: AnyHandler
}

export interface MessageRouterDeps {
  provider: BaileysProvider
  store: IStore
  hooks: HookSystem
  flows: FlowEngine
  tools: Record<string, any>
  config: {
    ignoreBroadcasts: boolean
    ignoreNewsletters: boolean
  }
  emit: (event: string, payload: any) => boolean
}

export class MessageRouter {
  private messageHandlers = new Map<string, AnyHandler[]>()
  private patternHandlers: PatternHandler[] = []
  private typeHandlers = new Map<MessageType, AnyHandler[]>()

  constructor(private deps: MessageRouterDeps) {}

  /* =========================================================================
   * REGISTRATION (called by Bot)
   * ====================================================================== */

  addPatternHandler(id: string, match: (ctx: MessageContext) => boolean, handler: AnyHandler): () => void {
    this.patternHandlers.push({ id, match, handler })
    return () => { this.patternHandlers = this.patternHandlers.filter((h) => h.id !== id) }
  }

  addMessageHandler(handler: AnyHandler): () => void {
    return this.addToList(this.messageHandlers, 'default', handler)
  }

  addTypeHandler(type: MessageType, handler: AnyHandler): () => void {
    return this.addToList(this.typeHandlers, type, handler)
  }

  private addToList(
    map: Map<string, AnyHandler[]> | Map<MessageType, AnyHandler[]>,
    key: string | MessageType,
    handler: AnyHandler
  ): () => void {
    const list = map.get(key as any) ?? []
    list.push(handler)
    map.set(key as any, list)
    return () => {
      const arr = map.get(key as any) ?? []
      map.set(key as any, arr.filter((h) => h !== handler))
    }
  }

  /* =========================================================================
   * WIRE TO PROVIDER
   * ====================================================================== */

  wireProviderEvents(): void {
    // Raw messages → build context, persist, run pipeline
    this.deps.provider.onTyped('rawMessage', async ({ message, type }) => {
      if (type !== 'notify') return
      if (message.key?.fromMe) return

      // Use remoteJidAlt (PN) if available, fallback to remoteJid (LID)
      const jid = (message.key as any)?.remoteJidAlt ?? message.key?.remoteJid ?? ''
      if (jid === 'status@broadcast') return
      if (this.deps.config.ignoreBroadcasts && jid.endsWith('@broadcast')) return
      if (this.deps.config.ignoreNewsletters && jid.endsWith('@newsletter')) return

      await this.deps.store.saveMessage(message)
      await this.processMessage(message)
    })

    // Persist chats/contacts/history from provider events
    this.deps.provider.onTyped('chatsUpsert', async (chats) => {
      for (const c of chats) await this.deps.store.upsertChat(c as any)
    })
    this.deps.provider.onTyped('chatsUpdate', async (updates) => {
      for (const u of updates) await this.deps.store.upsertChat(u as any)
    })
    this.deps.provider.onTyped('chatsDelete', async (jids) => {
      for (const j of jids) await this.deps.store.deleteChat(j)
    })
    this.deps.provider.onTyped('contactsUpsert', async (contacts) => {
      for (const c of contacts) await this.deps.store.upsertContact(c as any)
    })
    this.deps.provider.onTyped('contactsUpdate', async (updates) => {
      for (const u of updates) await this.deps.store.upsertContact(u as any)
    })
    this.deps.provider.onTyped('historySet', async (data) => {
      for (const c of data.chats) await this.deps.store.upsertChat(c as any)
      for (const c of data.contacts) await this.deps.store.upsertContact(c as any)
      for (const m of data.messages) await this.deps.store.saveMessage(m as any)
    })

    // Forward other events as hook events
    this.deps.provider.onTyped('reaction', (p) => this.dispatchHookEvent('reaction', p as any))
    this.deps.provider.onTyped('pollVote', (p) => this.dispatchHookEvent('poll', p as any))
    this.deps.provider.onTyped('call', (p) => this.dispatchHookEvent('call', p as any))
    this.deps.provider.onTyped('groupParticipants', (p) => this.dispatchHookEvent('group', p as any))
    this.deps.provider.onTyped('presenceUpdate', (p) => this.dispatchHookEvent('presence', p as any))
  }

  /* =========================================================================
   * MESSAGE PIPELINE
   * ====================================================================== */

  private async processMessage(message: WAMessage): Promise<void> {
    const ctx = buildMessageContext({
      rawMessage: message,
      tools: this.deps.tools,
      send: (jid, content, opts) => this.deps.provider.send(jid, content, opts),
      markRead: (k) => this.deps.provider.readMessages([k]).then(() => {}),
      presence: (s, jid) => { const sock = this.deps.provider.socket; if (sock) return sock.sendPresenceUpdate(s, jid); return Promise.resolve() },
      deleteMessage: (k) => this.deps.provider.send(k.remoteJid!, { delete: k }).then(() => {}),
      media: { toMediaUpload, makeSticker, transcodeToOpus },
    })
    // Provide media downloader
    ;(ctx as any).__mediaDownloader = (m: any) => this.deps.provider.downloadMedia(m)

    console.log(`[router] processing message from ${ctx.from} body="${ctx.body}" type=${ctx.type}`)

    try {
      // 1. Before hooks
      const proceed = await this.deps.hooks.runBefore('message', ctx as any)
      if (!proceed) {
        console.log(`[router] aborted by before-hook`)
        return
      }

      // 2. Active flow → route to FlowEngine
      if (this.deps.flows.hasActive(ctx.from)) {
        const handled = await this.deps.flows.processStep(ctx, {
          send: async (text) => { await ctx.text(text) },
          end: () => this.deps.flows.end(ctx.from),
        })
        if (handled) {
          await this.deps.hooks.runAfter('message', ctx as any)
          return
        }
      }

      // 3. Pattern handlers (when) — first match wins (stops catch-all)
      let patternMatched = false
      for (const h of this.patternHandlers) {
        if (h.match(ctx)) {
          console.log(`[router] pattern handler matched, running...`)
          await h.handler(ctx)
          patternMatched = true
          if ((ctx as any).__aborted) {
            console.log(`[router] handler aborted pipeline`)
            await this.deps.hooks.runAfter('message', ctx as any)
            return
          }
          break  // first match wins — don't run multiple when() handlers
        }
      }

      // 3.5. Auto-match registered flows (bot.use(flow)) if no pattern matched
      if (!patternMatched && !this.deps.flows.hasActive(ctx.from)) {
        const matchedFlow = this.deps.flows.find(ctx.body)
        if (matchedFlow) {
          console.log(`[router] auto-matched flow: ${matchedFlow.id}`)
          const handled = await this.deps.flows.runFromMatch(ctx, {
            send: async (text) => { await ctx.text(text) },
            end: () => this.deps.flows.end(ctx.from),
          })
          if (handled) patternMatched = true
        }
      }

      // 4. Type handlers (onImage, onAudio, ...) — stop if aborted
      const types = this.typeHandlers.get(ctx.type) ?? []
      for (const handler of types) {
        await handler(ctx)
        if ((ctx as any).__aborted) {
          await this.deps.hooks.runAfter('message', ctx as any)
          return
        }
      }

      // 5. Catch-all (onMessage) — only if no pattern matched
      if (!patternMatched) {
        const all = this.messageHandlers.get('default') ?? []
        for (const handler of all) {
          await handler(ctx)
          if ((ctx as any).__aborted) break
        }
      }

      // 6. After hooks
      await this.deps.hooks.runAfter('message', ctx as any)

      // 7. Public event
      this.deps.emit('message', ctx)
    } catch (error) {
      console.error(`[router] ERROR processing message:`, error)
      await this.deps.hooks.runError('message', ctx as any, error)
      this.deps.emit('error', { error, ctx })
    }
  }

  private async dispatchHookEvent(event: HookEvent, ctx: any): Promise<void> {
    try {
      await this.deps.hooks.runBefore(event, ctx)
      await this.deps.hooks.runAfter(event, ctx)
      this.deps.emit(event as string, ctx)
    } catch (error) {
      await this.deps.hooks.runError(event, ctx, error)
      this.deps.emit('error', { error, ctx })
    }
  }
}