import type { ConversationRuntime, ConversationHandle, RuntimeMessage, ConversationControlsBase } from './ConversationRuntime.js'
import { ConversationEnded, ConversationGoto } from './errors.js'
import { parseDuration } from '../utils/duration.js'
import { normalizeText } from '../core/matching.js'
import type { WaitOptions } from '../core/types.js'
import { DEFAULT_RETRIES, WaitTracker, bindTracker, type WaitVerdict } from './retry.js'
import { createIdleControls, type IdleCallback } from './idle.js'
import { defaultI18n, translateFor } from '../i18n/I18n.js'
import { CORE_MESSAGES } from '../i18n/builtins.js'
import type { TranslateParams } from '../i18n/types.js'

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const
type MediaType = (typeof MEDIA_TYPES)[number]

export interface ConversationControls extends ConversationControlsBase {
  ask(text: string, opts?: WaitOptions): Promise<string>
  waitText(opts?: WaitOptions): Promise<string>
  waitMedia(types?: MediaType[], opts?: WaitOptions): Promise<RuntimeMessage>
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
   * waitMedia/waitAny.
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
  const timeoutOf = (o?: WaitOptions) => (o?.timeout !== undefined ? parseDuration(o.timeout) : undefined)

  const rawWait = (o?: WaitOptions) => rt.wait(handle, { timeoutMs: timeoutOf(o), filter: o?.filter })

  // Records every wait so c.retry() can re-run it (see retry.ts).
  const tracker = new WaitTracker({ assertAlive: () => rt.assertAlive(handle), reply: (text) => ctx.reply(text) })

  /** `promptFor(message?)`: text sent before waiting (and re-sent by c.retry()); default: just the retry message. */
  function loopWait<T>(
    opts: WaitOptions | undefined,
    accept: (m: RuntimeMessage) => Promise<WaitVerdict<T>>,
    promptFor: (message?: string) => string | undefined = (message) => message,
  ): Promise<T> {
    return tracker.wait<T>(opts?.retries ?? DEFAULT_RETRIES, promptFor, async () => accept(await rawWait(opts)))
  }

  const acceptText = (opts?: WaitOptions) => async (m: RuntimeMessage): Promise<WaitVerdict<string>> => {
    if (m.type !== 'text') return { ok: false, message: opts?.otherwise ?? translateFor(m, CORE_MESSAGES.waitText) }
    const v = opts?.validate ? await opts.validate(m.body, m) : true
    return v === true
      ? { ok: true, value: m.body }
      : { ok: false, message: typeof v === 'string' ? v : translateFor(m, CORE_MESSAGES.waitInvalid) }
  }

  const current = () => rt.latestMessage(handle) ?? ctx

  const idle = createIdleControls(rt, handle, ctx, (callback) => tracker.runOutOfBand(callback))

  const controls: ConversationControls = {
    say: async (text) => { rt.assertAlive(handle); await ctx.reply(text) },
    state: rt.getState(handle),
    end: (farewell) => { throw new ConversationEnded(farewell) },
    goto: (name, args) => { throw new ConversationGoto(name, args) },
    waitAny: (o) => tracker.wait<RuntimeMessage>(DEFAULT_RETRIES, (message) => message,
      async () => ({ ok: true, value: await rt.wait(handle, o ?? {}) })),

    waitText: (opts) => loopWait<string>(opts, acceptText(opts)),

    ask: (text, opts) => loopWait<string>(opts, acceptText(opts), (message) => message ?? text),

    waitMedia: (types = [...MEDIA_TYPES], opts) => loopWait<RuntimeMessage>(opts, async (m) => {
      return (types as string[]).includes(m.type)
        ? { ok: true, value: m }
        : { ok: false, message: opts?.otherwise ?? translateFor(m, CORE_MESSAGES.waitMedia) }
    }),

    choose: async (prompt, options, opts) => {
      const keys = Object.keys(options)
      const render = (header: string) => `${header}\n\n${keys.map((k, i) => `${i + 1}) ${options[k]}`).join('\n')}`
      const menu = render(prompt)
      return loopWait<string>(opts, async (m) => {
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
