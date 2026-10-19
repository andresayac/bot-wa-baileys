/**
 * Crash simulation for durability tests.
 *
 * {@link crashable} wraps a durability backend so a test can "kill" the process that uses
 * it at a precise point: after `crash()` every journal call of THIS wrapper hangs forever
 * (a dead process makes no progress and writes nothing), while the wrapped backend stays
 * intact for the next incarnation. Arm a crash right before or right after the n-th call
 * of one journal operation to model "the process died before/after this write".
 *
 * {@link CrashableProvider} is a MockProvider whose sends hang after `crash()` (nothing
 * leaves a dead process). Pair both, abandon the bot (never `stop()` it) and start a new
 * Bot on the same inner backend + store with the same `instanceId` to simulate a restart.
 *
 * @example
 * ```ts
 * const shared = new MemoryDurability()
 * const a = crashable(shared)
 * a.crashBefore('outbox.markSent')          // the provider was called, the result is never recorded
 * const botA = new Bot({ provider: pa, store, durability: { journal: a, instanceId: 'i1' } })
 * // … drive botA until a.crashed …
 * const botB = new Bot({ provider: pb, store, durability: { journal: shared, instanceId: 'i1' } })
 * ```
 */

import type { DurabilityBackend, InboxJournal, OutboxJournal } from '../durability/types.js'
import type { ChatId, OutboundContent, SendOptions, SendResult } from '../core/provider.js'
import { MockProvider } from './MockProvider.js'

/** A journal operation, as `'inbox.append'`, `'outbox.markSent'`, … */
export type JournalOp =
  | `inbox.${'append' | 'claim' | 'claimOne' | 'ack' | 'fail' | 'release' | 'extend' | 'replay' | 'get' | 'list' | 'purge'}`
  | `outbox.${'put' | 'begin' | 'markSent' | 'markFailed' | 'claimDue' | 'resolveAmbiguous' | 'get' | 'list' | 'retry' | 'discard' | 'purge'}`

/** A {@link DurabilityBackend} that can be crashed (see {@link crashable}). */
export interface CrashableBackend extends DurabilityBackend {
  /** The wrapped backend (what survives the crash). */
  readonly inner: DurabilityBackend
  /** True once crashed. */
  readonly crashed: boolean
  /** Resolves when the crash happens. */
  readonly whenCrashed: Promise<void>
  /** Crash now: every later call hangs forever. */
  crash(): void
  /** Crash when the `nth` (default 1st) call of `op` starts, before it reaches the backend. */
  crashBefore(op: JournalOp, nth?: number): void
  /** Crash when the `nth` (default 1st) call of `op` committed, before its caller sees the result. */
  crashAfter(op: JournalOp, nth?: number): void
  /** Number of calls of each operation so far. */
  readonly calls: ReadonlyMap<JournalOp, number>
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

/** Wrap `inner` so it can be crashed at a chosen journal operation. */
export function crashable(inner: DurabilityBackend): CrashableBackend {
  let crashed = false
  let onCrash!: () => void
  const whenCrashed = new Promise<void>((r) => { onCrash = r })
  const calls = new Map<JournalOp, number>()
  const armed: Array<{ op: JournalOp; nth: number; when: 'before' | 'after' }> = []

  const crash = () => {
    if (crashed) return
    crashed = true
    onCrash()
  }

  function wrap<J extends object>(journal: J, prefix: 'inbox' | 'outbox'): J {
    return new Proxy(journal, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (typeof value !== 'function' || typeof prop !== 'string') return value
        const op = `${prefix}.${prop}` as JournalOp
        return async (...args: unknown[]) => {
          if (crashed) return never()
          const n = (calls.get(op) ?? 0) + 1
          calls.set(op, n)
          const trap = armed.find((a) => a.op === op && a.nth === n)
          if (trap?.when === 'before') { crash(); return never() }
          const result: unknown = await (value as (...a: unknown[]) => unknown).apply(target, args)
          if (trap?.when === 'after' || crashed) { crash(); return never() }
          return result
        }
      },
    })
  }

  const inbox = wrap(inner.inbox, 'inbox') as InboxJournal
  const outbox = wrap(inner.outbox, 'outbox') as OutboxJournal
  return {
    inner,
    inbox,
    outbox,
    get crashed() { return crashed },
    whenCrashed,
    crash,
    crashBefore(op, nth = 1) { armed.push({ op, nth, when: 'before' }) },
    crashAfter(op, nth = 1) { armed.push({ op, nth, when: 'after' }) },
    calls,
    start: async () => { if (!crashed) await inner.start?.() },
    stop: async () => { if (crashed) return never(); await inner.stop?.() },
  }
}

/** A MockProvider whose sends hang once `crash()` was called (or once `backend` crashed). */
export class CrashableProvider extends MockProvider {
  private dead = false
  constructor(private readonly backend?: Pick<CrashableBackend, 'crashed'>) { super() }
  /** Stop delivering sends: every later `send` hangs forever. */
  crash(): void { this.dead = true }
  get crashed(): boolean { return this.dead || this.backend?.crashed === true }
  override async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    if (this.crashed) return never()
    return super.send(chatId, content, options)
  }
}

