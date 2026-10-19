/**
 * Durable media replay harness for providers (`serializeMediaRef` / `rehydrateMediaRef`).
 *
 * Bot A receives one media message through the provider's real inbound path and its handler
 * "kills the process" (a {@link crashable} journal that stops answering). Bot B starts on the
 * same journal with the same `instanceId` and a NEW provider instance (a restarted process: no
 * in-memory state survives), replays the journaled record and loads its media. The result says
 * what B's handler saw and what the journal holds.
 *
 * Dependencies are injected (core API slices) so the harness has no runtime imports.
 */

/* Structural slices of the core API (keeps this file free of runtime imports). */
interface InboxLike { list(f?: { state?: string }): Promise<Array<{ id: string; state: string; payload: unknown }>> }
interface BackendLike { inbox: InboxLike; scope?(name: string): BackendLike }
interface CrashableLike extends BackendLike { readonly whenCrashed: Promise<void>; crash(): void }
interface CtxLike { type: string }
interface BotLike {
  on(event: 'error', fn: (e: unknown) => void): unknown
  when(trigger: unknown, fn: (ctx: CtxLike) => Promise<unknown>): unknown
  start(): Promise<void>
  stop(): Promise<void>
  readonly durability?: { scope?: string } | undefined
}

export interface MediaReplayDeps {
  Bot: new (config: Record<string, unknown>) => BotLike
  MemoryDurability: new () => BackendLike
  crashable(backend: BackendLike): CrashableLike
  loadMediaOf(ctx: CtxLike, opts: { throwOnError: true }): Promise<{ buffer: Buffer } | undefined>
  /** The trigger the media message matches (e.g. core's `IMAGE`). */
  trigger: unknown
}

export interface MediaReplayHarness<P> {
  /** A fresh provider instance (a new process). */
  makeProvider(): P
  /** After `bot.start()` (e.g. a gateway HELLO). */
  boot?(provider: P): Promise<void> | void
  /** Deliver the media message through the provider's inbound path. */
  deliver(provider: P): void
}

export interface MediaReplayResult {
  /** What bot B's handler got: `bytes:<utf8>` or `err:<name>:<reason>`. */
  replay: string
  /** The journaled payload of the record, as JSON text. */
  journaled: string
}

function silentLogger(): never {
  const noop = () => {}
  const l: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, level: 'silent' }
  l.child = () => l
  return l as never
}

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Run the crash → restart → replay scenario (see the module docs). */
export async function crashAndReplayMedia<P>(deps: MediaReplayDeps, h: MediaReplayHarness<P>): Promise<MediaReplayResult> {
  const shared = new deps.MemoryDurability()
  const a = deps.crashable(shared)
  const pa = h.makeProvider()
  const botA = new deps.Bot({ provider: pa, logger: silentLogger(), durability: { journal: a, instanceId: 'r1', pollMs: 20 } })
  botA.on('error', () => {})
  botA.when(deps.trigger, async () => {
    a.crash()
    return new Promise(() => {}) // the process is gone
  })
  await botA.start()
  await h.boot?.(pa)
  h.deliver(pa)
  await a.whenCrashed

  const pb = h.makeProvider()
  const botB = new deps.Bot({ provider: pb, logger: silentLogger(), durability: { journal: shared, instanceId: 'r1', pollMs: 20 } })
  botB.on('error', () => {})
  const seen: string[] = []
  botB.when(deps.trigger, async (ctx) => {
    try {
      const m = await deps.loadMediaOf(ctx, { throwOnError: true })
      seen.push(`bytes:${m?.buffer.toString() ?? 'none'}`)
    } catch (error) {
      const e = error as { name?: string; reason?: string }
      seen.push(`err:${e.name}:${e.reason ?? '-'}`)
    }
  })
  try {
    await botB.start()
    await h.boot?.(pb)
    const view = shared.scope && botB.durability?.scope ? shared.scope(botB.durability.scope) : shared
    await until(async () => (await view.inbox.list({ state: 'done' })).length === 1, 'bot B to replay the media message')
    const [record] = await view.inbox.list()
    return { replay: seen[0] ?? 'not run', journaled: JSON.stringify(record?.payload) }
  } finally {
    await botB.stop()
  }
}
