/**
 * Flow inventory — a read-only snapshot of what a `Bot` has registered
 * (DSL flows, async conversations and the triggers that route to them), used
 * by `describeFlows()` and `lintFlows()`.
 *
 * Everything here is static introspection: nothing runs a flow, touches a
 * provider or a store. Async-function conversations stay opaque.
 */

import type { MatchStrategy, Trigger, TriggerObject, TriggerScope } from '../core/types.js'
import type { ConversationFn, ConversationRegistration } from '../conversations/ConversationRuntime.js'
import type { IStore } from '../store/IStore.js'
import { MemoryStore } from '../store/MemoryStore.js'
import { NamespacedStore } from '../store/NamespacedStore.js'
import { FlowBuilder, type CompiledFlow } from './FlowBuilder.js'
import { isTypeTrigger, isWelcomeTrigger } from '../core/triggers.js'

/** One trigger → handler registration, in registration order. */
export interface FlowRoute {
  /** Registration sequence number; breaks ties in dispatch order (same specificity → lower `seq` wins). */
  readonly seq: number
  /** The trigger exactly as passed to `bot.when()` / `bot.use()` / `bot.conversation()`. */
  readonly trigger: Trigger
  /** Conversation entered by this route; `undefined` for a plain `bot.when(trigger, handler)`. */
  readonly target?: string
}

/**
 * Snapshot of a bot's flow registrations. Obtain one with `bot.flowInventory()`,
 * or build it yourself to lint flows without a Bot.
 */
export interface FlowInventory {
  /** Every conversation registration, oldest first (re-registering a name appends; the last one is live). */
  readonly registrations: readonly ConversationRegistration[]
  /** Every live trigger route (unsubscribed routes are gone), in registration order. */
  readonly routes: readonly FlowRoute[]
  /** Bot-wide wait timeout in ms (`conversation.timeout`), when configured. */
  readonly defaultTimeoutMs?: number
  /** Whether the bot's store survives a restart. `undefined` = unknown (persistence checks are skipped). */
  readonly durableStore?: boolean
}

/** Anything that can hand out a {@link FlowInventory} — a `Bot` is one. */
export interface FlowInventoryProvider {
  flowInventory(): FlowInventory
}

/**
 * What `describeFlows()` / `lintFlows()` accept: a `Bot` (or any
 * {@link FlowInventoryProvider}), a ready {@link FlowInventory}, or a plain list of
 * flows — each one is then treated as `bot.use(flow)` (routed by its own trigger).
 */
export type FlowSource = FlowInventoryProvider | FlowInventory | ReadonlyArray<FlowBuilder | CompiledFlow>

/** A text or regex pattern of a trigger. */
export type TriggerPatternInfo =
  | { type: 'text'; value: string }
  | { type: 'regex'; source: string; flags: string }

/** Serializable description of a {@link Trigger}, mirroring the dispatcher's matching rules. */
export interface TriggerInfo {
  /** Human-readable form, e.g. `"hola"`, `"a", "b"`, `/\d+/i`, `contains "factura" (dm only)`, `(predicate)`. */
  label: string
  /** Text/regex patterns; empty for predicates and for never-matching `[]` triggers. */
  patterns: TriggerPatternInfo[]
  /** String match strategy (default `equals` — normalized equality). */
  match: MatchStrategy
  /** Chat scope the trigger is restricted to (default `all`). */
  scope: TriggerScope
  /**
   * `true` for a trigger that is opaque to static text analysis: a predicate function, and
   * the special `WELCOME` / type triggers (`IMAGE`, `MEDIA`, `CALL`, …; see `special`).
   */
  predicate: boolean
  /** Set for the special triggers of `core/triggers.ts`: first contact, or the accepted `ctx.type` kinds. */
  special?: { kind: 'welcome' } | { kind: 'type'; types: string[] }
}

/** A conversation as seen by introspection: the live definition of one registered name. */
export interface InventoryConversation {
  readonly name: string
  /** Live DSL flow (last registration), when it is one. */
  readonly flow?: CompiledFlow
  /** Live async function (last registration), when it is one. */
  readonly fn?: ConversationFn
  /** Number of DISTINCT definitions registered under this name (> 1 = id collision). */
  readonly definitions: number
}

/**
 * Records trigger routes for introspection. Owned by the Bot; every
 * `when`/`use`/`conversation` registration adds a route and its unsubscriber
 * removes it again.
 * @internal
 */
export class FlowRouteLog {
  private seq = 0
  private readonly routes = new Set<FlowRoute>()

  /** Record a route; returns a function that removes it. */
  add(trigger: Trigger, target?: string): () => void {
    const route: FlowRoute = { seq: this.seq++, trigger, target }
    this.routes.add(route)
    return () => { this.routes.delete(route) }
  }

  list(): FlowRoute[] { return [...this.routes] }
}

function isFlowList(source: FlowSource): source is ReadonlyArray<FlowBuilder | CompiledFlow> {
  return Array.isArray(source)
}

function isInventoryProvider(source: FlowSource): source is FlowInventoryProvider {
  return typeof (source as Partial<FlowInventoryProvider>).flowInventory === 'function'
}

/** Normalize any {@link FlowSource} into a {@link FlowInventory}. */
export function resolveFlowInventory(source: FlowSource): FlowInventory {
  if (isFlowList(source)) {
    const registrations: ConversationRegistration[] = []
    const routes: FlowRoute[] = []
    source.forEach((item, seq) => {
      const flow = item instanceof FlowBuilder ? item.compile() : item
      registrations.push({ name: flow.id, flow })
      routes.push({ seq, trigger: flow.trigger, target: flow.id })
    })
    return { registrations, routes }
  }
  if (isInventoryProvider(source)) return source.flowInventory()
  return source
}

/** Live conversations, one per registered name, in first-registration order (the runtime's order). */
export function listConversations(inventory: FlowInventory): InventoryConversation[] {
  const byName = new Map<string, ConversationRegistration[]>()
  for (const registration of inventory.registrations) {
    const list = byName.get(registration.name)
    if (list) list.push(registration)
    else byName.set(registration.name, [registration])
  }
  return [...byName].map(([name, registrations]) => {
    const live = registrations[registrations.length - 1]
    const distinct: ConversationRegistration[] = []
    for (const r of registrations) if (!distinct.some((d) => sameDefinition(d, r))) distinct.push(r)
    return { name, flow: live.flow, fn: live.fn, definitions: distinct.length }
  })
}

/** Same builder compiled twice → same step objects; anything else is a different definition. */
function sameDefinition(a: ConversationRegistration, b: ConversationRegistration): boolean {
  if (a.flow && b.flow) {
    const x = a.flow.steps
    const y = b.flow.steps
    return a.flow === b.flow || (x.length === y.length && x.every((step, i) => step === y[i]))
  }
  if (!a.flow && !b.flow) return a.fn === b.fn
  return false
}

function isTriggerObject(t: Trigger): t is TriggerObject {
  return typeof t === 'object' && t !== null && !(t instanceof RegExp) && !Array.isArray(t) && 'pattern' in t
}

/** Function names JS infers from object-literal keys (`{ then: () => … }`) say nothing about the function. */
const INFERRED_NAMES = new Set(['', 'fn', 'then', 'text', 'trigger', 'anonymous'])

/** A user-meaningful function name, or `undefined` for anonymous / key-inferred names. */
export function functionName(fn: unknown): string | undefined {
  if (typeof fn !== 'function') return undefined
  const name = fn.name.replace(/^bound /, '')
  return INFERRED_NAMES.has(name) ? undefined : name
}

/**
 * Describe a {@link Trigger} as plain data, following the dispatcher's rules
 * (`matchTrigger`): strings default to normalized `equals`, RegExps run on the
 * raw body, predicates are opaque.
 *
 * @example
 * describeTrigger({ pattern: 'factura', match: 'contains', scope: 'dm' }).label
 * // → 'contains "factura" (dm only)'
 */
export function describeTrigger(trigger: Trigger): TriggerInfo {
  if (isWelcomeTrigger(trigger)) {
    const scope = trigger.scope ?? 'all'
    return { label: `WELCOME${scopeSuffix(scope)}`, patterns: [], match: 'equals', scope, predicate: true, special: { kind: 'welcome' } }
  }
  if (isTypeTrigger(trigger)) {
    const scope = trigger.scope ?? 'all'
    const types = [...trigger.types]
    const kinds = types.length === 0 ? '(none, never matches)' : types.join(' | ')
    return { label: `type: ${kinds}${scopeSuffix(scope)}`, patterns: [], match: 'equals', scope, predicate: true, special: { kind: 'type', types } }
  }
  if (typeof trigger === 'function') {
    const name = functionName(trigger)
    return { label: name ? `(predicate: ${name})` : '(predicate)', patterns: [], match: 'equals', scope: 'all', predicate: true }
  }
  const obj: TriggerObject = isTriggerObject(trigger) ? trigger : { pattern: trigger }
  const raw = Array.isArray(obj.pattern) ? obj.pattern : [obj.pattern]
  const patterns: TriggerPatternInfo[] = raw.map((p) =>
    p instanceof RegExp ? { type: 'regex', source: p.source, flags: p.flags } : { type: 'text', value: String(p) },
  )
  const match = obj.match ?? 'equals'
  const scope = obj.scope ?? 'all'
  return { label: triggerLabel(patterns, match, scope), patterns, match, scope, predicate: false }
}

function triggerLabel(patterns: TriggerPatternInfo[], match: MatchStrategy, scope: TriggerScope): string {
  if (patterns.length === 0) return '[] (never matches)'
  const body = patterns.map((p) => (p.type === 'regex' ? `/${p.source}/${p.flags}` : JSON.stringify(p.value))).join(', ')
  const prefix = match !== 'equals' && patterns.some((p) => p.type === 'text') ? `${match} ` : ''
  return `${prefix}${body}${scopeSuffix(scope)}`
}

function scopeSuffix(scope: TriggerScope): string {
  return scope !== 'all' ? ` (${scope} only)` : ''
}

/**
 * Does `store` survive a process restart? Unwraps {@link NamespacedStore}; a
 * {@link MemoryStore} is durable only with a `file`. Any other store (SQLite,
 * Redis, Postgres, …) is assumed durable.
 */
export function isDurableStore(store: IStore): boolean {
  let inner: IStore = store
  while (inner instanceof NamespacedStore) inner = inner.innerStore
  return inner instanceof MemoryStore ? inner.durable : true
}
