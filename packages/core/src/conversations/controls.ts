import type { ConversationRuntime, ConversationHandle, RuntimeMessage, ConversationControlsBase, WaitAccepts } from './ConversationRuntime.js'
import { ConversationEnded, ConversationGoto } from './errors.js'
import { parseTimerDuration } from '../utils/timers.js'
import { normalizeText } from '../core/matching.js'
import type { WaitOptions } from '../core/types.js'
import { DEFAULT_RETRIES, WaitTracker, bindTracker, type WaitVerdict } from './retry.js'
import { createIdleControls, type IdleCallback } from './idle.js'
import { parseWithSchema, type SchemaLike } from '../flows/schema.js'

/** Wait options with a zod-compatible `schema`: the wait resolves with the schema's parsed value. */
export type SchemaWaitOptions<T> = WaitOptions & { schema: SchemaLike<T> }
import { defaultI18n, translateFor } from '../i18n/I18n.js'
import { CORE_MESSAGES } from '../i18n/builtins.js'
import type { TranslateParams } from '../i18n/types.js'
import type { InboundLocation } from '../core/provider.js'

/** Types `c.waitMedia()` takes by default (voice notes only when asked for: `waitMedia(['voice'])`). */
/** Media kinds `c.waitMedia(types)` accepts. */
export type WaitMediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'voice'
const MEDIA_TYPES: readonly WaitMediaType[] = ['image', 'video', 'audio', 'document', 'sticker']

export interface ConversationControls extends ConversationControlsBase {
  /**
   * Send `text` and wait for a text answer. With `{ schema }` (any zod-compatible `safeParse`)
   * the answer is parsed and the PARSED value is returned (`z.coerce.number()` → `number`); a
   * rejected answer re-prompts with `otherwise`, else the schema's first issue message.
   */
  ask<T>(text: string, opts: SchemaWaitOptions<T>): Promise<T>
  ask(text: string, opts?: WaitOptions): Promise<string>
  /** Wait for a text message (no prompt). Accepts `{ schema }` like {@link ask}. */
  waitText<T>(opts: SchemaWaitOptions<T>): Promise<T>
  waitText(opts?: WaitOptions): Promise<string>
  waitMedia(types?: WaitMediaType[], opts?: WaitOptions): Promise<RuntimeMessage>
  /**
   * Wait for a shared location (`type: 'location'` with a normalized `sharedLocation`) and
   * resolve with it. Anything else re-prompts with `otherwise` (default: the localized
   * `core.wait.location`) and counts against `retries`; `validate(body, message)` can reject a
   * location (`message.sharedLocation`), e.g. a live one. A location message whose provider
   * could not read valid coordinates is treated as "anything else".
   */
  waitLocation(opts?: WaitOptions): Promise<InboundLocation>
  choose(prompt: string, options: Record<string, string>, opts?: WaitOptions): Promise<string>
  goto(name: string, args?: unknown): never
  /**
   * Re-run the most recent wait (`ask` / `waitText` / `waitMedia` / `choose` / `waitAny`) with
   * its original options (`validate`, `filter`, `timeout`, `otherwise`, `retries`).
   *
   * Before waiting again it re-sends the wait's prompt — the `ask` question or the `choose`
   * menu — or `message` instead (for `choose`, `message` replaces only the menu header; the
   * numbered options are kept). Waits without a prompt send just `message`, if given;
   * `c.retry('')` waits again without sending anything.
   *
   * **Async conversations** (`bot.conversation()`), and waits made inside the current
   * `flow().do()` step: resolves with the new value — `letra = await c.retry('Solo una letra')`.
   * `T` is that wait's result type: `string` for ask/waitText/choose, `RuntimeMessage` for
   * waitMedia/waitAny, `InboundLocation` for waitLocation.
   *
   * **Flow steps** (`flow().do()`, a `.choose()` `then` action) whose most recent wait belongs
   * to an EARLIER step (`.ask()`, `.choose()`): rewinds the flow to that step — it is re-prompted
   * (with `message` instead of its prompt, when given), its state key gets the new answer, and
   * every following step (including the calling `.do()`) runs again. It throws a control signal
   * synchronously, so code after `c.retry()` in the step does not run (like `c.end()`).
   *
   * **Budget:** each retry counts as one invalid attempt of that wait, shared with `validate`
   * rejections; reaching the wait's `retries` (default 3) throws `RetriesExceeded` (the
   * conversation ends with `retriesMessage`). A new wait starts a fresh budget. Use
   * `retries: Infinity` on the wait for unlimited retries.
   *
   * **From a `c.idle()` callback** (outside the conversation's flow) it only re-prompts the
   * wait the conversation is parked on — the conversation still receives the answer — and
   * resolves with that answer (`undefined` if the wait ends another way). If no wait is pending
   * (the conversation is busy between waits, or has not waited yet) it does nothing and
   * resolves `undefined`; it never re-asks an answered question or rewinds a flow.
   *
   * With no previous wait (in the conversation itself) it rejects with `RetryUnavailableError`.
   * Always `await` (or `return`) it: the conversation has one pending-wait slot, so a wait
   * started while an un-awaited retry is still waiting is refused with `ConcurrentWaitError`
   * (the conversation ends through the error path).
   */
  retry<T = string>(message?: string): Promise<T>
  /**
   * Arm an inactivity watchdog: `callback` runs once when `duration` (`'30s'`, `'2m'`, ms…)
   * passes without an inbound message from this conversation's user; each inbound message
   * reschedules it and re-arms it after it fired. The callback may reply, `c.end(farewell)` /
   * `c.goto(name)` to finish the conversation (applied at the pending wait), or `c.retry()` to
   * re-prompt the pending wait (it cannot start new waits). Other errors go to the bot
   * `'error'` event. `duration` accepts the same formats as `bot.onIdle()` (`'1d'`,
   * `'10 minutes'`…) up to 2^31 − 1 ms (about 24.8 days). Calling it again replaces the
   * previous watchdog; it is disarmed automatically when the conversation ends or is aborted.
   * Independent from the wait `timeout` (which ends the conversation with `timeoutMessage`).
   */
  idle(duration: string | number, callback: IdleCallback): void
  /** Disarm the watchdog armed with {@link idle} (no-op if none). */
  idleClear(): void
  /**
   * Translate `key` in the conversation's current language — that of the latest message
   * the user sent to it (so a `ctx.setLang()` mid-conversation is honoured). Same
   * semantics as `ctx.t`.
   */
  t(key: string, params?: TranslateParams): string
  /** The conversation's current language (see {@link t}). */
  readonly lang: string
}

export function createControls(rt: ConversationRuntime, handle: ConversationHandle, ctx: RuntimeMessage): ConversationControls {
  const timeoutOf = (o?: WaitOptions) => (o?.timeout !== undefined ? parseTimerDuration(o.timeout, 'wait timeout') : undefined)

  const rawWait = (o: WaitOptions | undefined, accepts: WaitAccepts) =>
    rt.wait(handle, { timeoutMs: timeoutOf(o), filter: o?.filter, accepts })

  // Records every wait so c.retry() can re-run it (see retry.ts).
  // Paced replies (BotConfig.typing / delay) re-check liveness after their wait: an aborted
  // conversation must not speak after the fact, and then unwinds like any other abort.
  const cancelIf = () => !rt.isAlive(handle)
  const replyAlive = async (text: string): Promise<void> => {
    await ctx.reply(text, { cancelIf })
    if (!rt.isAlive(handle)) rt.assertAlive(handle)
  }
  const tracker = new WaitTracker({
    assertAlive: () => rt.assertAlive(handle),
    reply: replyAlive,
    // Wakes early when the conversation ends/aborts; the caller re-checks liveness afterwards.
    sleep: (ms) => new Promise<void>((resolve) => {
      let unsubscribe = () => {}
      const timer = setTimeout(() => { unsubscribe(); resolve() }, ms)
      unsubscribe = rt.observe(handle, { end: () => { clearTimeout(timer); resolve() } })
    }),
  })

  /** `promptFor(message?)`: text sent before waiting (and re-sent by c.retry()); default: just the retry message. */
  function loopWait<T>(
    opts: WaitOptions | undefined,
    accepts: WaitAccepts,
    accept: (m: RuntimeMessage) => Promise<WaitVerdict<T>>,
    promptFor: (message?: string) => string | undefined = (message) => message,
  ): Promise<T> {
    return tracker.wait<T>(opts?.retries ?? DEFAULT_RETRIES, promptFor, async () => accept(await rawWait(opts, accepts)))
  }

  const acceptText = (opts?: WaitOptions & { schema?: SchemaLike<unknown> }) => async (m: RuntimeMessage): Promise<WaitVerdict<unknown>> => {
    if (m.type !== 'text') return { ok: false, message: opts?.otherwise ?? translateFor(m, CORE_MESSAGES.waitText) }
    const v = opts?.validate ? await opts.validate(m.body, m) : true
    if (v !== true) return { ok: false, message: typeof v === 'string' ? v : translateFor(m, CORE_MESSAGES.waitInvalid) }
    const schema = opts?.schema
    if (!schema) return { ok: true, value: m.body }
    const parsed = await parseWithSchema(schema, m.body)
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : { ok: false, message: opts?.otherwise ?? parsed.message ?? translateFor(m, CORE_MESSAGES.waitInvalid) }
  }

  const current = () => rt.latestMessage(handle) ?? ctx

  const idle = createIdleControls(rt, handle, ctx, (callback) => tracker.runOutOfBand(callback))

  const controls: ConversationControls = {
    say: async (text) => { rt.assertAlive(handle); await replyAlive(text) },
    state: rt.getState(handle),
    end: (farewell) => { throw new ConversationEnded(farewell) },
    goto: (name, args) => { throw new ConversationGoto(name, args) },
    waitAny: (o) => tracker.wait<RuntimeMessage>(DEFAULT_RETRIES, (message) => message,
      async () => ({ ok: true, value: await rt.wait(handle, { accepts: 'any', ...o }) })),

    waitText: ((opts?: WaitOptions) => loopWait<unknown>(opts, 'text', acceptText(opts))) as ConversationControls['waitText'],

    ask: ((text: string, opts?: WaitOptions) =>
      loopWait<unknown>(opts, 'text', acceptText(opts), (message) => message ?? text)) as ConversationControls['ask'],

    waitMedia: (types = [...MEDIA_TYPES], opts) => loopWait<RuntimeMessage>(opts, [...types], async (m) => {
      return (types as string[]).includes(m.type)
        ? { ok: true, value: m }
        : { ok: false, message: opts?.otherwise ?? translateFor(m, CORE_MESSAGES.waitMedia) }
    }),

    waitLocation: (opts) => loopWait<InboundLocation>(opts, ['location'], async (m) => {
      const location = m.type === 'location' ? m.sharedLocation : undefined
      if (!location) return { ok: false, message: opts?.otherwise ?? translateFor(m, CORE_MESSAGES.waitLocation) }
      const v = opts?.validate ? await opts.validate(m.body, m) : true
      if (v !== true) return { ok: false, message: typeof v === 'string' ? v : translateFor(m, CORE_MESSAGES.waitInvalid) }
      return { ok: true, value: location }
    }),

    choose: async (prompt, options, opts) => {
      const keys = Object.keys(options ?? {})
      if (keys.length === 0) {
        throw new TypeError('c.choose() needs at least one option: c.choose(prompt, { key: "Label", ... })')
      }
      const render = (header: string) => `${header}\n\n${keys.map((k, i) => `${i + 1}) ${options[k]}`).join('\n')}`
      const menu = render(prompt)
      return loopWait<string>(opts, 'any', async (m) => {
        const body = normalizeText(m.body)
        // Numeric input resolves by displayed 1-based menu position — intentionally,
        // byIndex wins over a key that happens to be a numeric string (e.g. key '2').
        const byIndex = /^\d+$/.test(body) ? keys[parseInt(body, 10) - 1] : undefined
        const byKey = keys.find((k) => normalizeText(k) === body)
        const byLabel = keys.find((k) => normalizeText(options[k]) === body)
        const picked = byIndex ?? byKey ?? byLabel
        return picked
          ? { ok: true, value: picked }
          : { ok: false, message: opts?.otherwise ?? menu }
      }, (message) => (message === undefined ? menu : message && render(message)))
    },

    retry<T = string>(message?: string): Promise<T> { return tracker.retry<T>(message) },
    idle: idle.idle,
    idleClear: idle.idleClear,
    t: (key, params) => translateFor(current(), key, params),
    get lang() { return current().lang ?? defaultI18n.defaultLocale },
  }
  bindTracker(controls, tracker)
  return controls
}
