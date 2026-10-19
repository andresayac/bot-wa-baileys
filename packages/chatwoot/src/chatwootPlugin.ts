/**
 * chatwootPlugin — mirror a bot's chats into a Chatwoot inbox (API channel) and let
 * Chatwoot agents take over through the core human-handoff API.
 *
 * Bot → Chatwoot (per chat, in order):
 *  - every inbound message (`before('message')`, so also while handed off) is posted as an
 *    `incoming` message; every bot send (`after('send')`) as `outgoing`;
 *  - the chat is mapped to one Chatwoot contact (`identifier` = chatId) and one
 *    conversation; the mapping lives in the bot store (cursor API) and survives restarts;
 *  - `'handoff'` → conversation set to `open`, `labels.handoff` added, private note;
 *  - `'resume'` → conversation `resolved` (unless Chatwoot itself resolved it),
 *    `labels.handoff` removed and `labels.resume` added.
 *
 * Chatwoot → bot (webhook, authenticated with a token and/or HMAC):
 *  - an agent's public reply → `bot.sendTo(chatId, …)` (attachments by URL), after
 *    `bot.handoff(chatId)` when `autoHandoff` (default) and the chat is not handed off;
 *  - conversation resolved → `bot.resume(chatId)` (`resumeOnResolve`, default).
 *
 * The plugin never parses chat ids; it only uses them as opaque keys/identifiers.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { chatwootPlugin } from '@bot-wa/chatwoot'
 *
 * const chatwoot = chatwootPlugin({
 *   baseUrl: 'https://app.chatwoot.com',
 *   apiKey: process.env.CHATWOOT_TOKEN!,
 *   accountId: 1,
 *   inboxId: 2,
 *   webhookToken: process.env.CHATWOOT_WEBHOOK_TOKEN!,
 *   labels: { handoff: ['humano'] },
 * })
 * bot.plug(chatwoot)
 * createServer(chatwoot.webhookHandler()).listen(3001) // register https://…/?token=… in Chatwoot
 * ```
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ChatId,
  HandoffEvent,
  MessageContext,
  OutboundContent,
  PluginSpec,
  ResumeEvent,
} from '@bot-wa/core'
import { ChatwootApiError, ChatwootClient, normalizeBaseUrl, type ChatwootHttpOptions } from './client.js'
import { inboundText, outboundText } from './format.js'
import { ChatwootMapping, memoryKeyValue, storeKeyValue, type ChatwootChatLink, type ChatwootKeyValue } from './mapping.js'
import { header, verifyWebhook, type HeaderBag } from './webhookAuth.js'

/** Contact fields the host may supply for a new Chatwoot contact. */
export interface ChatwootContactInfo {
  name?: string
  phoneNumber?: string
  email?: string
  customAttributes?: Record<string, unknown>
}

export interface ChatwootPluginConfig {
  /** Chatwoot base URL, e.g. `https://app.chatwoot.com`. HTTPS unless `http.allowHttp`. */
  baseUrl: string
  /** User (or platform) access token, sent as `api_access_token`. */
  apiKey: string
  accountId: number | string
  /** Id of the API-channel inbox the bot's chats live in. */
  inboxId: number
  /** Shared webhook token (query `?token=`, `x-chatwoot-token` or `Authorization: Bearer`). */
  webhookToken?: string
  /** HMAC-SHA256 secret for `x-chatwoot-signature` (raw body, optional `x-chatwoot-timestamp`). */
  webhookSecret?: string
  /** Allowed clock skew for timestamped signatures, seconds. Default 300. */
  webhookToleranceSec?: number
  /** Accept unauthenticated webhooks. Only for a webhook endpoint that is not reachable from outside. */
  insecureNoWebhookAuth?: boolean
  /** Hand the chat off when an agent replies in Chatwoot. Default `true`. */
  autoHandoff?: boolean
  /** `bot.resume()` when the Chatwoot conversation is resolved. Default `true`. */
  resumeOnResolve?: boolean
  /** Resolve the Chatwoot conversation when the bot resumes for another reason. Default `true`. */
  resolveOnResume?: boolean
  /**
   * Private note posted when the bot hands a chat off (`{{reason}}` placeholder);
   * `false` disables it. Default `'🤖 → 👤 Handoff: {{reason}}'`.
   */
  handoffNote?: string | false
  /** Mirror inbound messages. Default `true`. */
  syncInbound?: boolean
  /** Mirror the bot's own sends. Default `true`. */
  syncOutbound?: boolean
  /** `'all'` (default) mirrors every chat; `'handoff'` only chats that are handed off. */
  syncMode?: 'all' | 'handoff'
  labels?: {
    /** Added on handoff, removed on resume. */
    handoff?: string[]
    /** Added on resume. */
    resume?: string[]
    /** Labels to add for an inbound message (e.g. map message types/intents to labels). */
    message?: (ctx: MessageContext) => string[] | undefined | void
  }
  /** Data for a NEW contact (default name: the sender's display name, else the chat id). */
  contact?: (chatId: ChatId, ctx?: MessageContext) => ChatwootContactInfo | undefined
  /** Forward agent attachments to the chat as media by URL. Default `true`. */
  forwardAttachments?: boolean
  /** HTTP transport knobs (inject `fetch`/`resolver` in tests, allow private hosts). */
  http?: ChatwootHttpOptions
  /** Custom mapping persistence. Default: the bot store's cursor API (memory fallback). */
  storage?: ChatwootKeyValue
  /** Clock (epoch ms), used for signature timestamps. Default `Date.now`. */
  now?: () => number
  /** Sync / webhook processing errors. Default: logged as warnings. */
  onError?: (error: unknown, context: string) => void
}

/** A framework-neutral webhook request. `rawBody` must be the exact bytes received. */
export interface ChatwootWebhookRequest {
  rawBody: string | Uint8Array
  headers: HeaderBag
  query?: URLSearchParams | Record<string, string | undefined>
}

export interface ChatwootWebhookResponse {
  status: number
  body: string
}

/** Public surface of the plugin object (also exposed as `ctx.tools.chatwoot`). */
export interface ChatwootApi {
  readonly client: ChatwootClient
  /** Verify + process one webhook delivery. Never throws. */
  handleWebhook(req: ChatwootWebhookRequest): Promise<ChatwootWebhookResponse>
  /** Node `http` handler wrapping {@link handleWebhook} (POST only, 1 MiB body limit by default). */
  webhookHandler(opts?: { maxBytes?: number }): (req: IncomingMessage, res: ServerResponse) => void
  /** Chatwoot conversation id mapped to `chatId`, if any. */
  conversationOf(chatId: ChatId): Promise<number | undefined>
  /** Chat mapped to a Chatwoot conversation id, if any. */
  chatOf(conversationId: number): Promise<ChatId | undefined>
  /** Add labels to the chat's conversation (creating it if needed). */
  addLabels(chatId: ChatId, labels: string[]): Promise<void>
  /** Remove labels from the chat's conversation (no-op when it is not mapped). */
  removeLabels(chatId: ChatId, labels: string[]): Promise<void>
  /** Resolve once every queued sync task has finished (tests, graceful shutdown). */
  flush(): Promise<void>
}

export type ChatwootPlugin = PluginSpec & ChatwootApi

/** Minimal bot surface the bridge needs (the scoped plugin bot satisfies it). */
interface BotLike {
  sendTo(chatId: ChatId, content: string | OutboundContent): Promise<unknown>
  handoff(chatId: ChatId, opts?: { reason?: string; meta?: Record<string, unknown> }): Promise<boolean>
  resume(chatId: ChatId, opts?: { reason?: string }): Promise<boolean>
  isHandedOff(chatId: ChatId): boolean
}

interface Logger { warn(...a: unknown[]): void; debug(...a: unknown[]): void }

const RESOLVED_REASON = 'chatwoot:resolved'
const AGENT_REASON = 'chatwoot:agent'
const MAX_OWN_IDS = 2000
const MAX_SEEN_AGENT_IDS = 5000

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** Build the plugin. `bot.plug(chatwootPlugin({...}))`. */
export function chatwootPlugin(config: ChatwootPluginConfig): ChatwootPlugin {
  if (!config || typeof config !== 'object') throw new Error('chatwootPlugin: config is required')
  normalizeBaseUrl(config.baseUrl)
  if (typeof config.apiKey !== 'string' || config.apiKey === '') throw new Error('Invalid chatwoot config.apiKey: expected a non-empty string')
  if (num(config.accountId) === undefined) throw new Error('Invalid chatwoot config.accountId')
  if (num(config.inboxId) === undefined) throw new Error('Invalid chatwoot config.inboxId')
  const hasToken = typeof config.webhookToken === 'string' && config.webhookToken !== ''
  const hasSecret = typeof config.webhookSecret === 'string' && config.webhookSecret !== ''
  if (!hasToken && !hasSecret && !config.insecureNoWebhookAuth) {
    throw new Error('chatwootPlugin: set webhookToken and/or webhookSecret (or insecureNoWebhookAuth: true for a private endpoint)')
  }

  const client = new ChatwootClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, accountId: config.accountId, http: config.http })
  const inboxId = num(config.inboxId)!
  const now = config.now ?? Date.now
  const auth = {
    token: hasToken ? config.webhookToken : undefined,
    secret: hasSecret ? config.webhookSecret : undefined,
    toleranceSec: config.webhookToleranceSec,
    now,
  }

  let bot: BotLike | undefined
  let logger: Logger | undefined
  let mapping = new ChatwootMapping(config.storage ?? memoryKeyValue())

  const queues = new Map<ChatId, Promise<void>>()
  const inflight = new Set<Promise<unknown>>()
  /** Contents the plugin itself sends on behalf of an agent (never mirrored back). */
  const agentContents = new WeakSet<object>()
  /** Chatwoot message ids created by this plugin (echo suppression). */
  const ownIds = new Set<number>()
  /** `${conversationId}\n${content}` → outgoing POSTs in flight (webhook may beat the response). */
  /** Agent message ids already relayed to the chat (redelivery / replay suppression). */
  const seenAgentIds = new Set<number>()
  const pendingEchoes = new Map<string, number>()

  const report = (error: unknown, context: string) => {
    if (config.onError) {
      try { config.onError(error, context) } catch { /* never let reporting throw */ }
    } else {
      logger?.warn({ err: error, context }, 'chatwoot: sync failed')
    }
  }

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.then(() => inflight.delete(p), () => inflight.delete(p))
    return p
  }

  /** Run `fn` in the chat's FIFO (so contact/conversation creation never races). */
  const enqueue = (chatId: ChatId, context: string, fn: () => Promise<void>): Promise<void> => {
    const prev = queues.get(chatId) ?? Promise.resolve()
    const run = prev.then(fn).catch((error) => report(error, context))
    queues.set(chatId, run)
    void run.then(() => { if (queues.get(chatId) === run) queues.delete(chatId) })
    return track(run)
  }

  const rememberOwn = (id: number) => {
    ownIds.add(id)
    if (ownIds.size > MAX_OWN_IDS) ownIds.delete(ownIds.values().next().value as number)
  }

  const isGone = (error: unknown) => error instanceof ChatwootApiError && (error.status === 404 || error.status === 422)

  /**
   * Get (or create) the chat's contact + conversation. Call inside the chat's queue.
   * A stored contact that Chatwoot no longer knows (deleted by an agent, which also
   * deletes its conversations) is dropped and the chat re-linked once.
   */
  const ensureLink = async (chatId: ChatId, ctx?: MessageContext, relinked = false): Promise<ChatwootChatLink & { conversationId: number }> => {
    let link = await mapping.get(chatId)
    const stored = link !== undefined
    if (!link) {
      const info = config.contact?.(chatId, ctx) ?? {}
      const found = await client.findContactByIdentifier(chatId)
      const contact = found ?? await client.createContact({
        inboxId,
        identifier: chatId,
        name: info.name ?? (ctx?.isGroup ? ctx.chat?.name : ctx?.senderInfo?.displayName ?? ctx?.pushName) ?? chatId,
        ...(info.phoneNumber !== undefined ? { phoneNumber: info.phoneNumber } : {}),
        ...(info.email !== undefined ? { email: info.email } : {}),
        ...(info.customAttributes !== undefined ? { customAttributes: info.customAttributes } : {}),
      })
      link = { contactId: contact.id, ...(contact.sourceId !== undefined ? { sourceId: contact.sourceId } : {}) }
      await mapping.set(chatId, link)
    }
    if (link.conversationId === undefined) {
      let conversationId: number
      try {
        let sourceId = link.sourceId
        if (sourceId === undefined) {
          sourceId = await client.createContactInbox(link.contactId, inboxId)
          if (sourceId !== undefined) link = { ...link, sourceId }
        }
        conversationId = await client.createConversation({
          inboxId,
          contactId: link.contactId,
          ...(sourceId !== undefined ? { sourceId } : {}),
        })
      } catch (error) {
        if (!stored || relinked || !isGone(error)) throw error
        await mapping.delete(chatId)
        return ensureLink(chatId, ctx, true)
      }
      link = { ...link, conversationId }
      await mapping.set(chatId, link)
    }
    return link as ChatwootChatLink & { conversationId: number }
  }

  /** Run `op` against the chat's conversation; on 404 drop it, recreate once and retry. */
  const withConversation = async <T>(chatId: ChatId, ctx: MessageContext | undefined, op: (conversationId: number) => Promise<T>): Promise<T> => {
    const link = await ensureLink(chatId, ctx)
    try {
      return await op(link.conversationId)
    } catch (error) {
      if (!(error instanceof ChatwootApiError) || error.status !== 404) throw error
      const { conversationId: _gone, ...rest } = link
      await mapping.set(chatId, rest)
      const fresh = await ensureLink(chatId, ctx)
      return op(fresh.conversationId)
    }
  }

  const postOutgoing = async (conversationId: number, content: string, isPrivate = false) => {
    const key = `${conversationId}\n${content}`
    pendingEchoes.set(key, (pendingEchoes.get(key) ?? 0) + 1)
    let id: number | undefined
    try {
      id = await client.createMessage(conversationId, { content, messageType: 'outgoing', private: isPrivate })
    } catch (error) {
      decrementEcho(key)
      throw error
    }
    // If the webhook already consumed the marker it also recorded the id.
    if (id === undefined || !ownIds.has(id)) decrementEcho(key)
    if (id !== undefined) rememberOwn(id)
  }

  const decrementEcho = (key: string) => {
    const n = (pendingEchoes.get(key) ?? 0) - 1
    if (n > 0) pendingEchoes.set(key, n)
    else pendingEchoes.delete(key)
  }

  const mergeLabels = async (conversationId: number, add: string[], remove: string[] = []) => {
    if (add.length === 0 && remove.length === 0) return
    const current = await client.getLabels(conversationId)
    const next = [...new Set([...current.filter((l) => !remove.includes(l)), ...add])]
    if (next.length === current.length && next.every((l, i) => l === current[i])) return
    await client.setLabels(conversationId, next)
  }

  const shouldSync = (chatId: ChatId) => (config.syncMode ?? 'all') === 'all' || (bot?.isHandedOff(chatId) ?? false)

  /* ----------------------------------------------------------- bot events */

  const onInbound = (ctx: MessageContext) => {
    if (config.syncInbound === false || !shouldSync(ctx.from)) return
    let extra: string[] = []
    try { extra = config.labels?.message?.(ctx) ?? [] } catch (error) { report(error, 'labels.message') }
    const text = inboundText(ctx)
    void enqueue(ctx.from, 'inbound', () => withConversation(ctx.from, ctx, async (conversationId) => {
      await client.createMessage(conversationId, { content: text, messageType: 'incoming' })
      if (extra.length) await mergeLabels(conversationId, extra)
    }))
  }

  const onSent = (payload: { chatId: ChatId; content: OutboundContent }) => {
    if (config.syncOutbound === false || agentContents.has(payload.content) || !shouldSync(payload.chatId)) return
    const text = outboundText(payload.content)
    void enqueue(payload.chatId, 'outbound', () => withConversation(payload.chatId, undefined, (id) => postOutgoing(id, text)))
  }

  const onHandoff = (e: HandoffEvent) => {
    const fromChatwoot = e.reason?.startsWith('chatwoot:') ?? false
    void enqueue(e.chatId, 'handoff', () => withConversation(e.chatId, undefined, async (conversationId) => {
      if (!fromChatwoot) {
        await client.toggleStatus(conversationId, 'open')
        if (config.handoffNote !== false) {
          const note = (config.handoffNote ?? '🤖 → 👤 Handoff: {{reason}}').replace(/\{\{\s*reason\s*\}\}/g, e.reason ?? '')
          await postOutgoing(conversationId, note, true)
        }
      }
      await mergeLabels(conversationId, config.labels?.handoff ?? [])
    }))
  }

  const onResume = (e: ResumeEvent) => {
    void enqueue(e.chatId, 'resume', async () => {
      const link = await mapping.get(e.chatId)
      if (link?.conversationId === undefined) return
      const conversationId = link.conversationId
      if (e.reason !== RESOLVED_REASON && config.resolveOnResume !== false) {
        await client.toggleStatus(conversationId, 'resolved')
      }
      await mergeLabels(conversationId, config.labels?.resume ?? [], config.labels?.handoff ?? [])
    })
  }

  /* -------------------------------------------------------------- webhook */

  const agentContentsFor = (content: string, attachments: unknown[]): OutboundContent[] => {
    const out: OutboundContent[] = []
    if (config.forwardAttachments !== false) {
      for (const raw of attachments) {
        const a = obj(raw)
        const url = typeof a.data_url === 'string' ? a.data_url : undefined
        // Only absolute http(s) URLs: some transports (Baileys) read any other `{ url }` from disk.
        if (!url || !/^https?:\/\//i.test(url)) continue
        const caption = out.length === 0 && content ? content : undefined
        const media = { url }
        switch (a.file_type) {
          case 'image': out.push({ kind: 'image', media, ...(caption ? { caption } : {}) }); break
          case 'video': out.push({ kind: 'video', media, ...(caption ? { caption } : {}) }); break
          case 'audio': out.push({ kind: 'audio', media }); break
          default: {
            const filename = attachmentFilename(url)
            out.push({ kind: 'document', media, ...(filename ? { filename } : {}), ...(caption ? { caption } : {}) })
          }
        }
      }
    }
    const captioned = out.some((c) => 'caption' in c && c.caption)
    if (content && !captioned) out.unshift({ kind: 'text', text: content })
    return out
  }

  const handleAgentMessage = async (payload: Json): Promise<void> => {
    const type = payload.message_type
    if (type !== 'outgoing' && type !== 1) return
    if (payload.private === true) return
    const senderType = String(obj(payload.sender).type ?? '').toLowerCase()
    if (senderType === 'agent_bot' || senderType === 'contact' || senderType === 'agentbot') return
    const inbox = num(obj(payload.inbox).id) ?? num(payload.inbox_id)
    if (inbox !== undefined && inbox !== inboxId) return
    const conversationId = num(obj(payload.conversation).id) ?? num(payload.conversation_id)
    if (conversationId === undefined) return
    const messageId = num(payload.id)
    const content = typeof payload.content === 'string' ? payload.content : ''

    if (messageId !== undefined && ownIds.has(messageId)) return
    if (messageId !== undefined && seenAgentIds.has(messageId)) return
    const echoKey = `${conversationId}\n${content}`
    if ((pendingEchoes.get(echoKey) ?? 0) > 0) {
      decrementEcho(echoKey)
      if (messageId !== undefined) rememberOwn(messageId)
      return
    }

    // Claim the id before any await so a concurrent redelivery is dropped too.
    if (messageId !== undefined) {
      seenAgentIds.add(messageId)
      if (seenAgentIds.size > MAX_SEEN_AGENT_IDS) seenAgentIds.delete(seenAgentIds.values().next().value as number)
    }
    const chatId = await mapping.chatOf(conversationId)
    if (chatId === undefined || !bot) return
    const contents = agentContentsFor(content, Array.isArray(payload.attachments) ? payload.attachments : [])
    if (contents.length === 0) return

    if (config.autoHandoff !== false && !bot.isHandedOff(chatId)) {
      const agent = obj(payload.sender)
      await bot.handoff(chatId, {
        reason: AGENT_REASON,
        meta: {
          conversationId,
          ...(typeof agent.name === 'string' ? { agent: agent.name } : {}),
          ...(num(agent.id) !== undefined ? { agentId: num(agent.id) } : {}),
        },
      })
    }
    for (const c of contents) {
      agentContents.add(c)
      await bot.sendTo(chatId, c)
    }
  }

  /** Whether a `conversation_updated` payload reports a status change to `resolved`. */
  const statusChangedToResolved = (payload: Json): boolean => {
    const changes: unknown[] = Array.isArray(payload.changed_attributes) ? payload.changed_attributes : [payload.changed_attributes]
    return changes.some((c) => obj(obj(c).status).current_value === 'resolved')
  }

  const handleStatus = async (payload: Json): Promise<void> => {
    const status = payload.status ?? obj(payload.conversation).status
    if (status !== 'resolved' || config.resumeOnResolve === false || !bot) return
    // conversation_updated also fires for label/assignee/attribute edits (including the
    // plugin's own) and carries the current status: only a real status change counts.
    if (payload.event === 'conversation_updated' && !statusChangedToResolved(payload)) return
    const conversationId = num(payload.id) ?? num(obj(payload.conversation).id)
    if (conversationId === undefined) return
    const inbox = num(payload.inbox_id) ?? num(obj(payload.inbox).id)
    if (inbox !== undefined && inbox !== inboxId) return
    const chatId = await mapping.chatOf(conversationId)
    if (chatId === undefined || !bot.isHandedOff(chatId)) return
    await bot.resume(chatId, { reason: RESOLVED_REASON })
  }

  const handleWebhook = async (req: ChatwootWebhookRequest): Promise<ChatwootWebhookResponse> => {
    try {
      const raw = typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : Buffer.from(req.rawBody)
      const q = req.query
      const queryToken = q instanceof URLSearchParams ? q.get('token') ?? undefined : q?.token
      if (!verifyWebhook(auth, raw, req.headers ?? {}, queryToken)) return { status: 401, body: 'unauthorized' }
      if (!bot) return { status: 503, body: 'not installed' }
      let payload: Json
      try { payload = obj(JSON.parse(raw.toString('utf8'))) } catch { return { status: 400, body: 'invalid json' } }
      const event = payload.event
      try {
        if (event === 'message_created') await track(handleAgentMessage(payload))
        else if (event === 'conversation_status_changed' || event === 'conversation_updated' || event === 'conversation_resolved') {
          await track(handleStatus(payload))
        }
      } catch (error) {
        report(error, `webhook:${String(event)}`)
      }
      return { status: 200, body: 'ok' }
    } catch (error) {
      report(error, 'webhook')
      return { status: 500, body: 'error' }
    }
  }

  const webhookHandler = (opts: { maxBytes?: number } = {}) => (req: IncomingMessage, res: ServerResponse) => {
    const maxBytes = opts.maxBytes ?? 1024 * 1024
    const reply = (status: number, body: string) => {
      if (res.headersSent) return
      res.statusCode = status
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(body)
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') return reply(405, 'method not allowed')
    const declared = Number(header(req.headers, 'content-length') ?? '0')
    if (declared > maxBytes) return reply(413, 'payload too large')
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > maxBytes) {
        aborted = true
        reply(413, 'payload too large')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => { report(error, 'webhook:request'); reply(400, 'bad request') })
    req.on('end', () => {
      if (aborted) return
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams
      void handleWebhook({ rawBody: Buffer.concat(chunks), headers: req.headers, query }).then((r) => reply(r.status, r.body))
    })
  }

  const api: ChatwootApi = {
    client,
    handleWebhook,
    webhookHandler,
    async conversationOf(chatId) { return (await mapping.get(chatId))?.conversationId },
    chatOf: (conversationId) => mapping.chatOf(conversationId),
    addLabels(chatId, labels) {
      return new Promise<void>((resolve, reject) => {
        void enqueue(chatId, 'labels', async () => {
          try { await withConversation(chatId, undefined, (id) => mergeLabels(id, labels)); resolve() } catch (e) { reject(e) }
        })
      })
    },
    removeLabels(chatId, labels) {
      return new Promise<void>((resolve, reject) => {
        void enqueue(chatId, 'labels', async () => {
          try {
            const link = await mapping.get(chatId)
            if (link?.conversationId !== undefined) await mergeLabels(link.conversationId, [], labels)
            resolve()
          } catch (e) { reject(e) }
        })
      })
    },
    async flush() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }

  const spec: PluginSpec = {
    name: 'chatwoot',
    version: '0.1.0',
    description: 'Chatwoot inbox sync + human handoff driven by Chatwoot agents.',
    install(ctx) {
      const scoped = ctx.bot
      bot = scoped
      logger = ctx.logger
      if (!config.storage) {
        const kv = storeKeyValue(scoped.getStore())
        if (kv) mapping = new ChatwootMapping(kv)
        else ctx.logger.warn('chatwoot: the store has no cursor support; the chat ↔ conversation mapping lives in memory only')
      }
      scoped.before('message', async (c: MessageContext, next: () => Promise<void>) => {
        try { onInbound(c) } catch (error) { report(error, 'inbound') }
        await next()
      }, 1000)
      scoped.after('send', (payload: { chatId: ChatId; content: OutboundContent }) => {
        try { onSent(payload) } catch (error) { report(error, 'outbound') }
      })
      scoped.on('handoff', onHandoff)
      scoped.on('resume', onResume)
      ctx.tools.chatwoot = api
      ctx.onDispose(() => {
        scoped.off('handoff', onHandoff)
        scoped.off('resume', onResume)
        if (ctx.tools.chatwoot === api) delete ctx.tools.chatwoot
        bot = undefined
      })
    },
  }

  return Object.assign(spec, api)
}

/** Last URL path segment, percent-decoded when well-formed, with no path separators or controls. */
function attachmentFilename(url: string): string | undefined {
  let last: string
  try { last = new URL(url).pathname.split('/').pop() ?? '' } catch { return undefined }
  try { last = decodeURIComponent(last) } catch { /* keep the raw segment */ }
  const name = last.replace(/[\x5c/\u0000-\u001f\u007f]+/g, '_').replace(/^\.+/, '')
  return name || undefined
}
