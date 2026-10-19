/**
 * BotCoordination — everything `BotConfig.coordination` adds to a Bot (internal).
 *
 * Kept out of Bot.ts on purpose: the Bot only calls the seams below (dispatcher turns,
 * coordinator start/stop, provider start/stop, the pre-send check), each of which is a
 * no-op path when `coordination` is not configured (the Bot then never builds this).
 */
import type { ConnectionState, IProvider } from '../core/provider.js'
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
/** After stepping down for a dead transport, wait this long before campaigning again (lets a standby win). */
const STEP_DOWN_COOLDOWN_MS = 10_000

export class BotCoordination {
  readonly coordinator: Coordinator
  /** `'leader'`: only the elected replica connects the provider. */
  readonly providerMode: 'leader' | 'shared'
  private readonly gate: ChatTurnGate
  private campaignAbort?: AbortController
  private campaignDone?: Promise<void>
  private leadership?: Leadership
  private offLeaseLost?: () => void
  private readonly providerDownMs: number
  /** Resolves the current leadership's "transport down too long" wait (see {@link onConnection}). */
  private transportDown?: () => void
  private downTimer?: ReturnType<typeof setTimeout>

  constructor(private deps: BotCoordinationDeps) {
    const { config, provider, runtime } = deps
    this.coordinator = config.coordinator
    const session = config.providerSession ?? 'auto'
    this.providerMode = session === 'auto' ? (provider.capabilities.exclusiveSession ? 'leader' : 'shared') : session
    this.providerDownMs = parseTimerDuration(config.providerDownMs ?? '1m', 'coordination.providerDownMs')
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
      expire: async (key) => {
        deps.logger.warn({ key }, 'conversation step outlived coordination.settleMs; suspending it (resumes from its checkpoint)')
        await runtime.suspend(key)
        await runtime.refreshDormant(key)
      },
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
   * The provider's connection state changed (`'connection'` event). With
   * `providerSession: 'leader'`, a transport that stays `'closed'` for `providerDownMs`
   * (logged out, session taken over, reconnect given up) makes this replica step down so
   * a standby connects instead; any other state cancels that countdown.
   */
  onConnection(state: ConnectionState): void {
    if (state !== 'closed') {
      if (this.downTimer) clearTimeout(this.downTimer)
      this.downTimer = undefined
      return
    }
    if (!this.transportDown || this.downTimer) return
    const fire = this.transportDown
    this.downTimer = setTimeout(() => { this.downTimer = undefined; fire() }, this.providerDownMs)
    this.downTimer.unref?.()
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

  /**
   * Checkpoint fence: throws {@link LeaseLostError} when this replica's turn on `key` is known
   * lost (or the turn it holds is no longer valid), so a replica that lost the chat never
   * writes or clears the checkpoint of the replica that took it. Unknown keys pass.
   */
  assertTurn(key: string): void {
    this.gate.assertHeld(key)
  }

  private async campaign(stop: AbortSignal): Promise<void> {
    const { provider, emit, reportError, logger } = this.deps
    const name = `provider:${provider.id}`
    /** The election keeps failing (backend down): reported once per outage, not on every retry. */
    let failing = false
    while (!stop.aborted) {
      let lead: Leadership
      try {
        lead = await this.coordinator.lead(name, { signal: stop })
        failing = false
      } catch (error) {
        if (stop.aborted) return
        if (!failing) reportError(error)
        failing = true
        await sleep(RETRY_MS, stop)
        continue
      }
      if (stop.aborted) { await lead.release().catch(() => {}); return }
      emit('coordination:leader', { name, fence: lead.fence })
      let started = false
      let steppedDown = false
      const down = new Promise<void>((resolve) => { this.transportDown = () => { steppedDown = true; resolve() } })
      try {
        await provider.start()
        started = true
        this.leadership = lead
        await Promise.race([untilAborted(lead.signal, stop), down])
      } catch (error) {
        reportError(error)
      } finally {
        this.transportDown = undefined
        if (this.downTimer) clearTimeout(this.downTimer)
        this.downTimer = undefined
        this.leadership = undefined
        if (started) {
          try { await provider.stop() } catch (error) { reportError(error) }
        }
        await lead.release().catch(() => {})
      }
      if (stop.aborted) return
      const reason = (lead.signal.reason as LeaseLostError | undefined)?.reason
      emit('coordination:follower', { name, ...(reason ? { reason } : {}) })
      if (steppedDown) {
        logger.warn({ name, downMs: this.providerDownMs }, 'provider transport stayed closed; stepped down so a standby replica can connect')
        await sleep(STEP_DOWN_COOLDOWN_MS, stop)
      } else if (!started) {
        await sleep(RETRY_MS, stop)
      }
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
