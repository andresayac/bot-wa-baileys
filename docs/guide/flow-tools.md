# Inspect & lint flows

`@bot-wa/core` can describe the flows a bot has registered, as a Mermaid
diagram or a JSON graph, and check them statically for common mistakes.
Nothing is sent and the bot does not need to be started.

## `bot.describe()`: Mermaid diagram or JSON graph

```ts
import { writeFileSync } from 'node:fs'
import { Bot, flow, describeFlows } from '@bot-wa/core'

bot.use(
  flow('register')
    .timeout('2m')
    .ask('Name?', 'name')
    .choose('Plan?', { pro: 'Pro', free: 'Free' })
    .goto('support'),
)
bot.conversation('support', async (c, ctx) => { /* ... */ })

writeFileSync('flows.mmd', bot.describe())         // Mermaid (default): paste it in mermaid.live or a ```mermaid block
const graph = bot.describe({ format: 'json' })     // { version: 1, flows, groups, nodes, edges }, plain JSON data
bot.describe({ direction: 'LR', maxLabelLength: 40 })
describeFlows([flowA, flowB])                       // without a Bot: a list of FlowBuilder/CompiledFlow
```

What it draws:

- One `subgraph` per DSL flow. The entry node (▶) lists **every** trigger
  that starts it (`bot.use`, `bot.when(trigger, flow)`, a
  `bot.conversation` trigger). With `bot.when(trigger, flow)` the flow's own
  trigger is not routed, and the diagram shows that.
- `say`, `ask` (→ state key, ⏱ when the step has its own timeout), `do`
  (with the function name if it has one: `do: saveUser()`), `media`,
  `choose` (a diamond; options are arrows labelled `1) Label`, like the menu
  the user sees), `goto` (a dotted arrow to the target flow) and `end`.
- An option's `then:` is its own node when it is an action, or a nested
  subgraph that returns to the parent's next step when it is a sub-flow.
- The flow's `.timeout()` and `.persistent()` go in the subgraph title.
- A `goto` to a flow that does not exist is drawn as a `missing: name` node.
- Steps after an unconditional `goto` have no incoming arrow (visible dead
  code).
- Async conversations (`bot.conversation(name, fn)`) are opaque: one node
  with their triggers.
- User text is escaped with Mermaid entity codes, so it cannot break a
  label or inject `%%{init}%%` directives. Node ids (`f0_in`, `f0_s3`,
  `f0_end`...) are stable and the same in Mermaid, JSON and lint results.

## `bot.lint()`: static checks

```ts
for (const d of bot.lint({ minSeverity: 'warning' })) {
  bot.logger.warn({ code: d.code, flow: d.flow, path: d.path }, d.message)
}
if (bot.lint().some((d) => d.severity === 'error')) process.exitCode = 1  // CI gate
bot.lint({ rules: { 'missing-timeout': false } })                          // turn a rule off
lintFlows([flowA, flowB])                                                    // without a Bot
```

Each diagnostic is `{ code, severity, message, flow?, nodeId?, path?, trigger? }`,
sorted from most to least severe.

| Code | Severity | What it detects |
| --- | --- | --- |
| `goto-target-missing` | error | `goto('x')` to something not registered (also `goto(builder)` of a regex-triggered flow without `.id()`, whose id changes on every compile) |
| `invalid-timeout` | error | a step timeout that cannot be parsed (`'2 minutos'`) |
| `empty-choice` | error | `choose()` with no options |
| `unreachable-step` | warning | steps after an unconditional `goto` (or after a `choose` whose options all jump away) |
| `unreachable-flow` | warning / info | no trigger can start it and no reachable flow jumps to it. Info when reachable code could still enter it with `c.goto()` |
| `empty-trigger` | warning / info | `addKeyword([])` never matches; `''` matches messages with no text (or everything with contains/startsWith/endsWith); an empty regex. Info if the flow is only a `goto` target |
| `duplicate-trigger` | warning | a route never gets a pattern because an earlier one in the real dispatch order (specificity, then registration) takes it; respects scope and match strategy |
| `flow-id-collision` | warning | two flows/conversations with the same id (e.g. `flow('hola')` and `flow(['Hola', 'hi'])`): only the last one runs |
| `persistent-memory-store` | warning | `.persistent()` with a `MemoryStore` without `file` (checkpoints die on restart) |
| `duplicate-choice` | warning | options with the same key or normalized label |
| `ambiguous-choice` | warning | a numeric key/label out of position (`{ 0: 'Zero', 1: 'One' }`: typing 1 picks '0'), or a label equal to another option's key |
| `missing-timeout` | info | `ask`/`choose` with no timeout and no `conversation.timeout`: the 5-minute fallback applies. Also notes that `then:` sub-flows do not inherit the parent's `.timeout()` |
| `wait-never-expires` | info | timeout `0`: the wait never expires |

`missing-timeout` fires on most small bots by design; use
`minSeverity: 'warning'` for a quieter report.

## Lower-level helpers

- `describeFlows(source, options)` and `lintFlows(source, options)` accept a
  `Bot`, a `FlowInventory` or an array of flows.
- `bot.flowInventory()` returns the snapshot they work on (registrations,
  routes, the default timeout and whether the store is durable) for your
  own tooling. `MemoryStore#durable` is `true` when it has a `file`.
- `describeTrigger(trigger)` returns `{ label, patterns, match, scope, predicate }`.

## Next steps

- [Conversation flows](./flows)
- [Testing](./testing)
