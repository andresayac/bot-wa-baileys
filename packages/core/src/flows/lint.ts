/**
 * Flow linter — static checks over a bot's registered flows, conversations and
 * triggers. Nothing runs: it inspects the same graph `describeFlows()` draws,
 * so every diagnostic's `nodeId` matches a node of the Mermaid/JSON output.
 *
 * @example
 * ```ts
 * for (const d of bot.lint({ minSeverity: 'warning' })) {
 *   bot.logger.warn({ code: d.code, flow: d.flow, path: d.path }, d.message)
 * }
 * // CI gate: fail the build on errors
 * if (lintFlows(bot).some((d) => d.severity === 'error')) process.exitCode = 1
 * ```
 */

import type { TriggerScope } from '../core/types.js'
import { normalizeText, triggerSpecificity } from '../core/matching.js'
import type { CompiledStep } from './FlowBuilder.js'
import { buildFlowGraph, effectiveWaitTimeout, type FlowGraphNode } from './describe.js'
import { describeTrigger, resolveFlowInventory, type FlowRoute, type FlowSource, type TriggerInfo } from './inventory.js'

/** How bad a diagnostic is. `error` = fails at runtime; `warning` = almost surely a bug; `info` = advisory. */
export type LintSeverity = 'error' | 'warning' | 'info'

/**
 * Stable diagnostic codes.
 *
 * | code | severity | meaning |
 * | --- | --- | --- |
 * | `goto-target-missing` | error | `goto('x')` targets a conversation that is not registered |
 * | `invalid-timeout` | error | a step `timeout` the runtime cannot parse (`'2 minutos'`) |
 * | `empty-choice` | error | `choose()` without options — every answer is rejected |
 * | `unreachable-step` | warning | steps after an unconditional `goto` (or an end step) |
 * | `unreachable-flow` | warning / info | no trigger can start it and no reachable flow jumps to it (info when reachable code could still `c.goto()` it) |
 * | `empty-trigger` | warning / info | `[]` never matches (info for a flow entered only by `goto()`/`c.goto()`); `''` matches empty-body messages (or everything) |
 * | `duplicate-trigger` | warning | a route never fires: an earlier route in dispatch order owns the same pattern |
 * | `flow-id-collision` | warning | two different flows/conversations share one id; only the last one runs |
 * | `persistent-memory-store` | warning | `.persistent()` with only the RAM store: checkpoints die on restart |
 * | `duplicate-choice` | warning | `choose()` options with the same (normalized) key or label |
 * | `ambiguous-choice` | warning | typing an option's key/label picks a different option |
 * | `missing-timeout` | info | ask/choose falls back to the built-in 5-minute wait |
 * | `wait-never-expires` | info | ask/choose with a `0` timeout never expires |
 */
export type LintCode =
  | 'goto-target-missing'
  | 'invalid-timeout'
  | 'empty-choice'
  | 'unreachable-step'
  | 'unreachable-flow'
  | 'empty-trigger'
  | 'duplicate-trigger'
  | 'flow-id-collision'
  | 'persistent-memory-store'
  | 'duplicate-choice'
  | 'ambiguous-choice'
  | 'missing-timeout'
  | 'wait-never-expires'

/** One finding. Plain data — safe to `JSON.stringify`, log or send to a dashboard. */
export interface LintDiagnostic {
  code: LintCode
  severity: LintSeverity
  /** Self-contained, human-readable explanation (names the flow and step). */
  message: string
  /** Conversation the finding belongs to; absent for a plain `bot.when()` handler route. */
  flow?: string
  /** Node id in `describeFlows()` output (Mermaid and JSON). */
  nodeId?: string
  /** Step path inside the flow, e.g. `steps[2]` or `steps[0].options["x"].then.steps[1]`. */
  path?: string
  /** Label of the offending trigger (trigger diagnostics). */
  trigger?: string
}

/** Options for {@link lintFlows} / `bot.lint()`. */
export interface LintOptions {
  /** Drop diagnostics below this severity (default `'info'`: keep everything). */
  minSeverity?: LintSeverity
  /** Turn individual rules off, e.g. `{ 'missing-timeout': false }`. Rules are on by default. */
  rules?: Partial<Record<LintCode, boolean>>
}

const RANK: Record<LintSeverity, number> = { info: 0, warning: 1, error: 2 }

/** Ids `FlowBuilder` generates for flows without a string trigger or `.id()` — new on every `compile()`. */
const ANONYMOUS_ID = /^flow_\d+_\d+$/

/**
 * Statically check a bot's flows (or a plain list of flows) and return
 * structured diagnostics, most severe first (stable within a severity).
 *
 * Opaque code is never guessed at: async conversations, `.do()`/`then` actions,
 * dynamic texts and predicate triggers are treated as "could do anything" —
 * including `c.goto()` to any flow — so the linter only warns about what is
 * certain from the declared structure. See {@link LintCode} for every check.
 */
export function lintFlows(source: FlowSource, options: LintOptions = {}): LintDiagnostic[] {
  const built = buildFlowGraph(resolveFlowInventory(source))
  const { graph, inventory, conversations, meta } = built
  const out: LintDiagnostic[] = []
  const report = (d: LintDiagnostic): void => {
    if (options.rules?.[d.code] === false) return
    for (const key of Object.keys(d) as Array<keyof LintDiagnostic>) if (d[key] === undefined) delete d[key]
    out.push(d)
  }

  const names = new Set(conversations.map((c) => c.name))
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const successors = new Map<string, string[]>()
  const incoming = new Map<string, number>()
  for (const edge of graph.edges) {
    if (edge.kind === 'goto') continue
    const next = successors.get(edge.from)
    if (next) next.push(edge.to)
    else successors.set(edge.from, [edge.to])
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }

  // Intra-flow reachability: every node reachable from its flow's entry without leaving the flow
  // (an async conversation is a single node: its entry).
  const reachedNodes = new Set<string>()
  const visit = (start: string, into: Set<string>, allow: (id: string) => boolean = () => true): void => {
    const stack = [start]
    while (stack.length) {
      const id = stack.pop()!
      if (into.has(id) || !allow(id)) continue
      into.add(id)
      stack.push(...(successors.get(id) ?? []))
    }
  }
  for (const flow of graph.flows) visit(flow.entry, reachedNodes)

  // Cross-flow reachability: start from conversations with a trigger that can match, follow live gotos.
  const triggerInfo = new Map<FlowRoute, TriggerInfo>(inventory.routes.map((r) => [r, describeTrigger(r.trigger)]))
  const canMatch = (info: TriggerInfo) => info.predicate || info.patterns.length > 0
  const live = new Set(inventory.routes.filter((r) => r.target !== undefined && canMatch(triggerInfo.get(r)!)).map((r) => r.target!))
  const reached = new Set(live)
  const queue = [...live]
  while (queue.length) {
    const name = queue.shift()!
    const flow = graph.flows.find((f) => f.name === name)
    if (flow?.kind !== 'flow') continue
    for (const node of graph.nodes) {
      if (node.flow !== flow.id || node.kind !== 'goto' || !reachedNodes.has(node.id)) continue
      const target = node.target!
      if (names.has(target) && !reached.has(target)) { reached.add(target); queue.push(target) }
    }
  }

  // Opaque code (a .do() or then action, a dynamic say/ask text, an async conversation) receives `c` and may
  // c.goto() ANY flow. Once such code can run, a flow nothing above reaches is only possibly dead, not certainly.
  const reachedFlowIds = new Set(graph.flows.filter((f) => reached.has(f.name)).map((f) => f.id))
  const codeMayGoto = graph.nodes.some((node) =>
    meta.get(node.id)?.opaque === true && node.flow !== undefined && reachedFlowIds.has(node.flow) && reachedNodes.has(node.id))

  /* ---- conversation-level checks ---------------------------------------- */
  graph.flows.forEach((flow, i) => {
    const conversation = conversations[i]
    const what = flow.kind === 'flow' ? 'Flow' : 'Conversation'
    if (conversation.definitions > 1) {
      report({
        code: 'flow-id-collision', severity: 'warning', flow: flow.name, nodeId: flow.entry,
        message: `"${flow.name}" is registered ${conversation.definitions} times with different definitions (flows/conversations sharing one id). ` +
          'Only the last registration runs, and every trigger of the earlier ones starts it instead. Give each flow a unique .id().',
      })
    }
    if (conversation.flow?.opts.persistent && inventory.durableStore === false) {
      report({
        code: 'persistent-memory-store', severity: 'warning', flow: flow.name, nodeId: flow.entry,
        message: `Flow "${flow.name}" is persistent(), but the bot only has the in-memory store: its checkpoints are lost on restart. ` +
          "Use storeConfig: { file: './store.json' } or a durable store (SQLite, Redis, Postgres, …).",
      })
    }
    if (!reached.has(flow.name)) {
      const routes = inventory.routes.filter((r) => r.target === flow.name)
      const reason = routes.length === 0
        ? 'it has no trigger'
        : `its trigger ${routes.map((r) => triggerInfo.get(r)!.label).join(' / ')} never matches`
      report({
        code: 'unreachable-flow', severity: codeMayGoto ? 'info' : 'warning', flow: flow.name, nodeId: flow.entry,
        message: codeMayGoto
          ? `${what} "${flow.name}" is not started by any trigger (${reason}) and no reachable flow jumps to it with goto(). ` +
            `It may still be entered with c.goto("${flow.name}") from code (a .do() or choose then action, a dynamic text or an ` +
            'async conversation), which the linter cannot see into; if nothing calls it, it never runs.'
          : `${what} "${flow.name}" can never start: ${reason}, no reachable flow jumps to it with goto(), and no reachable code ` +
            `(.do() or then action, dynamic text, async conversation) could call c.goto("${flow.name}"). ` +
            'Give it a trigger, or goto() it from a reachable flow.',
      })
    }
  })

  /* ---- step-level checks ------------------------------------------------- */
  for (const node of graph.nodes) {
    const m = meta.get(node.id)
    if (!m?.step || !node.path) continue
    const where = `${node.kind} at ${node.path} of flow "${m.conversation}"`
    const at = { flow: m.conversation, nodeId: node.id, path: node.path }

    if (!reachedNodes.has(node.id)) {
      // Dead code is reported once, at the head of each unreachable run.
      if ((incoming.get(node.id) ?? 0) === 0) {
        const run = new Set<string>()
        visit(node.id, run, (id) => !reachedNodes.has(id))
        const more = [...run].filter((id) => id !== node.id && nodeById.get(id)?.path).length
        report({
          code: 'unreachable-step', severity: 'warning', ...at,
          message: `Step ${node.path} (${node.kind}) of flow "${m.conversation}" never runs: ${unreachableReason(m.prev ? nodeById.get(m.prev) : undefined)}.` +
            (more ? ` ${more} more step${more > 1 ? 's' : ''} after it never run${more > 1 ? '' : 's'} either.` : ''),
        })
      }
      continue
    }

    const step: CompiledStep = m.step
    if (step.kind === 'goto' && !names.has(step.target)) {
      report({
        code: 'goto-target-missing', severity: 'error', ...at,
        message: `goto("${step.target}") in flow "${m.conversation}" (${node.path}) targets a conversation that is not registered — ` +
          'the conversation fails with an error when it gets there.' +
          (ANONYMOUS_ID.test(step.target)
            ? ` "${step.target}" is an auto-generated id: the target flow has a regex/predicate trigger and no .id(), so every compile() ` +
              'gives it a new id. Give it a stable .id("…") and goto that name.'
            : ''),
      })
    }

    if ((step.kind === 'ask' || step.kind === 'choose') && m.owner) {
      const t = effectiveWaitTimeout(step.opts, m.owner, inventory.defaultTimeoutMs)
      if (t.invalid) {
        report({
          code: 'invalid-timeout', severity: 'error', ...at,
          message: `${cap(where)} has timeout ${JSON.stringify(t.raw)}, which the runtime cannot parse — the conversation fails when it reaches this step. ` +
            "Use e.g. '30s', '2m', '1h' or a number of milliseconds.",
        })
      } else if (t.source === 'builtin') {
        const parent = conversations.find((c) => c.name === m.conversation)?.flow
        const inherited = parent && parent !== m.owner && parent.opts.timeoutMs !== undefined
        report({
          code: 'missing-timeout', severity: 'info', ...at,
          message: `${cap(where)} has no timeout and the bot sets no conversation.timeout, so it falls back to the built-in 5m. ` +
            (inherited ? `Inline then sub-flows do not inherit the parent flow's .timeout(): set one on "${m.owner.id}" too. ` : '') +
            'Set .timeout() on the flow, a { timeout } on the step, or conversation.timeout on the Bot.',
        })
      } else if ((t.ms ?? 0) <= 0) {
        report({
          code: 'wait-never-expires', severity: 'info', ...at,
          message: `${cap(where)} never times out (its ${t.source} timeout is ${formatRaw(t.raw ?? t.ms)}): a user who stops answering keeps ` +
            'this conversation open until a command such as /reset.',
        })
      }
    }

    if (step.kind === 'choose') lintChoose(step, where, at, report)
  }

  /* ---- trigger-level checks ---------------------------------------------- */
  const gotoOnly = new Set([...reached].filter((name) => !live.has(name)))
  for (const route of inventory.routes) {
    const info = triggerInfo.get(route)!
    if (info.predicate) continue
    const who = routeOwner(route, graph.flows)
    const base = { flow: route.target, trigger: info.label, nodeId: entryOf(route, graph.flows) }
    if (info.patterns.length === 0) {
      if (route.target === undefined) {
        report({ code: 'empty-trigger', severity: 'warning', ...base, message: 'A bot.when([]) handler never runs: an empty trigger list matches nothing.' })
      } else {
        const viaGoto = gotoOnly.has(route.target)
        const viaCode = !reached.has(route.target) && codeMayGoto
        report({
          code: 'empty-trigger', severity: viaGoto || viaCode ? 'info' : 'warning', ...base,
          message: `Trigger [] of ${who} never matches anything` +
            (viaGoto
              ? ' — the flow is only entered through goto(), which is fine if intended.'
              : viaCode
                ? ` — no goto() reaches it either, so it can only be entered with c.goto("${route.target}") from code, which is fine if intended.`
                : '.'),
        })
      }
      continue
    }
    for (const pattern of info.patterns) {
      if (pattern.type === 'text' && normalizeText(pattern.value) === '') {
        report({
          code: 'empty-trigger', severity: 'warning', ...base,
          message: info.match === 'equals'
            ? `Trigger ${info.label} of ${who} has an empty pattern: it matches only messages whose text is empty (media without caption, stickers, …).`
            : `Trigger ${info.label} of ${who} has an empty pattern with match "${info.match}": it matches every message, so it captures all traffic.`,
        })
        break
      }
      if (pattern.type === 'regex' && pattern.source === '(?:)') {
        report({ code: 'empty-trigger', severity: 'warning', ...base, message: `Trigger ${info.label} of ${who} is an empty regex: it matches every message.` })
        break
      }
    }
  }

  // Duplicate triggers, in the dispatcher's real order: specificity desc, then registration order.
  const order = [...inventory.routes].sort((a, b) => triggerSpecificity(b.trigger) - triggerSpecificity(a.trigger) || a.seq - b.seq)
  const owners = new Map<string, Array<{ route: FlowRoute; scope: TriggerScope }>>()
  for (const route of order) {
    const info = triggerInfo.get(route)!
    if (info.predicate) continue
    const keys = patternKeys(info)
    const shadowed = new Map<FlowRoute, string[]>()
    for (const { key, label } of keys) {
      const prior = owners.get(key)?.find((o) => o.scope === 'all' || o.scope === info.scope)
      // Two plain handlers may share a trigger on purpose (ctx.pass() chains): only flag routes involving a conversation.
      if (!prior || (prior.route.target === undefined && route.target === undefined)) continue
      shadowed.set(prior.route, [...(shadowed.get(prior.route) ?? []), label])
    }
    for (const { key } of keys) owners.set(key, [...(owners.get(key) ?? []), { route, scope: info.scope }])
    for (const [prior, labels] of shadowed) {
      const it = labels.length > 1 ? 'them' : 'it'
      report({
        code: 'duplicate-trigger', severity: 'warning', flow: route.target, trigger: info.label, nodeId: entryOf(route, graph.flows),
        message: prior.target !== undefined && prior.target === route.target
          ? `${cap(routeOwner(route, graph.flows))} is routed twice with ${labels.join(', ')}; the later registration is redundant.`
          : `${cap(routeOwner(route, graph.flows))} never receives ${labels.join(', ')}: ${routeOwner(prior, graph.flows)} already handles ${it} ` +
            'and comes first in dispatch order (higher specificity, or registered earlier).',
      })
    }
  }

  const min = RANK[options.minSeverity ?? 'info']
  return out.filter((d) => RANK[d.severity] >= min).sort((a, b) => RANK[b.severity] - RANK[a.severity])
}

/* ============================================================================
 * HELPERS
 * ========================================================================== */

type Report = (d: LintDiagnostic) => void
type At = { flow?: string; nodeId: string; path: string }

function lintChoose(step: Extract<CompiledStep, { kind: 'choose' }>, where: string, at: At, report: Report): void {
  const keys = Object.keys(step.options)
  const label = (key: string) => step.options[key].label
  const q = (s: string) => JSON.stringify(s)
  if (keys.length === 0) {
    report({ code: 'empty-choice', severity: 'error', ...at, message: `${cap(where)} has no options: every answer is rejected until the retries run out.` })
    return
  }
  for (const group of groupBy(keys, (k) => normalizeText(k))) {
    report({
      code: 'duplicate-choice', severity: 'warning', ...at,
      message: `${cap(where)}: options ${group.map(q).join(' and ')} have the same key once normalized — typing it always picks ${q(group[0])}.`,
    })
  }
  for (const group of groupBy(keys, (k) => normalizeText(label(k)))) {
    report({
      code: 'duplicate-choice', severity: 'warning', ...at,
      message: `${cap(where)}: options ${group.map(q).join(' and ')} share the label ${q(label(group[0]))} — typing it always picks ${q(group[0])}; ` +
        'the others are only reachable by their number.',
    })
  }
  // The runtime resolves an answer by menu number first, then by key, then by label.
  keys.forEach((key, i) => {
    for (const [what, text] of [['key', key], ['label', label(key)]] as const) {
      const n = normalizeText(text)
      if (!/^\d+$/.test(n)) continue
      const num = parseInt(n, 10)
      if (num !== i + 1 && num >= 1 && num <= keys.length) {
        report({
          code: 'ambiguous-choice', severity: 'warning', ...at,
          message: `${cap(where)}: option ${q(key)} has the ${what} ${q(text)}, but typing ${num} selects option ${num} (${q(keys[num - 1])}) by menu position.`,
        })
      }
    }
    const own = normalizeText(label(key))
    if (!own) return
    for (const other of keys) {
      if (other === key || normalizeText(other) !== own || normalizeText(other) === normalizeText(key)) continue
      report({
        code: 'ambiguous-choice', severity: 'warning', ...at,
        message: `${cap(where)}: the label ${q(label(key))} of option ${q(key)} equals the key of option ${q(other)} — typing it picks ${q(other)}.`,
      })
    }
  })
}

/** Groups of 2+ items sharing a non-empty key, in first-seen order. */
function groupBy(items: string[], keyOf: (item: string) => string): string[][] {
  const groups = new Map<string, string[]>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

/** Dispatcher-equivalent identity of each pattern: same key + overlapping scope = same messages. */
function patternKeys(info: TriggerInfo): Array<{ key: string; label: string }> {
  const keys: Array<{ key: string; label: string }> = []
  for (const p of info.patterns) {
    if (p.type === 'regex') {
      keys.push({ key: `re:/${p.source}/${p.flags}`, label: `/${p.source}/${p.flags}` })
      continue
    }
    const normalized = normalizeText(p.value)
    if (normalized) keys.push({ key: `${info.match}:${normalized}`, label: JSON.stringify(p.value) })
  }
  return keys
}

function routeOwner(route: FlowRoute, flows: ReadonlyArray<{ name: string; kind: string }>): string {
  if (route.target === undefined) return 'a bot.when() handler'
  const kind = flows.find((f) => f.name === route.target)?.kind === 'conversation' ? 'conversation' : 'flow'
  return `${kind} "${route.target}"`
}

function entryOf(route: FlowRoute, flows: ReadonlyArray<{ name: string; entry: string }>): string | undefined {
  return route.target === undefined ? undefined : flows.find((f) => f.name === route.target)?.entry
}

function unreachableReason(prev: FlowGraphNode | undefined): string {
  switch (prev?.kind) {
    case 'goto': return `the step before it (goto "${prev.target}") always leaves the flow`
    case 'choose': return 'every option of the choose before it leaves the flow'
    case 'end': return 'the step before it always ends the conversation'
    default: return 'nothing leads to it'
  }
}

function formatRaw(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
