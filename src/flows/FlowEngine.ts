/**
 * FlowEngine — runtime that drives registered flows.
 *
 * Tracks per-user position. State is locally cached; can be backed by IStore.
 */

import type { EventEmitter } from 'events'
import type { Flow, FlowState, FlowStep, MessageContext } from '../core/types'
import { matchKeyword } from './FlowBuilder'

export interface FlowExecutionState {
  flow: Flow
  currentStep: number
  waitingForCapture: boolean
  lastActivityAt: number
  state: Map<string, unknown>
  timeoutId?: NodeJS.Timeout
  idleTimeoutId?: NodeJS.Timeout
}

export interface FlowEngineOptions {
  /** Auto-expire flows after this many ms of inactivity. Default 5 minutes. */
  idleTimeoutMs?: number
  /** Custom logger (optional). */
  logger?: { debug?: (...args: any[]) => void; warn?: (...args: any[]) => void; info?: (...args: any[]) => void }
  /** Store for persistent flow state (optional). */
  store?: {
    getFlowState(userId: string): Promise<Record<string, unknown> | undefined>
    setFlowState(userId: string, state: Record<string, unknown>): Promise<void>
    clearFlowState(userId: string): Promise<void>
  }
}

export interface RunTools {
  send: (message: string) => Promise<void>
  end: () => void
}

export class FlowEngine {
  private flows: Flow[] = []
  private active = new Map<string, FlowExecutionState>()
  private idleTimeoutMs: number
  private store?: FlowEngineOptions['store']

  constructor(private opts: FlowEngineOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000
    this.store = opts.store
  }

  /** Register a flow for matching. */
  register(flow: Flow): void {
    if (!this.flows.includes(flow)) this.flows.push(flow)
  }

  /** True if a user is mid-flow. */
  hasActive(userId: string): boolean {
    return this.active.has(userId)
  }

  /** Find a flow whose keyword matches the given body. */
  find(body: string): Flow | undefined {
    return this.flows.find((f) => matchKeyword(f.keyword, body, {}))
  }

  /** Start a specific flow for a user. Returns the execution state. */
  start(userId: string, flow: Flow): FlowExecutionState {
    this.end(userId)
    const state: FlowExecutionState = {
      flow,
      currentStep: 0,
      waitingForCapture: false,
      lastActivityAt: Date.now(),
      state: new Map(),
      timeoutId: undefined,
      idleTimeoutId: undefined,
    }
    this.active.set(userId, state)
    this.armIdleTimer(userId)
    this.armFlowTimeout(userId, flow)
    return state
  }

  /** End the active flow for a user. */
  end(userId: string): void {
    const s = this.active.get(userId)
    if (s?.timeoutId) clearTimeout(s.timeoutId)
    if (s?.idleTimeoutId) clearTimeout(s.idleTimeoutId)
    this.active.delete(userId)
    this.store?.clearFlowState(userId).catch(() => {})
  }

  /** Abort the active flow for a user (public, for slash commands). */
  abortFlow(userId: string): void {
    this.end(userId)
  }

  /**
   * Execute the next step of the active flow for this user.
   * Returns true if a flow consumed the message.
   */
  async processStep(
    ctx: MessageContext,
    tools: { send: (msg: string) => Promise<void>; end: () => void }
  ): Promise<boolean> {
    const state = this.active.get(ctx.from)
    if (!state) return false

    state.lastActivityAt = Date.now()
    this.armIdleTimer(ctx.from)

    // If the user is in a capture-wait, capture their reply
    if (state.waitingForCapture) {
      state.state.set('last', ctx.body)
      state.waitingForCapture = false
      state.currentStep++
    }

    const steps = state.flow.steps

    while (state.currentStep < steps.length) {
      const step = steps[state.currentStep]
      const shouldCapture = await this.runStep(step, ctx, state, tools)
      if (shouldCapture) return true   // halt and wait for next message
      state.currentStep++
    }

    // End of flow
    tools.end()
    return true
  }

  /**
   * Start a flow AND execute its first steps immediately.
   * This is the correct entry point when a message triggers a flow.
   * Returns true if the flow consumed the message.
   */
  async startAndRun(ctx: MessageContext, flow: Flow, tools: RunTools): Promise<boolean> {
    this.start(ctx.from, flow)
    return this.processStep(ctx, tools)
  }

  /**
   * Try to match a message to a flow, start it, and run step 0.
   * Returns true if a flow was triggered and consumed the message.
   */
  async runFromMatch(ctx: MessageContext, tools: RunTools, forceFlow?: Flow): Promise<boolean> {
    const flow = forceFlow ?? this.find(ctx.body)
    if (!flow) return false
    return this.startAndRun(ctx, flow, tools)
  }

  // ---------------------------------------------------------------------------

  private async runStep(
    step: FlowStep,
    ctx: MessageContext,
    state: FlowExecutionState,
    tools: { send: (msg: string) => Promise<void>; end: () => void }
  ): Promise<boolean> {
    // Validate captured body if validation set
    if (step.options?.validate && state.state.get('last') !== undefined) {
      const last = String(state.state.get('last'))
      const result = await step.options.validate(last)
      if (result !== true) {
        await tools.send(typeof result === 'string' ? result : '❌ Entrada inválida')
        state.state.delete('last')
        return true // wait again
      }
    }

    // branch steps: pick execution path from state
    if (step.kind === 'branch' || step.kind === 'choose') {
      const condFn = (step as any).__condition
      if (condFn) {
        const mappedState = createFlowStateProxy(state.state)
        const value = await condFn(ctx, mappedState)
        if (typeof value === 'string') {
          const branch = step.branches?.find((b) => b.when === value || matchKeywordSingle(b.when, value))
          if (branch?.then) {
            const subFlow = branch.then as any
            if (isFlow(subFlow)) {
              this.start(ctx.from, subFlow)
              return this.processStep(ctx, tools)
            } else {
              await (subFlow as Function)(ctx, createFlowTools(state, ctx, tools))
            }
          } else if (step.defaultBranch) {
            await step.defaultBranch(ctx, createFlowTools(state, ctx, tools))
          }
          return false
        }
        if (isFlow(value)) {
          this.start(ctx.from, value)
          return this.processStep(ctx, tools)
        }
      }
      // choose-style: look at the last captured body
      const last = String(state.state.get('last') ?? '')
      const branch = step.branches?.find((b) => matchKeywordSingle(b.when, last))
      if (branch?.then) {
        const target = branch.then as any
        if (isFlow(target)) {
          this.start(ctx.from, target)
          return this.processStep(ctx, tools)
        } else {
          await target(ctx, createFlowTools(state, ctx, tools))
        }
        return false
      }
      if (step.defaultBranch) {
        await step.defaultBranch(ctx, createFlowTools(state, ctx, tools))
      }
      return false
    }

    // Send answers
    if (step.answers && step.answers.length > 0) {
      for (const ans of step.answers) {
        if (step.options?.delay) {
          if (step.options.typing !== false) await ctx.typing()
          await sleep(step.options.delay)
        }
        if (typeof ans === 'string') {
          await tools.send(ans)
        } else if (typeof ans === 'function') {
          // Dynamic answer: async function returning string
          const flowTools = createFlowTools(state, ctx, tools)
          const result = await ans(ctx, flowTools)
          if (typeof result === 'string') await tools.send(result)
        } else if (ans && typeof ans === 'object' && 'media' in (ans as any)) {
          await (ctx as any).photo((ans as any).media, (ans as any).caption)
        }
      }
    }

    // Action
    if (step.action) {
      const flowTools = createFlowTools(state, ctx, tools)
      const out = await step.action(ctx, flowTools)
      if (typeof out === 'string') await tools.send(out)
    }

    // Capture next reply?
    return Boolean(step.options?.capture)
  }

  /** Arm the flow-level timeout (from flow.options.timeoutMs). */
  private armFlowTimeout(userId: string, flow: Flow): void {
    const timeoutMs = (flow.options as any)?.timeoutMs
    if (!timeoutMs) return
    const state = this.active.get(userId)
    if (!state) return
    state.timeoutId = setTimeout(() => {
      const s = this.active.get(userId)
      if (!s) return
      this.opts.logger?.warn?.(`flow timeout-expire ${userId}`)
      this.end(userId)
    }, timeoutMs)
  }

  /** Arm the idle timeout (inactivity). */
  private armIdleTimer(userId: string): void {
    const state = this.active.get(userId)
    if (!state) return
    if (state.idleTimeoutId) clearTimeout(state.idleTimeoutId)
    state.idleTimeoutId = setTimeout(() => {
      this.active.delete(userId)
      this.opts.logger?.warn?.(`flow idle-expire ${userId}`)
    }, this.idleTimeoutMs)
  }
}

/* =============================================================================
 * HELPERS
 * ========================================================================== */

function createFlowStateProxy(map: Map<string, unknown>): FlowState {
  return {
    get: <T = unknown>(key: string): T | undefined => map.get(key) as T | undefined,
    set: <T = unknown>(key: string, value: T): void => { map.set(key, value) },
    has: (key: string): boolean => map.has(key),
    delete: (key: string): void => { map.delete(key) },
    clear: (): void => map.clear(),
    all: (): Record<string, unknown> => Object.fromEntries(map),
  }
}

function createFlowTools(
  state: FlowExecutionState,
  _ctx: MessageContext,
  tools: { send: (msg: string) => Promise<void>; end: () => void }
) {
  return {
    state: createFlowStateProxy(state.state),
    say: tools.send,
    goto: (flow: Flow) => { _ctx; /* handled by caller via re-start */ },
    end: tools.end,
    reset: () => { state.currentStep = 0; state.state.clear() },
  }
}

function matchKeywordSingle(keyword: any, body: string): boolean {
  if (keyword instanceof RegExp) return keyword.test(body)
  return body.toLowerCase().includes(String(keyword).toLowerCase())
}

function isFlow(x: any): x is Flow {
  return x && typeof x === 'object' && 'steps' in x && typeof x.test === 'function'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
