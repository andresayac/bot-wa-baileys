/**
 * Special triggers — `WELCOME` (first contact) and type triggers (`MEDIA`,
 * `IMAGE`, …, `CALL`).
 *
 * Every constant here is a regular `Trigger`: it works with `bot.when()`,
 * `flow()`/`addKeyword()` (including `.scope()`), `bot.conversation(name, fn, { trigger })`
 * and `bot.use()`. They are frozen objects; to scope one, spread it:
 * `bot.when({ ...IMAGE, scope: 'dm' }, handler)`.
 *
 * ## Precedence
 *
 * The dispatcher pipeline is unchanged: before-hooks → commands → active
 * conversation → dormant resume → **matchers** → catch-all. Inside the matcher
 * stage, triggers run by specificity (highest first; ties keep registration order):
 *
 * | Trigger                                                  | Specificity |
 * | -------------------------------------------------------- | ----------- |
 * | `WELCOME` (only on a first contact)                      | 100         |
 * | string / `match: 'equals'`                               | 40          |
 * | `match: 'startsWith'`                                    | 30          |
 * | `match: 'endsWith'`                                      | 25          |
 * | `RegExp`                                                 | 20          |
 * | `match: 'contains'`                                      | 10          |
 * | function trigger                                         | 5           |
 * | single-kind type trigger (`IMAGE`, …, `bot.onType`)      | 2           |
 * | multi-kind type trigger (`MEDIA`, `typeTrigger(a, b)`)   | 1           |
 *
 * So a text matcher is never shadowed by a type trigger (an image whose caption
 * is `"hola"` goes to `bot.when('hola')`), `IMAGE` beats `MEDIA` whatever the
 * registration order, and `WELCOME` greets a first contact before anything
 * else — call `ctx.pass()` in the WELCOME handler to let that same message
 * continue to the regular matchers.
 *
 * `CALL` never takes part in the message pipeline: call events are dispatched on
 * their own path (see {@link CALL}).
 */

import type { MessageType } from './provider.js'
import type { TriggerScope } from './types.js'

/**
 * A trigger that matches on the inbound kind (`ctx.type`) instead of the body.
 * Build one with {@link typeTrigger} or use the exported constants.
 */
export interface TypeTrigger {
  readonly kind: 'type'
  /** The `ctx.type` values this trigger accepts. An empty list never matches. */
  readonly types: readonly MessageType[]
  /** Restrict to DMs or groups, like `TriggerObject.scope`. Default `'all'`. */
  readonly scope?: TriggerScope
  /** Human-readable name, for logs and debugging only. */
  readonly label?: string
}

/** The first-contact trigger. Use the {@link WELCOME} constant. */
export interface WelcomeTrigger {
  readonly kind: 'welcome'
  /** Restrict to DMs or groups, like `TriggerObject.scope`. Default `'all'`. */
  readonly scope?: TriggerScope
}

/** Specificity of {@link WELCOME}: above every text trigger (max 40). */
export const WELCOME_SPECIFICITY = 100
/** Specificity of a type trigger that accepts exactly one kind (`IMAGE`, `bot.onType`). */
export const SINGLE_TYPE_SPECIFICITY = 2
/** Specificity of a type trigger that accepts several kinds (`MEDIA`). */
export const MULTI_TYPE_SPECIFICITY = 1

/** Specificity of a type trigger: below every text/function trigger, single kind > several kinds. */
export function typeTriggerSpecificity(trigger: TypeTrigger): number {
  if (trigger.types.length === 0) return 0 // never matches → lowest priority
  return trigger.types.length === 1 ? SINGLE_TYPE_SPECIFICITY : MULTI_TYPE_SPECIFICITY
}

/** Is `value` a {@link TypeTrigger}? */
export function isTypeTrigger(value: unknown): value is TypeTrigger {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'type'
    && Array.isArray((value as { types?: unknown }).types)
}

/** Is `value` the {@link WELCOME} trigger (possibly spread with a `scope`)? */
export function isWelcomeTrigger(value: unknown): value is WelcomeTrigger {
  return typeof value === 'object' && value !== null
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === 'welcome'
}

/**
 * Build a type trigger for one or more inbound kinds.
 *
 * @example
 * ```ts
 * // any visual media, but not audio/documents
 * bot.when(typeTrigger('image', 'video'), (ctx) => ctx.reply('¡Qué buena toma!'))
 * ```
 */
export function typeTrigger(...types: MessageType[]): TypeTrigger {
  return freezeTypeTrigger([...types], types.join('|'))
}

function freezeTypeTrigger(types: MessageType[], label: string): TypeTrigger {
  return Object.freeze({ kind: 'type' as const, types: Object.freeze(types), label })
}

/**
 * Fires only on a user's **first interaction** with the bot — or the first one
 * after `bot.resetWelcome()` / the `/reset` command of `slashCommandsPlugin`.
 *
 * - **Scope:** per chat in a DM, **per participant** in a group (each member
 *   who speaks gets their own welcome), independent of `conversationScope`. A
 *   DM and a group are different first contacts.
 * - **What counts:** the first message that reaches the matcher stage. Commands,
 *   an active conversation, a dormant resume, an aborting before-hook or the
 *   `groupMode` filter consume a message without spending the welcome.
 * - **Precedence:** above every other trigger (see the module docs). `ctx.pass()`
 *   inside the handler lets the same message continue to the regular matchers.
 * - **Persistence:** resolved against the store (`IStore` cursor key/value,
 *   supported by every bundled store), so it survives restarts with a
 *   persistent store. It is decided inside the per-chat FIFO, so concurrent first
 *   messages cannot both be welcomed. Across several processes sharing a store
 *   it is check-then-set (route a chat to a single process, as conversations
 *   already require).
 * - **Cost:** with no WELCOME handler registered there are zero extra store
 *   reads. With one, each user costs at most one read (two in groups) plus one
 *   write per process lifetime; later messages hit an in-memory cache.
 * - If the store read fails, WELCOME is skipped for that message (it never
 *   greets on an unknown state), the error goes to `bot.on('error')`, and the
 *   message continues to the other matchers.
 *
 * @example
 * ```ts
 * bot.when(WELCOME, async (ctx) => {
 *   await ctx.reply('🙌 ¡Bienvenido! Escribe "menu" para ver las opciones.')
 * })
 * // or as an onboarding flow (add `.id('onboarding')` to make it `.persistent()`)
 * bot.use(flow(WELCOME).ask('¿Cómo te llamas?', 'name').say((_, c) => `¡Hola ${c.state.name}!`))
 * ```
 */
export const WELCOME: WelcomeTrigger = Object.freeze({ kind: 'welcome' as const })

/** Any downloadable media: image, video, audio, voice note, document or sticker. */
export const MEDIA: TypeTrigger = freezeTypeTrigger(['image', 'video', 'audio', 'voice', 'document', 'sticker'], 'MEDIA')
/** An inbound image (same tier as `bot.onImage`). */
export const IMAGE: TypeTrigger = freezeTypeTrigger(['image'], 'IMAGE')
/** An inbound video. */
export const VIDEO: TypeTrigger = freezeTypeTrigger(['video'], 'VIDEO')
/**
 * An inbound audio **file** (`ctx.type === 'audio'`). Voice notes are
 * `VOICE_NOTE`; use `typeTrigger('audio', 'voice')` to catch both.
 */
export const AUDIO: TypeTrigger = freezeTypeTrigger(['audio'], 'AUDIO')
/** An inbound voice note (push-to-talk, `ctx.type === 'voice'`). */
export const VOICE_NOTE: TypeTrigger = freezeTypeTrigger(['voice'], 'VOICE_NOTE')
/** An inbound document/file. */
export const DOCUMENT: TypeTrigger = freezeTypeTrigger(['document'], 'DOCUMENT')
/** An inbound sticker. */
export const STICKER: TypeTrigger = freezeTypeTrigger(['sticker'], 'STICKER')
/** An inbound shared location. */
export const LOCATION: TypeTrigger = freezeTypeTrigger(['location'], 'LOCATION')
/** An inbound shared contact card. */
export const CONTACT: TypeTrigger = freezeTypeTrigger(['contact'], 'CONTACT')
/** An inbound poll (creation). Vote updates arrive on `bot.on('poll')`. */
export const POLL: TypeTrigger = freezeTypeTrigger(['poll'], 'POLL')

/**
 * An inbound call notification (the provider's `{ kind: 'call' }` event).
 *
 * The handler receives a context with `type === 'call'`, an empty `body`,
 * `from`/`sender` set to the caller (`CallEvent.from`, treated as a DM chat) and
 * `ctx.call` holding the `CallEvent`, so `ctx.reply()` answers the caller and
 * a `flow(CALL)` can keep talking with them in that DM.
 *
 * - Fires **once per call id** (the first event seen for it). Transports emit
 *   several updates per call (WhatsApp: offer → ringing/reject/timeout/terminate);
 *   listen to `bot.on('call')` to observe every update.
 * - Runs after the `before('call')`/`after('call')` hooks and the `'call'` event;
 *   a `before('call')` hook that calls `abort()` suppresses it.
 * - Calls never reach text/function triggers, commands, active conversations,
 *   the catch-all or the `'message'` event, and are not persisted as messages.
 *   Message-bound helpers (`react`, `quote`, `markRead`, `delete`) are meaningless here.
 * - Ignored while the bot is not started.
 *
 * @example
 * ```ts
 * bot.when(CALL, (ctx) => ctx.reply('📵 No atiendo llamadas, escríbeme por aquí.'))
 * ```
 */
export const CALL: TypeTrigger = freezeTypeTrigger(['call'], 'CALL')
