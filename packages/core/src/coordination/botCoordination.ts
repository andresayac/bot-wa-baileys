/**
 * BotCoordination — everything `BotConfig.coordination` adds to a Bot (internal).
 *
 * Kept out of Bot.ts on purpose: the Bot only calls the seams below (dispatcher turns,
 * coordinator start/stop, provider start/stop, the pre-send check), each of which is a
 * no-op path when `coordination` is not configured (the Bot then never builds this).
 */
import type { IProvider } from '../core/provider.js'
import { ProviderError } from '../core/provider.js'
import type { DispatchContext } from '../core/Dispatcher.js'
import type { ConversationRuntime } from '../conversations/ConversationRuntime.js'
import { parseTimerDuration } from '../utils/timers.js'
import { ChatTurnGate, type TurnRunner } from './turns.js'
import { LeaseLostError, type CoordinationConfig, type Coordinator, type Leadership } from './types.js'

/**
 * `bot.send()` (or a reply) on a replica that is not the provider session's leader, with
 * `providerSession: 'leader'`: this replica's transport is not connected.
 */
export class ProviderNotLeaderError extends ProviderError {
  constructor(readonly providerId: string) {
    super(`This replica does not hold the "${providerId}" provider session (multi-replica coordination); only the leader can send`)
    this.name = 'ProviderNotLeaderError'
  }
}

export interface BotCoordinationDeps {
  config: CoordinationConfig
  provider: IProvider
  runtime: ConversationRuntime
  logger: { warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void }
  /** Late-bound `bot.emit`. */
  emit: (event: string, payload: unknown) => void
  /** The bot's error path (`'error'` event or log). */
  reportError: (error: unknown, ctx?: DispatchContext) => void
}

const RETRY_MS = 1_000

export class BotCoordination {
  readonly coordinator: Coordinator
  /** `'leader'`: only the elected replica connects the provider. */
  readonly providerMode: 'leader' | 'shared'
  private readonly gate: ChatTurnGate
  private campaignAbort?: AbortController
  private campaignDone?: Promise<void>
  private leadership?: Leadership
  private offLeaseLost?: () => void

  constructor(private deps: BotCoordinationDeps) {
    const { config, provider, runtime } = deps
    this.coordinator = config.coordinator
    const session = config.providerSession ?? 'auto'
    this.providerMode = session === 'auto' ? (provider.capabilities.exclusiveSession ? 'leader' : 'shared') : session
    this.gate = new ChatTurnGate({
      coordinator: this.coordinator,
      turnWaitMs: parseTimerDuration(config.turnWaitMs ?? '2m', 'coordination.turnWaitMs'),
      settleMs: parseTimerDuration(config.settleMs ?? '1m', 'coordination.settleMs'),
      refresh: async (key) => {
        await runtime.suspend(key)
        await runtime.refreshDormant(key)
      },
      lost: (key, error) => {
        deps.logger.warn({ key, fence: error.fence, reason: error.reason }, 'chat turn lost; aborting local work for the chat')
        void runtime.suspend(key)
      },
      settle: (key) => runtime.whenSettled(key),
    })
  }

  /** Dispatcher seam ({@link DispatcherDeps.turns}). */
  readonly turns = {
    schedule: (key: string): TurnRunner => this.gate.schedule(key),
    onDrop: (error: unknown, ctx: DispatchContext): void => {
      // Dropped because this replica is stopping: not an error (the message is released for redelivery).
      if (error instanceof LeaseLostError && error.reason === 'stopped') return
      this.deps.reportError(error, ctx)
    },
  }

  /** Lifecycle step `lease` (after the store, before restoring conversations). */
  async start(): Promise<void> {
    this.offLeaseLost ??= this.coordinator.on('lease-lost', (p) => this.deps.emit('coordination:lease-lost', p))
    await this.coordinator.start()
  }

  async stop(): Promise<void> {
    this.offLeaseLost?.()
    this.offLeaseLost = undefined
    await this.coordinator.stop()
  }

  /**
   * Replaces `provider.start()`. `'shared'`: starts it. `'leader'`: campaigns for the
   * `provider:<id>` leadership in the background and starts the provider only once elected
   * (and again after a lost leadership is regained); resolves at once.
   */
  async startProvider(): Promise<void> {
    if (this.providerMode === 'shared') return this.deps.provider.start()
    const ac = new AbortController()
    this.campaignAbort = ac
    this.campaignDone = this.campaign(ac.signal)
  }

  /** Replaces `provider.stop()`: ends the campaign, stops the provider and steps down. */
  async stopProvider(): Promise<void> {
    if (this.providerMode === 'shared') return this.deps.provider.stop()
    this.campaignAbort?.abort()
    await this.campaignDone
    this.campaignAbort = undefined
    this.campaignDone = undefined
  }

  /** True when this replica runs the provider (always, in `'shared'` mode). */
  isProviderLeader(): boolean {
    return this.providerMode === 'shared' || this.leadership !== undefined
  }

  /**
   * Pre-send check: rejects when this replica's turn on the chat being worked on was lost
   * (`LeaseLostError`), or when it does not hold the provider session
   * ({@link ProviderNotLeaderError}).
   */
  assertSend(key: string | undefined): void {
    this.gate.assertHeld(key)
    if (!this.isProviderLeader()) throw new ProviderNotLeaderError(this.deps.provider.id)
  }

  private async campaign(stop: AbortSignal): Promise<void> {
    const { provider, emit, reportError } = this.deps
    const name = `provider:${provider.id}`
    while (!stop.aborted) {
      let lead: Leadership
      try {
        lead = await this.coordinator.lead(name, { signal: stop })
      } catch (error) {
        if (stop.aborted) return
        reportError(error)
        await sleep(RETRY_MS, stop)
        continue
      }
      if (stop.aborted) { await lead.release().catch(() => {}); return }
      emit('coordination:leader', { name, fence: lead.fence })
      let started = false
      try {
        await provider.start()
        started = true
        this.leadership = lead
        await untilAborted(lead.signal, stop)
      } catch (error) {
        reportError(error)
      } finally {
        this.leadership = undefined
        if (started) {
          try { await provider.stop() } catch (error) { reportError(error) }
        }
        await lead.release().catch(() => {})
      }
      if (stop.aborted) return
      const reason = (lead.signal.reason as LeaseLostError | undefined)?.reason
      emit('coordination:follower', { name, ...(reason ? { reason } : {}) })
      if (!started) await sleep(RETRY_MS, stop)
    }
  }
}

function untilAborted(...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    const any = AbortSignal.any(signals)
    if (any.aborted) return resolve()
    any.addEventListener('abort', () => resolve(), { once: true })
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}
