/**
 * voicePlugin — speech-to-text for inbound voice notes and text-to-speech replies.
 *
 * `install` is **synchronous** and never touches the network: adapters are
 * resolved lazily on first use, and a non-fatal `warmup()` logs a bad config
 * (missing api key, unknown provider) at startup without crashing the process.
 *
 * What it wires:
 *  - `ctx.tools.voice` — a {@link VoiceClient} (`transcribe`, `synthesize`, `speak`).
 *  - `autoTranscribe` (default on when `stt` is set): a `before('message')` hook
 *    that downloads each voice note, transcribes it and exposes the text as
 *    `ctx.transcript` and — by default — `ctx.body`, so text triggers, `c.ask()`
 *    answers, NLU and AI handlers all "hear" audio. The STT language hint is
 *    `autoTranscribe.language`, else the i18n-resolved `ctx.lang`; the core then
 *    re-resolves the language so an i18n `detect` sees the transcript. `ctx.type` stays `'voice'`
 *    (so `VOICE_NOTE` triggers still fire) except while a conversation of the
 *    sender waits for text (`asText: 'auto'`), where it becomes `'text'` so
 *    `c.ask()` accepts the spoken answer; `c.waitMedia(['voice'])` still gets
 *    the voice note.
 *  - `autoReplyWithVoice` (default off): while a chat's latest inbound message is
 *    a voice note, outbound text to that chat is synthesized and sent as a voice
 *    note instead (a `before('send')` hook, so it covers `ctx.reply`, flows, `c.say`
 *    and the AI autoresponder alike). Falls back to text when synthesis fails.
 *    `ctx.stream()` output (previews, edits, chunks, final message) always stays text.
 *
 * @example
 * ```ts
 * import { voicePlugin } from '@botmesh/voice'
 *
 * bot.plug(voicePlugin({
 *   stt: { provider: 'openai', model: 'whisper-1', apiKey: process.env.OPENAI_API_KEY },
 *   tts: { provider: 'elevenlabs', voiceId: '21m00Tcm4TlvDq8ikWAM', apiKey: process.env.ELEVENLABS_API_KEY },
 *   autoReplyWithVoice: true,
 * }))
 * ```
 */

import {
  definePlugin,
  type ChatId,
  type MessageContext,
  type OutboundContent,
  type PluginContext,
  type PluginSpec,
  type SendOptions,
} from '@botmesh/core'
import { VoiceConfigError, VoiceError } from './errors.js'
import type { SttConfig, TtsConfig } from './resolve.js'
import { VoiceClient, type VoiceLimits } from './VoiceClient.js'

/** Message types {@link AutoTranscribeOptions.types} can target. */
export type TranscribableType = 'voice' | 'audio'

export interface AutoTranscribeOptions {
  /** Which inbound message types to transcribe. Default `['voice']` (voice notes only). */
  types?: TranscribableType[]
  /** Write the transcript into `ctx.body` (text triggers, `c.ask`, NLU, AI). Default `true`. */
  setBody?: boolean
  /**
   * Rewrite `ctx.type` to `'text'` when a transcript was produced:
   *  - `'auto'` (default): only while a conversation is active for the sender
   *    and its pending wait does not take this message type, so a voice note
   *    answers `c.ask()` / `c.waitText()` (which accept text only) while
   *    `c.waitMedia(['voice'])`, `c.choose()`, `c.waitAny()` and `VOICE_NOTE`
   *    triggers keep receiving it as a voice note.
   *  - `true`: always — text-only handlers (e.g. the `@botmesh/ai` autoresponder)
   *    answer audio, but `VOICE_NOTE`/`AUDIO` triggers no longer match.
   *  - `false`: never.
   */
  asText?: boolean | 'auto'
  /**
   * Strip leading/trailing punctuation (`¡Hola!` → `Hola`, `Sí.` → `Sí`) from the
   * text written into `ctx.body`, so equality triggers match what STT services
   * return. `ctx.transcript` always keeps the raw text. Default `true`.
   */
  trimPunctuation?: boolean
  /**
   * Language hint for every transcription (e.g. `'es'`). When omitted, the language
   * i18n resolved for the sender (`ctx.lang`, base code: `'en-gb'` → `'en'`) is used —
   * only when it comes from a real signal (stored preference, provider, detector),
   * never the bare default — else the service auto-detects.
   */
  language?: string
  /** Use `ctx.lang` as the hint when {@link language} is not set. Default `true`. */
  useContextLanguage?: boolean
  /** Prompt / vocabulary hint for every transcription. */
  prompt?: string
  /** Return `false` to skip a message (e.g. big groups, unpaid users). */
  filter?: (ctx: MessageContext) => boolean
  /** `before('message')` priority. Default `100` (runs before most hooks). */
  priority?: number
  /**
   * Called when a transcription fails (the message is still routed, without
   * transcript; `ctx.transcriptError` holds the error). Default: log a warning.
   */
  onError?: (error: unknown, ctx: MessageContext) => void | Promise<void>
}

export interface AutoReplyWithVoiceOptions {
  /** Send the text as well, right after the voice note. Default `false`. */
  alsoText?: boolean
  /** Texts longer than this stay as text. Default `limits.maxTextChars`. */
  maxChars?: number
  /** Voice override for the replies. */
  voice?: string
  /** Style instructions for the replies (OpenAI `gpt-4o-mini-tts`). */
  instructions?: string
  /** Inbound types that switch a chat to voice replies. Default `['voice']`. */
  triggerTypes?: TranscribableType[]
  /** Return `false` to keep a given outbound text as text. */
  filter?: (chatId: ChatId, text: string) => boolean
}

export interface VoicePluginConfig {
  /** Speech-to-text: `{ provider: 'openai' | 'deepgram', … }` or a custom {@link SttAdapter}. */
  stt?: SttConfig
  /** Text-to-speech: `{ provider: 'openai' | 'elevenlabs', … }` or a custom {@link TtsAdapter}. */
  tts?: TtsConfig
  /** Size / duration / text / time limits. */
  limits?: VoiceLimits
  /** Transcribe inbound voice notes before routing. Default `true` when `stt` is set. */
  autoTranscribe?: boolean | AutoTranscribeOptions
  /** Answer voice with voice. Default `false`. Requires `tts`. */
  autoReplyWithVoice?: boolean | AutoReplyWithVoiceOptions
}

/** Cap on chats remembered as "in voice mode" (oldest evicted first). */
const MAX_VOICE_CHATS = 10_000

/**
 * `before('send')` payload. `edit` is set by `ctx.edit` (an in-place edit of a sent
 * message) and `stream` by everything `ctx.stream()` outputs — live previews
 * (`'draft'`/`'edit'`) and its new messages (`'message'`: the first message of an edit
 * stream, sentence chunks, the final message). None of them becomes a voice note: a
 * text edit cannot become audio, and a stream must stay one editable text reply.
 */
type SendPayload = { chatId: ChatId; content: OutboundContent; options?: SendOptions; edit?: unknown; stream?: unknown }

export function voicePlugin(config: VoicePluginConfig = {}): PluginSpec<VoicePluginConfig> {
  return definePlugin<VoicePluginConfig>({
    name: 'voice',
    version: '0.1.0',
    description: 'Speech-to-text for voice notes + text-to-speech replies (ctx.tools.voice)',
    install(ctx: PluginContext, cfg: VoicePluginConfig = config) {
      if (cfg.autoTranscribe && !cfg.stt) throw new VoiceConfigError('voicePlugin: autoTranscribe needs `stt`')
      if (cfg.autoReplyWithVoice && !cfg.tts) throw new VoiceConfigError('voicePlugin: autoReplyWithVoice needs `tts`')

      const bot = ctx.bot
      const logger = ctx.logger
      const client = new VoiceClient({ stt: cfg.stt, tts: cfg.tts, limits: cfg.limits })
      bot.provide('voice', client)

      const voiceChats = new Map<ChatId, true>()
      ctx.onDispose(() => {
        Reflect.deleteProperty(ctx.tools, 'voice')
        voiceChats.clear()
      })

      const transcribe: AutoTranscribeOptions | undefined = cfg.stt && cfg.autoTranscribe !== false
        ? (typeof cfg.autoTranscribe === 'object' ? cfg.autoTranscribe : {})
        : undefined
      const reply: AutoReplyWithVoiceOptions | undefined = cfg.autoReplyWithVoice
        ? (typeof cfg.autoReplyWithVoice === 'object' ? cfg.autoReplyWithVoice : {})
        : undefined

      if (transcribe || reply) {
        const types = transcribe?.types ?? ['voice']
        const replyTypes = reply?.triggerTypes ?? ['voice']
        bot.before('message', async (raw: unknown, next: () => Promise<void>) => {
          const mctx = raw as MessageContext
          if (reply && !mctx.isFromMe) {
            if ((replyTypes as string[]).includes(mctx.type)) {
              voiceChats.delete(mctx.from)
              voiceChats.set(mctx.from, true)
              if (voiceChats.size > MAX_VOICE_CHATS) voiceChats.delete(voiceChats.keys().next().value!)
            } else {
              voiceChats.delete(mctx.from)
            }
          }
          if (transcribe && (types as string[]).includes(mctx.type) && (!transcribe.filter || transcribe.filter(mctx))) {
            await transcribeInto(mctx, transcribe)
          }
          await next()
        }, transcribe?.priority ?? 100)
      }

      async function transcribeInto(mctx: MessageContext, opts: AutoTranscribeOptions): Promise<void> {
        try {
          const result = await client.transcribeDetailed(mctx, { language: languageHint(mctx, opts), prompt: opts.prompt })
          mctx.transcript = result.text
          const body = opts.trimPunctuation === false ? result.text : trimPunctuation(result.text)
          if (!body) return
          if (opts.setBody !== false) mctx.body = body
          const asText = opts.asText ?? 'auto'
          if (asText === true || (asText === 'auto' && conversationWantsText(mctx))) mctx.type = 'text'
        } catch (error) {
          mctx.transcriptError = error
          if (opts.onError) {
            try { await opts.onError(error, mctx) } catch (hookError) { logger.warn({ err: hookError }, 'voice onError handler threw') }
          } else {
            logger.warn({ err: describe(error), type: mctx.type }, 'voice transcription failed')
          }
        }
      }

      /**
       * Explicit `language` → the i18n-resolved `ctx.lang` (base code) when it comes from
       * a real signal → `undefined` (the service auto-detects). After the transcript is
       * written into `ctx.body` the core re-resolves the language, so an i18n `detect`
       * sees the spoken text.
       */
      function languageHint(mctx: MessageContext, opts: AutoTranscribeOptions): string | undefined {
        if (opts.language) return opts.language
        if (opts.useContextLanguage === false) return undefined
        const source = mctx.langSource
        if (!source || source === 'default' || !mctx.lang) return undefined
        return mctx.lang.split('-')[0] || undefined
      }

      /**
       * `'auto'`: rewrite to text only while a conversation is active for the sender
       * and its pending wait would reject this message's own type — `c.ask()` /
       * `c.waitText()` take text only, while `c.waitMedia(['voice'])`, `c.choose()`
       * (reads `body`) and `c.waitAny()` take the voice note as is. A conversation
       * that is busy running a step (no pending wait yet) gets text, as before.
       */
      function conversationWantsText(mctx: MessageContext): boolean {
        const snapshot = bot.inspectConversation(mctx)
        if (!snapshot) return false
        const accepts = snapshot.accepts
        if (accepts === 'any') return false
        if (Array.isArray(accepts)) return !accepts.includes(mctx.type)
        return true
      }

      if (reply) {
        const maxChars = reply.maxChars ?? client.limits.maxTextChars
        bot.before('send', async (raw: unknown, next: () => Promise<void>) => {
          const payload = raw as SendPayload
          const content = payload.content
          if (
            content.kind === 'text' &&
            payload.edit === undefined &&
            payload.stream === undefined &&
            voiceChats.has(payload.chatId) &&
            content.text.trim().length > 0 &&
            content.text.length <= maxChars &&
            supportsVoice() &&
            (!reply.filter || reply.filter(payload.chatId, content.text))
          ) {
            try {
              const audio = await client.synthesize(content.text, { voice: reply.voice, instructions: reply.instructions })
              const voice: OutboundContent = { kind: 'voice', media: audio }
              if (reply.alsoText) await bot.send(payload.chatId, voice)
              else payload.content = voice
            } catch (error) {
              logger.warn({ err: describe(error) }, 'voice reply synthesis failed; sending text')
            }
          }
          await next()
        })
      }

      function supportsVoice(): boolean {
        const kinds = bot.getProvider().capabilities?.contentKinds
        return !kinds || kinds.includes('voice')
      }

      // Surface a misconfiguration at startup without crashing (install stays sync).
      if (cfg.stt || cfg.tts) {
        void client.warmup().catch((error) => logger.error({ err: describe(error) }, 'voice adapters failed to resolve'))
      }
    },
  })
}

/** Strip surrounding whitespace and sentence punctuation (keeps inner punctuation, `%`, `#`, …). */
export function trimPunctuation(text: string): string {
  return text.replace(/^[\s.,;:!?¡¿…"'«»“”‘’-]+|[\s.,;:!?¡¿…"'«»“”‘’-]+$/gu, '')
}

/** Error summary safe to log (no transcript, no audio, no api key). */
function describe(error: unknown): { name: string; code?: string; message: string } {
  if (error instanceof VoiceError) return { name: error.name, code: error.code, message: error.message }
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}
