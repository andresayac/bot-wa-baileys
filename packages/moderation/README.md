# @botmesh/moderation

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

**Group moderation** plugin for [`@botmesh/core`](../core): time-window anti-spam, word/regex filters, link filter (invites to other groups) and `warn` / `mute` / `kick` / `delete` actions, with per-group configuration and an admin bypass.

It is transport-agnostic: chat and user ids are opaque strings, links are detected in the message **text** and every provider capability (delete messages, kick, list admins) is **optional**. If the provider lacks it, the action degrades and is reported.

## Usage

```ts
import { Bot } from '@botmesh/core'
import { moderationPlugin } from '@botmesh/moderation'

const bot = new Bot({ provider })

bot.plug(moderationPlugin({
  provider,                                          // enables delete/kick/admins when the provider supports them
  antiSpam: { maxMessages: 5, windowMs: 10_000, action: 'warn' },
  wordFilter: { banned: ['spam', 'scam', /bit\.ly\/\w+/i], action: 'delete' },
  linkFilter: { action: ['delete', 'kick'], allowInvites: ['MY_GROUP_CODE'] },
  warnings: { max: 3, then: 'kick' },
  groups: {
    [staffGroup]: false,                             // no moderation here
    [salesGroup]: { wordFilter: { banned: ['free'] } },
  },
}))

bot.on('moderation', (report) => {
  // { chatId, senderId, rule, detail, ref, results: [{ action, status }], warnings }
})
```

The plugin hooks into `before('message')` with priority `100` (before other hooks and any handler). A message that breaks a rule runs its actions and does **not** reach the handlers. Messages from a muted user are ignored until the mute expires.

**Mind `groupMode`:** the `Bot`'s `groupMode` filter runs **before** `before('message')` hooks. With `groupMode: 'mentions'` or `'commands'`, group messages that do not mention the bot or are not commands never reach moderation (not even anti-spam or the word/link filters). If the bot must moderate the whole group, use `groupMode: 'all'` (the default); the plugin logs a warning on install when it detects a restrictive `groupMode`.

By default it only moderates **groups** (`applyTo: 'all'` includes private chats). Interactions (buttons, slash commands) and the bot's own messages are never moderated.

## Rules

| Rule | Fields | Default action |
| --- | --- | --- |
| `antiSpam` | `maxMessages`, `windowMs` (sliding window per chat + sender) | `'warn'` |
| `wordFilter` | `banned: (string \| RegExp)[]`, `wholeWord` (default `true`) | `'delete'` |
| `linkFilter` | `groupInvites` (default `true`), `allLinks`, `allowInvites`, `allowDomains`, `invitePatterns` | `['delete', 'warn']` |

- Words are compared without case or accents (`'scam'` detects `'SCÁM'`), except `ñ`, which is a different letter from `n` (`'ano'` does not detect `'año'`), and as a whole word (`'spam'` does not detect `'spammer'` unless `wholeWord: false`). RegExps are tested against the raw text.
- `allowInvites` accepts codes or full invite links (with or without `https://`) and compares the **exact code**: a URL that merely contains the code (e.g. in the query) is not allowed.
- Recognized invites: WhatsApp (`chat.whatsapp.com/…`), Telegram (`t.me/+…`, `t.me/joinchat/…`) and Discord (`discord.gg/…`, `discord.com/invite/…`). Add others with `invitePatterns` (the first capture group is the code).
- `action` accepts one or several actions in order: `['delete', 'warn']`.
- `autoKickOnLink: true` is a shortcut for `linkFilter: { action: ['delete', 'kick'] }` and only applies when you do not define `linkFilter` (globally or in the group override).

## Actions and degradation

| Action | How it runs | Without support |
| --- | --- | --- |
| `delete` | `provider.deleteMessage(ref)` | `status: 'unsupported'`. Without `provider` in the config, `ctx.delete()` is used and `'attempted'` is reported (it cannot be verified) |
| `kick` | `provider.groups.removeParticipants(chatId, [userId])` | `'unsupported'` and, by default, degrades to `mute` (`kickFallback: 'none'` avoids it) |
| `mute` | Internal state: the user's messages are ignored for `muteMs` (default 10 min) | Always available |
| `warn` | `bot.send` to the group, quoting the message and mentioning the user | `'failed'` if the send fails |

Warnings are counted per chat + user; on reaching `warnings.max`, `warnings.then` (`'mute'` or `'kick'`) runs and the counter resets. `warnings: false` disables it.

The provider `groups` namespace is optional and structural:

```ts
interface GroupAdminApi {
  removeParticipants?(chatId: string, userIds: string[]): Promise<unknown>
  getAdmins?(chatId: string): Promise<readonly string[]>
}
```

## Administrators

With `adminBypass` (default `true`) administrators are not moderated. Considered admins:

1. The ids in `admins` (global or per group).
2. Whoever returns `true` from `isAdmin(chatId, userId)`.
3. Those reported by `provider.groups.getAdmins(chatId)`, cached for `adminCacheMs` (default 5 min) and invalidated by the `promote`/`demote` group events.

When someone leaves the group (`remove` event), their warnings, mute and spam window are forgotten.

## `ctx.tools.moderation`

```ts
const mod = bot.injectTools.moderation!
mod.mute(chatId, userId, 30 * 60_000)
mod.unmute(chatId, userId)
mod.isMuted(chatId, userId)
mod.warnings(chatId, userId)
mod.resetWarnings(chatId, userId?)
await mod.kick(chatId, userId)          // → { action: 'kick', status }
mod.setGroupRules(chatId, { antiSpam: false })  // false desactiva, undefined quita el override
mod.invalidateAdmins(chatId?)
```

## Texts

```ts
moderationPlugin({
  messages: {
    warn: '⚠️ {name}: {reason}. Warning {count}/{max}.',
    reasons: { antiSpam: 'easy on the messages', wordFilter: 'no insults', linkFilter: 'no links' },
  },
})
```

## Limitations

- State (windows, warnings, mutes) lives in memory: it is lost on restart.
- No provider in the monorepo exposes `groups.removeParticipants`/`getAdmins` yet; until then `kick` degrades to `mute`.
