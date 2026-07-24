/**
 * TelegramProvider — Telegram Bot API transport for @bot-wa/core.
 *
 * Two ingress modes, both supported (pushIngress: true):
 *  - Long-poll (default, `polling: true`): start() loops getUpdates with a
 *    server-side timeout, advancing the update_id offset. stop() aborts it.
 *  - Webhook (`polling: false`): the host POSTs each Update body to `ingest()`.
 *
 * Outbound is plain JSON (or multipart for byte uploads) to
 * `POST {baseUrl}/bot{token}/{method}` — Node global fetch, zero extra deps.
 *
 * @example
 * ```ts
 * const provider = new TelegramProvider({ token: process.env.TG_TOKEN! })
 * const bot = new Bot({ provider })
 * await bot.start()   // long-polls getUpdates
 * ```
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import pino, { type Logger } from 'pino'
import { secureFetch } from '@bot-wa/http'
import type {
  ChatId,
  ConnectionState,
  DisconnectReason,
  IProvider,
  InboundEvent,
  MediaRef,
  MediaSource,
  MessageRef,
  OutboundContent,
  ProviderCapabilities,
  SendOptions,
  SendResult,
  UserId,
} from '@bot-wa/core'
import {
  ProviderError,
  RateLimitedError,
  PayloadTooLargeError,
  RecipientUnreachableError,
  UnsupportedContentError,
} from '@bot-wa/core'
import type { TelegramProviderConfig, TelegramResponse, TelegramUpdate, TelegramUser } from './types.js'
import { parseUpdate } from './parseInbound.js'
import { toOutbound, type ResolvedTelegramMedia } from './toOutbound.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Bot API methods that accept `reply_parameters`. */
const REPLYABLE = new Set([
  'sendMessage', 'sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice',
  'sendDocument', 'sendSticker', 'sendLocation', 'sendContact', 'sendPoll',
])

const MEDIA_KINDS: ReadonlyArray<OutboundContent['kind']> = ['image', 'video', 'audio', 'voice', 'document', 'sticker']

/** Translate a Bot API error envelope into a typed provider error. */
export function toProviderError(chatId: ChatId, errorCode: number | undefined, description: string | undefined, retryAfterSec?: number): ProviderError {
  const desc = description ?? `Telegram error ${errorCode ?? 'unknown'}`
  if (errorCode === 429) return new RateLimitedError((retryAfterSec ?? 1) * 1000, desc)
  if (errorCode === 403) return new RecipientUnreachableError(chatId, desc)
  if (errorCode === 400 && /too long/i.test(desc)) return new PayloadTooLargeError(desc)
  if (errorCode === 401) return new ProviderError(`Unauthorized — check the bot token (${desc})`)
  return new ProviderError(desc)
}

export class TelegramProvider implements IProvider<unknown> {
  readonly id = 'telegram'
  readonly capabilities: ProviderCapabilities = {
    contentKinds: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll', 'reaction', 'buttons', 'list', 'card', 'native'],
    maxTextLength: 4096,
    buttons: true,
    lists: false,          // no native list control — degrades to an inline keyboard
    polls: true,           // sendPoll is native
    reactions: true,       // setMessageReaction
    edit: true,            // editMessageText
    typing: true,          // sendChatAction
    presence: false,
    readReceipts: false,   // bots get no read receipts
    groups: true,
    templates: false,
    interactionsRequireAck: false, // answerCallbackQuery stops the spinner; no hard deadline
    pushIngress: true,     // supports webhook; also owns a long-poll loop
  }

  private readonly config: Required<Pick<TelegramProviderConfig, 'token' | 'baseUrl' | 'polling' | 'pollTimeout' | 'errorBackoffMs' | 'maxBackoffMs' | 'pollIdleMs'>> & Pick<TelegramProviderConfig, 'mediaDownload'>
  private readonly webhookSecret?: string
  /** Consecutive getUpdates failures — drives the exponential backoff; reset on success. */
  private pollErrors = 0
  private readonly logger: Logger
  private listeners = new Set<(e: InboundEvent) => void | Promise<void>>()
  private _selfId: string | null = null
  private running = false
  private stopped = false
  private readyEmitted = false
  private offset?: number
  private pollPromise?: Promise<void>
  private pollAbort?: AbortController

  constructor(config: TelegramProviderConfig) {
    this.config = {
      token: config.token,
      baseUrl: (config.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, ''),
      polling: config.polling ?? true,
      pollTimeout: config.pollTimeout ?? 30,
      errorBackoffMs: config.errorBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 60_000,
      pollIdleMs: config.pollIdleMs ?? 250,
      mediaDownload: config.mediaDownload,
    }
    if (config.selfId) this._selfId = config.selfId
    this.webhookSecret = config.webhookSecret
    this.logger = config.logger ?? pino({ level: config.debug ? 'debug' : 'error' })
    if (config.polling === false && !config.webhookSecret && !config.allowUnsignedWebhooks) {
      throw new Error(
        'TelegramProvider webhook mode requires `webhookSecret`. ' +
          'For isolated local development only, set `allowUnsignedWebhooks: true` explicitly.',
      )
    }
    if (config.polling === false && !config.webhookSecret) {
      this.logger.warn(
        'TelegramProvider unsigned webhook mode explicitly enabled; never expose this endpoint publicly.',
      )
    }
  }

  /** Timing-safe compare of the incoming secret-token header against the configured secret. */
  private secretMatches(headers?: Record<string, string | string[] | undefined>): boolean {
    if (!this.webhookSecret) return true
    const raw = headers?.['x-telegram-bot-api-secret-token']
    const presented = Array.isArray(raw) ? raw[0] : raw
    if (!presented) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(this.webhookSecret)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  get connection(): unknown { return null }
  get selfId(): UserId | null { return this._selfId }

  /* Events ---------------------------------------------------------------- */

  onEvent(listener: (e: InboundEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private fan(e: InboundEvent): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(e))
          .catch((error) => this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed'))
      } catch (error) {
        this.logger.error({ err: error, eventKind: e.kind }, 'provider event listener failed')
      }
    }
  }
  private emitConnection(state: ConnectionState, reason?: DisconnectReason, detail?: string): void {
    this.fan({ kind: 'connection', update: { state, reason, detail: detail ? { message: detail } : undefined } })
  }

  /* Lifecycle -------------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false
    this.emitConnection('connecting')
    if (this._selfId == null) {
      try {
        const me = await this.callApi<TelegramUser>('getMe')
        this._selfId = String(me.id)
        this.logger.debug(`getMe ok: @${me.username ?? me.id}`)
      } catch (err) {
        this.running = false
        const detail = err instanceof Error ? err.message : String(err)
        this.emitConnection('closed', /unauthorized/i.test(detail) ? 'sessionInvalid' : 'transient', detail)
        throw err
      }
    }
    if (this.config.polling) {
      // Fire-and-forget: start() resolves once the poll loop is underway;
      // the first successful getUpdates batch emits `ready`.
      this.pollPromise = this.pollLoop()
    } else {
      this.emitConnection('ready')
      this.logger.debug('TelegramProvider ready (webhook mode) — POST Updates to ingest()')
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.running = false
    this.pollAbort?.abort()
    if (this.pollPromise) {
      await this.pollPromise.catch(() => undefined)
      this.pollPromise = undefined
    }
    this.emitConnection('closed')
  }

  /**
   * Long-poll loop: getUpdates?offset=N&timeout=T, advancing offset past every
   * update_id. Errors back off (429 honors retry_after; 409 conflict means
   * another instance polls the same token → sessionTakenOver, stop).
   */
  private async pollLoop(): Promise<void> {
    const allowedUpdates = ['message', 'edited_message', 'callback_query']
    while (!this.stopped) {
      this.pollAbort = new AbortController()
      try {
        const updates = await this.callApi<TelegramUpdate[]>('getUpdates', {
          ...(this.offset != null ? { offset: this.offset } : {}),
          timeout: this.config.pollTimeout,
          allowed_updates: allowedUpdates,
        }, { signal: this.pollAbort.signal })
        this.pollErrors = 0 // a successful round resets the backoff ramp
        for (const u of updates ?? []) {
          if (typeof u.update_id === 'number') this.offset = u.update_id + 1
          const ev = parseUpdate(u, this._selfId ?? undefined)
          if (ev) this.fan(ev)
        }
        if (!this.readyEmitted) {
          this.readyEmitted = true
          this.emitConnection('ready')
        }
        // Empty batch: the server already waited `timeout` seconds; a small
        // client-side pause also guards against hot loops on mocked/odd servers.
        if (!updates?.length) await sleep(this.config.pollIdleMs)
      } catch (err) {
        if (this.stopped) break
        if (err instanceof RateLimitedError) {
          await sleep(err.retryAfterMs)
          continue
        }
        const detail = err instanceof Error ? err.message : String(err)
        if (/conflict|terminated by other getUpdates|\(409\)/i.test(detail)) {
          this.running = false
          this.emitConnection('closed', 'sessionTakenOver', detail)
          break
        }
        // Exponential backoff with a ceiling so a sustained network outage
        // doesn't hammer getUpdates every second forever.
        const delay = Math.min(this.config.errorBackoffMs * 2 ** this.pollErrors, this.config.maxBackoffMs)
        this.pollErrors++
        this.logger.warn(`getUpdates failed (${detail}); retrying in ${delay}ms (attempt ${this.pollErrors})`)
        await sleep(delay)
      }
    }
  }

  /* Webhook --------------------------------------------------------------- */

  /**
   * Feed one raw Update (object or JSON string) from the host's webhook route.
   * Returns the HTTP status the host should answer with (200 accepted,
   * 401 when the secret-token header is missing/wrong, 400 unparseable —
   * Telegram retries non-200s).
   */
  ingest(rawEvent: unknown, headers?: Record<string, string | string[] | undefined>): number {
    if (!this.secretMatches(headers)) {
      this.logger.warn('ingest: rejected Update with missing/invalid X-Telegram-Bot-Api-Secret-Token')
      return 401
    }
    let update: TelegramUpdate
    try {
      update = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : (rawEvent as TelegramUpdate)
    } catch {
      this.logger.warn('ingest: body is not valid JSON')
      return 400
    }
    if (!update || typeof update !== 'object' || typeof update.update_id !== 'number') return 400
    const ev = parseUpdate(update, this._selfId ?? undefined)
    if (ev) this.fan(ev)
    return 200
  }

  /* Outbound -------------------------------------------------------------- */

  private async resolveMedia(source: MediaSource, filename?: string): Promise<ResolvedTelegramMedia> {
    if (typeof source === 'string') {
      if (/^https?:\/\//i.test(source)) return { value: source }
      return { buffer: await readFile(source), filename: filename ?? basename(source) }
    }
    if (Buffer.isBuffer(source)) return { buffer: source, filename }
    if ('url' in source) return { value: source.url }
    if ('buffer' in source) return { buffer: source.buffer, filename }
    if ('path' in source) return { buffer: await readFile(source.path), filename: filename ?? basename(source.path) }
    if ('stream' in source) {
      const chunks: Buffer[] = []
      for await (const c of source.stream as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      return { buffer: Buffer.concat(chunks), filename }
    }
    if ('native' in source) {
      // Telegram reuse-by-file_id: { native: 'AgACAgEAAx...' }
      if (typeof source.native === 'string') return { value: source.native }
      throw new UnsupportedContentError('image', 'Telegram native MediaSource must be a file_id string')
    }
    throw new UnsupportedContentError('image', 'Unsupported MediaSource for Telegram')
  }

  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<unknown>> {
    const needsMedia = MEDIA_KINDS.includes(content.kind)
    const media = needsMedia
      ? await this.resolveMedia((content as { media: MediaSource }).media, content.kind === 'document' ? (content as { filename?: string }).filename : undefined)
      : undefined
    const out = toOutbound(content, media)
    const params: Record<string, unknown> = { chat_id: chatId, ...out.params }
    if (options?.quoted && REPLYABLE.has(out.method)) {
      params.reply_parameters = { message_id: Number(options.quoted.id) }
    }
    if (options?.platformData) Object.assign(params, options.platformData)
    const result = await this.callApi(out.method, params, { media, mediaField: out.mediaField })
    return { ref: this.refFromResult(result, chatId), raw: result }
  }

  private refFromResult(result: unknown, chatId: ChatId): MessageRef {
    const msg = result as { message_id?: number; chat?: { id?: number } } | undefined
    if (msg && typeof msg.message_id === 'number') {
      const cid = msg.chat?.id != null ? String(msg.chat.id) : chatId
      return { id: String(msg.message_id), chatId: cid, native: { chat_id: msg.chat?.id ?? chatId, message_id: msg.message_id } }
    }
    return { id: '', chatId, native: result }
  }

  /** POST {baseUrl}/bot{token}/{method} — JSON, or multipart when a buffer upload is required. */
  private async callApi<T>(method: string, params: Record<string, unknown> = {}, opts?: { media?: ResolvedTelegramMedia; mediaField?: string; signal?: AbortSignal }): Promise<T> {
    const url = `${this.config.baseUrl}/bot${this.config.token}/${method}`
    let init: RequestInit
    if (opts?.mediaField && opts.media?.buffer) {
      const form = new FormData()
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue
        if (k === opts.mediaField) {
          form.append(k, new Blob([new Uint8Array(opts.media.buffer)], { type: 'application/octet-stream' }), opts.media.filename ?? 'file')
        } else if (typeof v === 'object') {
          form.append(k, JSON.stringify(v))
        } else {
          form.append(k, String(v))
        }
      }
      init = { method: 'POST', body: form }
    } else {
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }
    }
    if (opts?.signal) init.signal = opts.signal
    const res = await fetch(url, init)
    const body = (await res.json().catch(() => ({}))) as TelegramResponse<T>
    if (!body.ok) {
      const chatId = typeof params.chat_id === 'string' ? params.chat_id : String(params.chat_id ?? '')
      throw toProviderError(chatId, body.error_code ?? res.status, body.description, body.parameters?.retry_after)
    }
    return body.result as T
  }

  /* Capability-gated actions ---------------------------------------------- */

  /** getFile → file_path → GET {baseUrl}/file/bot{token}/{file_path} → bytes. */
  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    const fileId = typeof ref.token === 'string' ? ref.token : undefined
    if (!fileId) throw new ProviderError('downloadMedia requires a Telegram file_id (MediaRef.token)')
    const info = await this.callApi<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!info.file_path) throw new ProviderError(`getFile returned no file_path for ${fileId}`)
    const { response: res, body } = await secureFetch(`${this.config.baseUrl}/file/bot${this.config.token}/${info.file_path}`, this.config.mediaDownload)
    if (!res.ok) throw new ProviderError(`Media download failed: HTTP ${res.status}`)
    return body
  }

  /** answerCallbackQuery — stops the client spinner / shows optional text. */
  async acknowledgeInteraction(interactionId: string, opts?: { text?: string; defer?: boolean }): Promise<void> {
    await this.callApi('answerCallbackQuery', {
      callback_query_id: interactionId,
      ...(opts?.text ? { text: opts.text } : {}),
    })
  }

  /** Bots receive no read receipts on Telegram — documented no-op. */
  async markRead(_refs: MessageRef[]): Promise<void> {}

  /** sendChatAction: typing / record_voice. 'paused' has no Bot API primitive. */
  async typing(chatId: ChatId, state: 'typing' | 'recording' | 'paused' = 'typing'): Promise<void> {
    if (state === 'paused') return
    await this.callApi('sendChatAction', { chat_id: chatId, action: state === 'recording' ? 'record_voice' : 'typing' })
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    await this.callApi('deleteMessage', { chat_id: ref.chatId, message_id: Number(ref.id) })
  }

  /** editMessageText — text only; other kinds must throw per the edit capability. */
  async editMessage(ref: MessageRef, content: OutboundContent): Promise<SendResult<unknown>> {
    if (content.kind !== 'text') throw new UnsupportedContentError(content.kind, 'TelegramProvider.editMessage supports text only (editMessageText)')
    const result = await this.callApi('editMessageText', { chat_id: ref.chatId, message_id: Number(ref.id), text: content.text })
    return { ref, raw: result }
  }
}
