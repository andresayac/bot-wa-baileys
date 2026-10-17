/**
 * Outbound messaging ergonomics: automatic typing indicator, reply delays,
 * last-sent tracking (for `ctx.edit`) and capability resolution.
 *
 * Everything here is transport-agnostic: it only reads
 * {@link ProviderCapabilities} and feature-detects the optional
 * `IProvider.typing` / `IProvider.editMessage` methods. A failing typing
 * indicator NEVER fails a send — it is cosmetic and best effort.
 *
 * Support levels (see {@link messagingSupport}):
 *  - `typing`: `native` when `capabilities.typing` and `provider.typing` exist;
 *    otherwise `unsupported` (no indicator AND no artificial wait).
 *  - `delay`:  always `native` (it is a core-side pause).
 *  - `edit`:   `native` when `capabilities.edit` and `provider.editMessage` exist;
 *    otherwise `degraded` (`ctx.edit` sends the new content as a new message,
 *    unless called with `{ fallback: 'skip' }`).
 *  - `react`:  `native` when `capabilities.reactions`; otherwise `unsupported`
 *    (`ctx.react` resolves a `skipped` result instead of rejecting).
 */

import { parseDuration } from '../utils/duration.js'
import { MAX_TIMER_MS, sleep as defaultSleep } from '../utils/timers.js'
import type { ChatId, IProvider, MessageRef, OutboundContent } from './provider.js'

/** Automatic typing-indicator policy (`BotConfig.typing`, `ctx.reply(text, { typing })`). */
export interface TypingConfig {
  /** Show the indicator before text replies. Defaults to `false` globally, `true` when set per reply. */
  enabled?: boolean
  /** Shortest time the indicator is shown before the text is sent (ms). Default 800. */
  minMs?: number
  /** Longest time the indicator is shown before the text is sent (ms). Default 3000. */
  maxMs?: number
  /** Simulated typing speed used to size the wait between `minMs` and `maxMs`. Default 20. */
  charsPerSecond?: number
}

/** A fully-resolved {@link TypingConfig}. */
export type ResolvedTypingConfig = Required<TypingConfig>

/** Defaults applied to every missing {@link TypingConfig} field. */
export const DEFAULT_TYPING: Readonly<ResolvedTypingConfig> = Object.freeze({
  enabled: false,
  minMs: 800,
  maxMs: 3000,
  charsPerSecond: 20,
})

/** Per-reply pacing options accepted by `ctx.reply/say/answer/text/quote(text, opts)`. */
export interface ReplyOptions {
  /**
   * Override the bot-wide typing policy for this reply: `true` shows it with the
   * bot's timing, `false` suppresses it, an object enables it with these overrides
   * (set `enabled: false` inside it to suppress).
   */
  typing?: boolean | TypingConfig
  /**
   * Pause before this reply (before the typing indicator, if any). Milliseconds or a
   * duration string (`'1.5s'`, `'500ms'`). Honored on every transport.
   */
  delay?: number | string
}

/** How a provider supports a messaging feature. */
export type MessagingSupport = 'native' | 'degraded' | 'unsupported'

/** Messaging features whose support can be queried with `ctx.supports()` / {@link messagingSupport}. */
export type MessagingFeature = 'typing' | 'delay' | 'edit' | 'react'

/** Options for `ctx.edit()`. */
export interface EditOptions {
  /**
   * What to do when the provider cannot edit (no `capabilities.edit`, no
   * `editMessage`, the content kind is not editable there, or there is no message to
   * edit): `'send'` (default) sends the content as a new message; `'skip'` sends
   * nothing and resolves `{ edited: false, skipped: true }`.
   */
  fallback?: 'send' | 'skip'
}

/** Result of `ctx.edit()`: a {@link SentMessage}-shaped object plus whether it was edited in place. */
export interface EditResult {
  ref: MessageRef
  id: string
  chatId: ChatId
  raw?: unknown
  skipped?: boolean
  /** `true` when the provider edited the message in place; `false` on fallback or skip. */
  edited: boolean
}

/** Minimal logger surface used here. */
interface DebugLogger { debug(...args: unknown[]): void }

/** Resolve the support level of a messaging feature for a provider. */
export function messagingSupport(provider: Pick<IProvider, 'capabilities' | 'typing' | 'editMessage'>, feature: MessagingFeature): MessagingSupport {
  const caps = provider.capabilities
  switch (feature) {
    case 'typing':
      return caps.typing && typeof provider.typing === 'function' ? 'native' : 'unsupported'
    case 'delay':
      return 'native'
    case 'edit':
      return caps.edit && typeof provider.editMessage === 'function' ? 'native' : 'degraded'
    case 'react':
      return caps.reactions ? 'native' : 'unsupported'
  }
}

function checkMs(value: unknown, name: string): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a finite number between 0 and ${MAX_TIMER_MS} — got ${String(value)}`)
  }
}

/**
 * Normalize a `BotConfig.typing` value (`true` = defaults enabled). Throws
 * `RangeError` on negative/non-finite timings, a non-positive speed or `minMs > maxMs`.
 */
export function normalizeTypingConfig(input: boolean | TypingConfig | undefined, base: ResolvedTypingConfig = DEFAULT_TYPING): ResolvedTypingConfig {
  if (input === undefined) return { ...base }
  if (typeof input === 'boolean') return { ...base, enabled: input }
  checkMs(input.minMs, 'typing.minMs')
  checkMs(input.maxMs, 'typing.maxMs')
  if (input.charsPerSecond !== undefined && (!Number.isFinite(input.charsPerSecond) || input.charsPerSecond <= 0)) {
    throw new RangeError(`typing.charsPerSecond must be a positive number — got ${String(input.charsPerSecond)}`)
  }
  const out: ResolvedTypingConfig = {
    enabled: input.enabled ?? base.enabled,
    minMs: input.minMs ?? base.minMs,
    maxMs: input.maxMs ?? base.maxMs,
    charsPerSecond: input.charsPerSecond ?? base.charsPerSecond,
  }
  if (out.minMs > out.maxMs) {
    // An explicit min above the inherited max raises the max (and vice versa is an error).
    if (input.maxMs === undefined) out.maxMs = out.minMs
    else throw new RangeError(`typing.minMs (${out.minMs}) must be <= typing.maxMs (${out.maxMs})`)
  }
  return out
}

/** Combine the bot-wide policy with a per-reply override. */
export function resolveReplyTyping(global: ResolvedTypingConfig, override: ReplyOptions['typing']): ResolvedTypingConfig {
  if (override === undefined) return global
  if (typeof override === 'boolean') return { ...global, enabled: override }
  return normalizeTypingConfig({ enabled: true, ...override }, global)
}

/** How long the indicator is shown for `text`: `len / charsPerSecond`, clamped to `[minMs, maxMs]`. */
export function typingDuration(text: string, cfg: Pick<ResolvedTypingConfig, 'minMs' | 'maxMs' | 'charsPerSecond'>): number {
  const raw = Math.round((Array.from(text).length / cfg.charsPerSecond) * 1000)
  return Math.min(cfg.maxMs, Math.max(cfg.minMs, raw))
}

/** Parse `ReplyOptions.delay` to ms (`undefined` → 0). Throws `RangeError` when negative/too large. */
export function parseReplyDelay(delay: number | string | undefined): number {
  if (delay === undefined) return 0
  const ms = parseDuration(delay)
  checkMs(ms, 'delay')
  return ms
}

/** Bounded "last message the bot sent in each chat" map, behind `ctx.edit(text)`. */
export class LastSentTracker {
  private readonly refs = new Map<ChatId, MessageRef>()
  constructor(private readonly max = 1000) {}

  /** Remember `ref` as the latest bot message of `chatId` (reactions should not be recorded). */
  record(chatId: ChatId, ref: MessageRef): void {
    this.refs.delete(chatId)
    this.refs.set(chatId, ref)
    if (this.refs.size > this.max) {
      const oldest = this.refs.keys().next().value
      if (oldest !== undefined) this.refs.delete(oldest)
    }
  }

  get(chatId: ChatId): MessageRef | undefined {
    return this.refs.get(chatId)
  }

  forget(chatId: ChatId): void {
    this.refs.delete(chatId)
  }
}

/** True when a send of `content` should become the chat's "last sent" message. */
export function isEditableSend(content: OutboundContent): boolean {
  return content.kind !== 'reaction'
}

/** Some transports (Telegram) expire the indicator after ~5 s: re-issue it this often. */
export const TYPING_REFRESH_MS = 4000

export interface PacerOptions {
  provider: Pick<IProvider, 'capabilities' | 'typing'>
  typing: ResolvedTypingConfig
  logger?: DebugLogger
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
}

/** Paces text replies: optional delay, then a typing indicator sized to the text, then the send. */
export interface Pacer {
  run<T>(chatId: ChatId, text: string, opts: ReplyOptions | undefined, send: () => Promise<T>): Promise<T>
}

export function createPacer(options: PacerOptions): Pacer {
  const { provider, logger } = options
  const wait = options.sleep ?? defaultSleep

  const indicate = (chatId: ChatId, state: 'typing' | 'paused'): void => {
    // Fire-and-forget: a slow or failing indicator never delays or fails the send.
    void Promise.resolve()
      .then(() => provider.typing?.(chatId, state))
      .catch((error: unknown) => {
        logger?.debug({ chatId, state, err: error instanceof Error ? error.message : String(error) }, 'typing indicator failed (ignored)')
      })
  }

  return {
    async run(chatId, text, opts, send) {
      const delayMs = parseReplyDelay(opts?.delay)
      const cfg = resolveReplyTyping(options.typing, opts?.typing)
      if (delayMs > 0) await wait(delayMs)

      const typingMs = cfg.enabled && messagingSupport(provider as IProvider, 'typing') === 'native'
        ? typingDuration(text, cfg)
        : 0
      if (typingMs <= 0) return send()

      indicate(chatId, 'typing')
      let remaining = typingMs
      while (remaining > 0) {
        const step = Math.min(remaining, TYPING_REFRESH_MS)
        await wait(step)
        remaining -= step
        if (remaining > 0) indicate(chatId, 'typing')
      }
      try {
        return await send()
      } finally {
        indicate(chatId, 'paused')
      }
    },
  }
}

/** Distinguish `ctx.edit(ref, …)` from `ctx.edit(content)`. */
export function isMessageRef(x: unknown): x is MessageRef {
  return typeof x === 'object' && x !== null && !('kind' in x)
    && typeof (x as { id?: unknown }).id === 'string'
    && typeof (x as { chatId?: unknown }).chatId === 'string'
}
