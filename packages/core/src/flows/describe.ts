/**
 * Flow introspection — render a bot's flows as a Mermaid flowchart or as a
 * plain JSON graph.
 *
 * DSL flows (`flow()` / `addKeyword()`) are fully introspectable: every
 * say/ask/do/media/choose/goto step becomes a node, `choose` options become
 * labelled branches (a `then` sub-flow is drawn inline, returning to the
 * parent), `goto` becomes a dotted edge to the target flow. Async-function
 * conversations (`bot.conversation(name, fn)`) are opaque: one node with their
 * triggers.
 *
 * @example
 * ```ts
 * import { writeFileSync } from 'node:fs'
 *
 * writeFileSync('flows.mmd', bot.describe())                 // Mermaid (default)
 * const graph = bot.describe({ format: 'json' })              // JSON graph
 * const diagram = describeFlows([flowA, flowB], { direction: 'LR' })  // no Bot needed
 * ```
 */

import type { WaitOptions } from '../core/types.js'
import { parseDuration } from '../utils/duration.js'
import { isCompiledFlow, type CompiledFlow, type CompiledStep } from './FlowBuilder.js'
import {
  describeTrigger,
  functionName,
  listConversations,
  resolveFlowInventory,
  type FlowInventory,
  type FlowSource,
  type InventoryConversation,
  type TriggerInfo,
} from './inventory.js'

/* ============================================================================
 * PUBLIC GRAPH TYPES
 * ========================================================================== */

/** Kind of a node in a {@link FlowGraph}. */
export type FlowGraphNodeKind =
  /** Entry point of a DSL flow, labelled with its triggers. */
  | 'entry'
  | 'say'
  | 'ask'
  /** A `.do()` action, or a `then` action of a `choose` option. */
  | 'do'
  | 'media'
  | 'choose'
  | 'goto'
  /** End of a flow (or an explicit end step). */
  | 'end'
  /** An opaque async-function conversation (single node). */
  | 'conversation'
  /** A `goto` target that is not registered. */
  | 'missing'
  /** A step kind this version does not know — rendered generically. */
  | 'step'

/** Where an `ask`/`choose` wait timeout comes from. */
export type FlowGraphTimeoutSource =
  /** The step's own `{ timeout }` option. */
  | 'step'
  /** The flow's `.timeout()`. */
  | 'flow'
  /** The bot-wide `conversation.timeout`. */
  | 'bot'
  /** Nothing configured: the runtime's built-in 5-minute fallback. */
  | 'builtin'

/** One option of a `choose` node. */
export interface FlowGraphOption {
  /** Option key (stored in `c.state` when picked). */
  key: string
  /** Label shown in the numbered menu. */
  label: string
  /** 1-based menu number the user types. */
  index: number
  /** What runs when picked: an inline sub-flow, an action, or nothing (absent). */
  then?: 'flow' | 'action'
  /** Id of the inline sub-flow, when `then === 'flow'`. */
  thenFlow?: string
}

/** A node of the flow graph. Ids are stable and identical to the Mermaid node ids. */
export interface FlowGraphNode {
  /** Node id, e.g. `f0_in`, `f0_s3`, `f0_s3_o1_s0`, `f0_end`, `f1` (conversation), `x0` (missing target). */
  id: string
  kind: FlowGraphNodeKind
  /** Full human-readable label (lines separated by `\n`; never truncated). */
  label: string
  /** Id of the owning {@link FlowGraphFlow}; absent for `missing` nodes. */
  flow?: string
  /** Innermost inline sub-flow {@link FlowGraphGroup} containing this node. */
  group?: string
  /** Step path inside the flow, e.g. `steps[3].options["tech"].then.steps[0]`. */
  path?: string
  /** Literal text of a say/ask, or the prompt of a choose. Absent when computed at runtime. */
  text?: string
  /** `true` when the say/ask text is a function evaluated at runtime. */
  dynamic?: boolean
  /** `c.state` key an ask/choose writes. */
  stateKey?: string
  /** Effective wait timeout of an ask/choose in ms (`0` = never expires). Absent when unparseable. */
  timeoutMs?: number
  /** Where {@link timeoutMs} comes from. */
  timeoutSource?: FlowGraphTimeoutSource
  /** Target conversation of a `goto` / name of a `missing` node. */
  target?: string
  /** Options of a `choose`, in menu order. */
  options?: FlowGraphOption[]
  /** What a `media` step sends. */
  media?: { source: string; caption?: string }
  /** Name of the function behind a do/then/dynamic text, when it has a meaningful one. */
  action?: string
  /** Raw step kind of an unknown (`step`) or explicit `end` step. */
  stepKind?: string
}

/** Kind of an edge in a {@link FlowGraph}. */
export type FlowGraphEdgeKind =
  /** Sequential flow from one step to the next. */
  | 'next'
  /** A `choose` option being picked (one edge per option). */
  | 'option'
  /** Leaving an inline `then` sub-flow back to the parent flow. */
  | 'return'
  /** A `goto` jump to another conversation (or to a `missing` node). */
  | 'goto'

/** A directed edge between two {@link FlowGraphNode}s. */
export interface FlowGraphEdge {
  from: string
  to: string
  kind: FlowGraphEdgeKind
  /** Menu label for `option` edges, e.g. `2) Otro`. */
  label?: string
  /** Option key for `option` edges. */
  option?: string
}

/** An inline `then` sub-flow drawn inside its parent flow (a nested Mermaid subgraph). */
export interface FlowGraphGroup {
  id: string
  label: string
  /** Owning {@link FlowGraphFlow} id. */
  flow: string
  /** Enclosing group id, for sub-flows nested inside sub-flows. */
  parent?: string
  /** Id of the inline sub-flow. */
  subflow: string
}

/** A registered conversation: a DSL flow or an opaque async conversation. */
export interface FlowGraphFlow {
  /** Graph id (`f0`, `f1`, …) — also the Mermaid subgraph/node id. */
  id: string
  /** Conversation name (`CompiledFlow.id` for DSL flows). */
  name: string
  kind: 'flow' | 'conversation'
  /** Node id where the flow starts (`f0_in` for flows, the single node for conversations). */
  entry: string
  /** Triggers routed to this conversation (empty = no trigger). */
  triggers: TriggerInfo[]
  /** Flow-level `.timeout()` in ms. */
  timeoutMs?: number
  /** Whether the flow is `.persistent()`. */
  persistent: boolean
}

/** JSON-serializable graph of every registered flow (see {@link describeFlows}). */
export interface FlowGraph {
  /** Schema version of this graph format. */
  version: 1
  flows: FlowGraphFlow[]
  groups: FlowGraphGroup[]
  nodes: FlowGraphNode[]
  edges: FlowGraphEdge[]
}

/** Options for {@link describeFlows} / `bot.describe()`. */
export interface DescribeOptions {
  /** `'mermaid'` (default) returns a Mermaid flowchart string; `'json'` returns a {@link FlowGraph}. */
  format?: 'mermaid' | 'json'
  /** Mermaid layout direction (default `'TD'`, top-down). */
  direction?: 'TD' | 'TB' | 'BT' | 'LR' | 'RL'
  /**
   * Max characters of each piece of user text (message, prompt, option, trigger)
   * in Mermaid labels; longer text is cut with `…`. Default `60`; `Infinity` keeps
   * everything. The JSON graph is never truncated.
   */
  maxLabelLength?: number
}

/* ============================================================================
 * describeFlows
 * ========================================================================== */

/**
 * Describe every registered flow/conversation of a bot (or a plain list of
 * flows) as a Mermaid flowchart (default) or a JSON graph.
 *
 * - One Mermaid `subgraph` per DSL flow; its entry node lists the triggers routed
 *   to it (`bot.use`, `bot.when(trigger, flow)`, …).
 * - `choose` options are labelled `1) Label` like the menu the user sees; a
 *   `then` sub-flow is drawn as a nested subgraph that returns to the parent.
 * - `goto` is a dotted edge to the target; an unregistered target is drawn as a
 *   `missing: name` node.
 * - Async conversations are a single node (their body is opaque).
 * - User text is escaped with Mermaid entity codes, so labels can never break
 *   out of their node or inject `%%{init}%%` directives.
 *
 * Node ids are stable and shared by both formats and by `lintFlows()` diagnostics.
 */
export function describeFlows(source: FlowSource, options: DescribeOptions & { format: 'json' }): FlowGraph
export function describeFlows(source: FlowSource, options?: DescribeOptions & { format?: 'mermaid' }): string
export function describeFlows(source: FlowSource, options?: DescribeOptions): string | FlowGraph
export function describeFlows(source: FlowSource, options: DescribeOptions = {}): string | FlowGraph {
  const built = buildFlowGraph(resolveFlowInventory(source), options.maxLabelLength)
  return options.format === 'json' ? built.graph : renderMermaid(built, options)
}

/* ============================================================================
 * TIMEOUTS (shared with lint)
 * ========================================================================== */

/** Fallback wait used by `ConversationRuntime.wait` when nothing else sets one. */
const BUILTIN_WAIT_TIMEOUT_MS = 300_000

/** @internal Effective timeout of one wait, mirroring interpreter → controls → runtime. */
export interface EffectiveTimeout {
  ms?: number
  source: FlowGraphTimeoutSource
  /** The configured value, when it came from the step or the flow. */
  raw?: unknown
  /** The configured value cannot be parsed — the runtime throws when it reaches the wait. */
  invalid: boolean
}

/**
 * @internal Mirrors the runtime exactly: the interpreter spreads `{ timeout: flow.opts.timeoutMs, ...step.opts }`,
 * controls parse it with `parseDuration`, and `ConversationRuntime.wait` falls back to the bot default, then 5 min.
 */
export function effectiveWaitTimeout(stepOpts: WaitOptions | undefined, owner: CompiledFlow, defaultTimeoutMs?: number): EffectiveTimeout {
  const fromStep = stepOpts !== undefined && 'timeout' in stepOpts
  const raw: unknown = fromStep ? stepOpts.timeout : owner.opts.timeoutMs
  if (raw === undefined) {
    return defaultTimeoutMs !== undefined
      ? { ms: defaultTimeoutMs, source: 'bot', invalid: false }
      : { ms: BUILTIN_WAIT_TIMEOUT_MS, source: 'builtin', invalid: false }
  }
  const source: FlowGraphTimeoutSource = fromStep ? 'step' : 'flow'
  try {
    const ms = parseDuration(raw as string | number)
    return Number.isFinite(ms) ? { ms, source, raw, invalid: false } : { source, raw, invalid: true }
  } catch {
    return { source, raw, invalid: true }
  }
}

/** Compact duration for labels: 120000 → `2m`, 1500 → `1500ms`, 0 → `never`. */
function formatDuration(ms: number): string {
  if (ms <= 0) return 'never'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

/* ============================================================================
 * GRAPH BUILDER (shared with lint)
 * ========================================================================== */

/** @internal Extra per-node data the linter needs; not part of the public JSON graph. */
export interface NodeMeta {
  /** The compiled step behind the node (absent for entry/end/conversation/missing/option nodes). */
  step?: CompiledStep
  /** The (sub-)flow whose `opts` govern the step (timeouts). */
  owner?: CompiledFlow
  /** Name of the conversation the node belongs to. */
  conversation?: string
  /** Previous sibling step in the same step sequence. */
  prev?: string
  /**
   * The node runs user code that receives the conversation controls `c` (a `.do()` or `then` action,
   * a dynamic say/ask text, an async conversation), so it may `c.goto()` any flow.
   */
  opaque?: true
}

/** Whether a step runs a user function that receives `c` (`.media()` compiles to a `do` step, but runs no user code). */
function runsUserCode(step: CompiledStep): boolean {
  switch (step.kind) {
    case 'do': return !step.media
    case 'say':
    case 'ask': return typeof step.text === 'function'
    default: return false
  }
}

type LayoutItem = { node: string } | { group: string; items: LayoutItem[] }

/** @internal Everything `describeFlows` and `lintFlows` derive from one inventory. */
export interface BuiltFlowGraph {
  graph: FlowGraph
  inventory: FlowInventory
  conversations: InventoryConversation[]
  meta: Map<string, NodeMeta>
  /** Raw (unescaped, truncated) Mermaid label lines per node. */
  mermaidLines: Map<string, string[]>
  /** Nesting of nodes/groups per DSL flow id, in creation order. */
  layout: Map<string, LayoutItem[]>
}

interface Tail { from: string; kind: FlowGraphEdgeKind; label?: string; option?: string }
interface WalkScope { fid: string; conversation: string; group?: string; items: LayoutItem[]; ancestry: ReadonlySet<CompiledFlow> }
type Shorten = (text: string) => string

/** Collapse every whitespace/control run into one space (labels are single-line). */
function collapse(text: string): string {
  return text.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text)   // code points: never split an emoji's surrogate pair
  if (!(max > 0) || chars.length <= max) return text
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

function pruned<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) if (value[key] === undefined) delete value[key]
  return value
}

const triggerLines = (triggers: TriggerInfo[], s: Shorten): string[] =>
  triggers.length ? triggers.map((t) => `▶ ${s(t.label)}`) : ['▶ (no trigger)']

/** @internal Build the graph once; describe renders it, lint analyzes it. */
export function buildFlowGraph(inventory: FlowInventory, maxLabelLength = 60): BuiltFlowGraph {
  const conversations = listConversations(inventory)
  const graph: FlowGraph = { version: 1, flows: [], groups: [], nodes: [], edges: [] }
  const meta = new Map<string, NodeMeta>()
  const mermaidLines = new Map<string, string[]>()
  const layout = new Map<string, LayoutItem[]>()
  const gotos: Array<{ from: string; target: string }> = []
  const full: Shorten = (t) => collapse(t)
  const short: Shorten = (t) => truncate(collapse(t), maxLabelLength)

  const addNode = (node: Omit<FlowGraphNode, 'label'>, label: (s: Shorten) => string[], items?: LayoutItem[]): void => {
    graph.nodes.push(pruned({ ...node, label: label(full).join('\n') }))
    mermaidLines.set(node.id, label(short))
    items?.push({ node: node.id })
  }
  const connect = (tails: Tail[], to: string): void => {
    for (const t of tails) graph.edges.push(pruned({ from: t.from, to, kind: t.kind, label: t.label, option: t.option }))
  }

  const stepNode = (step: CompiledStep, owner: CompiledFlow, id: string, path: string, scope: WalkScope): void => {
    const base = { id, flow: scope.fid, group: scope.group, path }
    const kind = String((step as { kind?: unknown }).kind)
    const timeoutOf = (opts: WaitOptions | undefined) => {
      const t = effectiveWaitTimeout(opts, owner, inventory.defaultTimeoutMs)
      const suffix = t.source !== 'step' ? '' : t.invalid ? ' ⏱ invalid' : ` ⏱ ${formatDuration(t.ms ?? 0)}`
      return { fields: { timeoutMs: t.ms, timeoutSource: t.source }, suffix }
    }
    const textOf = (text: string | ((...a: never[]) => unknown)) =>
      typeof text === 'function'
        ? { fields: { dynamic: true, action: functionName(text) }, show: (_s: Shorten) => (functionName(text) ? `${functionName(text)}()` : '(dynamic)') }
        : { fields: { text }, show: (s: Shorten) => s(text) }

    switch (step.kind) {
      case 'say': {
        const t = textOf(step.text)
        addNode({ ...base, kind: 'say', ...t.fields }, (s) => [`say: ${t.show(s)}`], scope.items)
        return
      }
      case 'ask': {
        const t = textOf(step.text)
        const w = timeoutOf(step.opts)
        addNode(
          { ...base, kind: 'ask', ...t.fields, stateKey: step.stateKey, ...w.fields },
          (s) => [`ask: ${t.show(s)} → ${s(step.stateKey)}${w.suffix}`],
          scope.items,
        )
        return
      }
      case 'do': {
        if (step.media) {
          const media = step.media
          addNode(
            { ...base, kind: 'media', media: pruned({ source: media.source, caption: media.caption }) },
            (s) => [`media: ${s(media.source)}${media.caption ? ` — ${s(media.caption)}` : ''}`],
            scope.items,
          )
          return
        }
        const action = functionName(step.fn)
        addNode({ ...base, kind: 'do', action }, () => [`do: ${action ? `${action}()` : '(action)'}`], scope.items)
        return
      }
      case 'choose': {
        const w = timeoutOf(step.opts)
        const stateKey = step.stateKey ?? 'choice'
        const options = Object.entries(step.options).map(([key, opt], i) =>
          pruned<FlowGraphOption>({
            key,
            label: opt.label,
            index: i + 1,
            then: isCompiledFlow(opt.then) ? 'flow' : typeof opt.then === 'function' ? 'action' : undefined,
            thenFlow: isCompiledFlow(opt.then) ? opt.then.id : undefined,
          }),
        )
        addNode(
          { ...base, kind: 'choose', text: step.prompt, stateKey, options, ...w.fields },
          (s) => [`choose: ${s(step.prompt)} → ${s(stateKey)}${w.suffix}`],
          scope.items,
        )
        return
      }
      case 'goto':
        addNode({ ...base, kind: 'goto', target: step.target }, (s) => [`goto: ${s(step.target)}`], scope.items)
        return
      default: {
        // Forward compatibility: step kinds added after this version are drawn generically.
        const extra = step as unknown as Record<string, unknown>
        if (kind === 'media' && typeof extra.source === 'string') {
          const source = extra.source
          const caption = typeof extra.caption === 'string' ? extra.caption : undefined
          addNode(
            { ...base, kind: 'media', media: pruned({ source, caption }) },
            (s) => [`media: ${s(source)}${caption ? ` — ${s(caption)}` : ''}`],
            scope.items,
          )
          return
        }
        addNode({ ...base, kind: kind === 'end' ? 'end' : 'step', stepKind: kind }, (s) => [kind === 'end' ? 'end' : s(kind)], scope.items)
      }
    }
  }

  /** Exits of a step: the tails that connect to whatever comes next. */
  const exitsOf = (step: CompiledStep, id: string, path: string, scope: WalkScope): Tail[] => {
    const kind = String((step as { kind?: unknown }).kind)
    if (step.kind === 'goto') {
      gotos.push({ from: id, target: step.target })
      return []
    }
    if (kind === 'end') return []
    if (step.kind !== 'choose') return [{ from: id, kind: 'next' }]

    const out: Tail[] = []
    Object.entries(step.options).forEach(([key, opt], i) => {
      const label = `${i + 1}) ${opt.label}`
      const enter: Tail = { from: id, kind: 'option', label, option: key }
      const then = opt.then
      const optionPath = `${path}.options[${JSON.stringify(key)}].then`
      const optionId = `${id}_o${i}`
      if (isCompiledFlow(then) && scope.ancestry.has(then)) {
        // Hand-built cycle: draw a reference instead of recursing forever.
        addNode({ id: optionId, kind: 'do', flow: scope.fid, group: scope.group, path: optionPath }, (s) => [`then: ${s(then.id)} (recursive)`], scope.items)
        meta.set(optionId, { conversation: scope.conversation })
        connect([enter], optionId)
        out.push({ from: optionId, kind: 'next' })
      } else if (isCompiledFlow(then) && then.steps.length > 0) {
        const items: LayoutItem[] = []
        scope.items.push({ group: optionId, items })
        graph.groups.push(pruned({ id: optionId, label: `then: ${then.id}`, flow: scope.fid, parent: scope.group, subflow: then.id }))
        const inner = walk(then, optionId, `${optionPath}.`, [enter], {
          ...scope, group: optionId, items, ancestry: new Set([...scope.ancestry, then]),
        })
        out.push(...inner.map((t) => (t.kind === 'next' ? { ...t, kind: 'return' as const } : t)))
      } else if (typeof then === 'function') {
        const action = functionName(then)
        addNode(
          { id: optionId, kind: 'do', flow: scope.fid, group: scope.group, path: optionPath, action },
          () => [`then: ${action ? `${action}()` : '(action)'}`],
          scope.items,
        )
        meta.set(optionId, { conversation: scope.conversation, opaque: true })
        connect([enter], optionId)
        out.push({ from: optionId, kind: 'next' })
      } else {
        out.push(enter)
      }
    })
    return out
  }

  const walk = (flow: CompiledFlow, idPrefix: string, pathPrefix: string, incoming: Tail[], scope: WalkScope): Tail[] => {
    let tails = incoming
    let prev: string | undefined
    flow.steps.forEach((step, i) => {
      const id = `${idPrefix}_s${i}`
      const path = `${pathPrefix}steps[${i}]`
      stepNode(step, flow, id, path, scope)
      meta.set(id, { step, owner: flow, conversation: scope.conversation, prev, ...(runsUserCode(step) && { opaque: true as const }) })
      connect(tails, id)
      tails = exitsOf(step, id, path, scope)
      prev = id
    })
    return tails
  }

  conversations.forEach((conversation, index) => {
    const fid = `f${index}`
    const triggers = inventory.routes.filter((r) => r.target === conversation.name).map((r) => describeTrigger(r.trigger))
    const flow = conversation.flow
    if (!flow) {
      graph.flows.push({ id: fid, name: conversation.name, kind: 'conversation', entry: fid, triggers, persistent: false })
      addNode({ id: fid, kind: 'conversation', flow: fid }, (s) => [`conversation: ${s(conversation.name)}`, ...triggerLines(triggers, s)])
      meta.set(fid, { conversation: conversation.name, opaque: true })
      return
    }
    const entry = `${fid}_in`
    graph.flows.push(pruned({
      id: fid, name: conversation.name, kind: 'flow' as const, entry, triggers,
      timeoutMs: flow.opts.timeoutMs, persistent: Boolean(flow.opts.persistent),
    }))
    const items: LayoutItem[] = []
    layout.set(fid, items)
    addNode({ id: entry, kind: 'entry', flow: fid }, (s) => triggerLines(triggers, s), items)
    meta.set(entry, { conversation: conversation.name })
    const tails = walk(flow, fid, '', [{ from: entry, kind: 'next' }], {
      fid, conversation: conversation.name, items, ancestry: new Set([flow]),
    })
    if (tails.length) {
      const end = `${fid}_end`
      addNode({ id: end, kind: 'end', flow: fid }, () => ['end'], items)
      meta.set(end, { conversation: conversation.name })
      connect(tails, end)
    }
  })

  const entries = new Map(graph.flows.map((f) => [f.name, f.entry]))
  const missing = new Map<string, string>()
  for (const { from, target } of gotos) {
    let to = entries.get(target) ?? missing.get(target)
    if (!to) {
      to = `x${missing.size}`
      missing.set(target, to)
      addNode({ id: to, kind: 'missing', target }, (s) => [`missing: ${s(target)}`])
    }
    graph.edges.push({ from, to, kind: 'goto' })
  }

  return { graph, inventory, conversations, meta, mermaidLines, layout }
}

/* ============================================================================
 * MERMAID RENDERER
 * ========================================================================== */

/**
 * Mermaid entity codes for every character that could end a quoted label (`"`),
 * start an entity (`#`), become HTML (`<`, `>`, `&`), open a markdown string
 * (`` ` ``), end an edge label (`|`) or form a `%%` comment/directive.
 */
const MERMAID_ENTITIES: Record<string, string> = {
  '"': '#34;', '#': '#35;', '%': '#37;', '&': '#38;', '<': '#60;', '>': '#62;', '`': '#96;', '|': '#124;',
}

/** Escape text for use inside a double-quoted Mermaid label. */
function escapeMermaid(text: string): string {
  return text.replace(/["#%&<>`|]/g, (ch) => MERMAID_ENTITIES[ch])
}

const SHAPES: Record<FlowGraphNodeKind, readonly [string, string]> = {
  entry: ['([', '])'],
  say: ['[', ']'],
  ask: ['[/', '/]'],
  do: ['(', ')'],
  media: ['[', ']'],
  choose: ['{', '}'],
  goto: ['{{', '}}'],
  end: ['((', '))'],
  conversation: ['[[', ']]'],
  missing: ['>', ']'],
  step: ['[', ']'],
}

const DIRECTIONS: ReadonlySet<string> = new Set(['TD', 'TB', 'BT', 'LR', 'RL'])

function renderMermaid(built: BuiltFlowGraph, options: DescribeOptions): string {
  const { graph, mermaidLines, layout } = built
  const direction = options.direction ?? 'TD'
  // Untyped (JS) callers could otherwise smuggle a newline + arbitrary Mermaid into the header.
  if (!DIRECTIONS.has(direction)) throw new TypeError(`describe(): direction must be one of ${[...DIRECTIONS].join(', ')}`)
  const max = options.maxLabelLength ?? 60
  const short = (t: string) => escapeMermaid(truncate(collapse(t), max))
  const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]))
  const nodeLine = (id: string): string => {
    const [open, close] = SHAPES[kinds.get(id) ?? 'step']
    return `${id}${open}"${(mermaidLines.get(id) ?? []).map(escapeMermaid).join('<br/>')}"${close}`
  }
  const out = [`flowchart ${direction}`]

  const renderItems = (items: LayoutItem[], depth: number): void => {
    const indent = '  '.repeat(depth)
    for (const item of items) {
      if ('node' in item) {
        out.push(indent + nodeLine(item.node))
        continue
      }
      const group = graph.groups.find((g) => g.id === item.group)
      out.push(`${indent}subgraph ${item.group} ["then: ${short(group?.subflow ?? '')}"]`)
      renderItems(item.items, depth + 1)
      out.push(`${indent}end`)
    }
  }

  const flowOf = new Map(graph.nodes.map((n) => [n.id, n.flow]))
  for (const flow of graph.flows) {
    if (flow.kind === 'conversation') {
      out.push(`  ${nodeLine(flow.entry)}`)
      continue
    }
    const extras = [
      flow.timeoutMs !== undefined ? `timeout ${formatDuration(flow.timeoutMs)}` : undefined,
      flow.persistent ? 'persistent' : undefined,
    ].filter((x): x is string => x !== undefined)
    out.push(`  subgraph ${flow.id} ["flow: ${short(flow.name)}${extras.length ? ` (${extras.join(', ')})` : ''}"]`)
    renderItems(layout.get(flow.id) ?? [], 2)
    for (const line of edgeLines(graph.edges.filter((e) => e.kind !== 'goto' && flowOf.get(e.from) === flow.id), short)) {
      out.push(`    ${line}`)
    }
    out.push('  end')
  }
  for (const node of graph.nodes) if (node.kind === 'missing') out.push(`  ${nodeLine(node.id)}`)
  for (const edge of graph.edges) if (edge.kind === 'goto') out.push(`  ${edge.from} -.-> ${edge.to}`)
  return out.join('\n')
}

/** Intra-flow edges; parallel option edges between the same two nodes share one labelled arrow. */
function edgeLines(edges: FlowGraphEdge[], short: (t: string) => string): string[] {
  const merged: Array<{ from: string; to: string; labels: string[] }> = []
  for (const edge of edges) {
    const same = edge.kind === 'option' ? merged.find((m) => m.from === edge.from && m.to === edge.to && m.labels.length > 0) : undefined
    if (same) same.labels.push(edge.label ?? '')
    else merged.push({ from: edge.from, to: edge.to, labels: edge.kind === 'option' ? [edge.label ?? ''] : [] })
  }
  return merged.map((m) => (m.labels.length
    ? `${m.from} -->|"${m.labels.map(short).join(' / ')}"| ${m.to}`
    : `${m.from} --> ${m.to}`))
}
