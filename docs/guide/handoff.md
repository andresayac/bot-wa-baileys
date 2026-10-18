# Human handoff & access lists

Two gates that decide whether the bot answers at all:

- **Human handoff** pauses the bot in one chat while a person (an agent, a
  CRM inbox) takes over.
- **Blacklist / whitelist** drops messages from given senders or chats
  before the bot even stores them.

Both are on the `Bot` (and on `pluginCtx.bot` inside plugins).

## Human handoff

```ts
const bot = new Bot({ provider, store, handoff: { allowCommands: ['/bot'] } })

bot.when('talk to a human', async (ctx) => {
  await ctx.handoff({ reason: 'user request', meta: { queue: 'sales' } })
  await ctx.reply('Connecting you with an agent…')  // the handler that hands off can still reply
})
bot.command('bot', async (ctx) => { await bot.resume(ctx.from); await ctx.reply('🤖 I am back') })

bot.on('handoff', ({ chatId, reason, since, meta }) => crm.assign(chatId, reason))
bot.on('resume', ({ chatId, at, reason, handoff }) => crm.close(chatId))
bot.on('message', (ctx) => { if (bot.isHandedOff(ctx.from)) crm.relay(ctx.from, ctx.body) })

// The agent answers outside the pipeline (a string is sent as text)
await bot.sendTo(chatId, 'Hi, I am Ana 👋')
await bot.resume(chatId, { reason: 'ticket closed' })

bot.isHandedOff(chatId)   // boolean
bot.getHandoff(chatId)    // { chatId, since, reason?, meta? } | undefined (a copy)
bot.listHandoffs()        // HandoffState[]
```

The state is **per chat** (`ctx.from`): a handoff in a group pauses the bot
for every member of that group, but not their DMs.

### What happens while a chat is handed off

- Messages **are persisted**, `before`/`after('message')` hooks **run**
  (a `before` hook can still `abort()`), and the **`'message'` event
  fires**, so an inbox integration sees everything.
- Commands, conversations, dormant checkpoints, matchers and the catch-all
  **do not run**, and `'command:unknown'` is not emitted. Interactions
  (button and list taps) are blocked too.
- **Calls** into the chat are blocked completely: no `before`/`after('call')`
  hooks, no `'call'` event and no [`CALL` trigger](./triggers#call) (counted
  in `metrics().dropped.handoff`).
- **Escape commands** (`handoff.allowCommands`): with or without the prefix,
  compared like commands (case and accents ignored). They only pass when a
  `bot.command()` with that name is registered; otherwise they stay blocked
  and never reach the catch-all. Make that command call `bot.resume(...)`
  rather than start a flow.
- [`bot.onIdle`](./flows#bot-onidle-inactivity-per-chat) timers are cancelled
  and suspended for the chat until it is resumed.

### When the handoff starts

- Every active conversation in the chat is cancelled **silently** (no
  `cancelledMessage`): all participants, whatever the `conversationScope`.
  Its dormant checkpoints are deleted from memory and from the store.
- If `ctx.handoff()` is called inside a flow `.do()`, the flow ends: later
  steps do not run. In flow steps `ctx` is typed as `RuntimeMessage`, so use
  `bot.handoff(ctx.from)` there.

### Return values

- `handoff()` / `resume()` return `Promise<boolean>`: `true` when the state
  changed. They are idempotent: a second handoff neither changes the reason
  nor emits an event.
- The state changes synchronously, so you do not need to `await` it before
  the next line.
- They never reject because of store errors; those go to the `'error'`
  event. They throw a `TypeError` synchronously on an empty chat id.
- `ctx.handoff()` resolves `false` when the context was not built by a bot.
- `bot.sendTo()` goes through the `before`/`after('send')` hooks and the
  outbound ledger, like `bot.send()`. It does not resume the bot.

### Persistence

- The state is stored in `StoredChat.handoff = { since, reason?, meta? }`
  (set to `null` on resume), plus a small index of handed-off chat ids
  under the store cursor key `HANDOFF_INDEX_KEY`.
- `bot.start()` restores it with one read per handed-off chat (stores
  without cursors fall back to `listChats()`). No `'handoff'` event fires on
  restore. It also drops the dormant checkpoints of every handed-off chat,
  so an old flow never resumes after `bot.resume()`.
- A failing restore is reported on `'error'` and never fails `start()`. A
  `resume()` called while the restore is still running waits for it.
- It survives restarts with a persistent store (SQLite, Redis, Postgres,
  MySQL, Mongo, or `MemoryStore` with `file`). `handoff: { persist: false }`
  keeps it in memory only. `meta` must be JSON-serializable.
- `bot.deleteSubject(userId)` forgets the handoff of that user's chat
  without events.

## Blacklist and whitelist

```ts
bot.blacklist.add('573001234567@s.whatsapp.net')        // EXACT ids, as they arrive in ctx.sender / ctx.from
bot.blacklist.add(['a@s.whatsapp.net', '1203630@g.us'])  // a group chat id blocks the whole group
bot.blacklist.remove('a@s.whatsapp.net')
bot.blacklist.has(id); bot.blacklist.list(); bot.blacklist.size; bot.blacklist.clear()

bot.whitelist.add(['vip@s.whatsapp.net', '1203630@g.us']).enable()  // whitelist mode
bot.whitelist.disable(); bot.whitelist.enabled
```

### Access rules

- Both lists are checked against the **sender id and the chat id**, with
  exact equality: the core normalizes nothing. On WhatsApp (Baileys) use the
  full JID, not the bare phone number.
- The blacklist wins. An enabled but empty whitelist blocks everyone. The
  whitelist is disabled by default.
- A whitelisted user passes in any group; a whitelisted group lets all its
  members through.
- `checkAccess(blacklist, whitelist, { chatId, senderId })` returns the same
  decision (`'allowed' | 'blacklisted' | 'not-whitelisted'`) for your own
  code.

### What happens to a blocked message

It is dropped **before persistence**: the message, chat and contact are not
stored, no hooks, commands, conversations or dormant resumes run (the
checkpoint stays as it is), and `'message'` is not emitted. The drop is
debug-logged with `{ gate, chatId, senderId }`, never the body. It applies
to messages, interactions and calls (a blocked call runs no `'call'` hooks,
emits no `'call'` event and reaches no `CALL` trigger); reactions, poll
votes, presence and group events are not filtered. Blocked messages and
calls count in `metrics().dropped.blocked`.

Blocking someone does **not** cancel a conversation already in progress
(their replies just stop arriving). Use `bot.abortConversation(...)` if you
need that.

### Saving the lists

The lists live in memory; persisting them is up to you:

```ts
import fs from 'node:fs'

function save() { fs.writeFileSync('acl.json', JSON.stringify(bot.exportAccessLists())) }
bot.blacklist.onChange(save)
bot.whitelist.onChange(save)

bot.loadAccessLists(JSON.parse(fs.readFileSync('acl.json', 'utf8')))
// format: { blacklist: { ids: [...] }, whitelist: { ids: [...], enabled: true } }
```

- `add`/`remove` take one id or an array and throw `TypeError` on an empty
  or non-string id (validated before anything changes).
- `onChange` only reports effective changes; `load` always reports.
- `loadAccessLists` also accepts plain arrays of ids for each list.

## Next steps

- [Core concepts](./concepts#the-inbound-pipeline): where each gate runs
- [Hooks](./hooks)
- [Control plane](./control-plane)
