# Sub-APIs (v1) → transport escape hatches (v2)

In v1 the bot exposed 5 typed WhatsApp sub-APIs: `bot.groups`,
`bot.profile`, `bot.privacy`, `bot.chats`, `bot.presence`. **In v2 these
were removed from the core**: `@botmesh/core` is transport-agnostic, and
group/privacy/profile management is WhatsApp-specific — it doesn't exist on
Telegram or Discord in the same shape.

## What replaces them

Two layers, depending on what you need:

### 1. Normalized capabilities on every provider

The common operations survived on the shared contract — feature-detect,
never assume:

```ts
await ctx.markRead()     // provider.markRead(refs)
await ctx.typing()       // provider.typing(chatId, state)
await ctx.delete()       // provider.deleteMessage(ref)
bot.on('group', ...)     // group participant changes (add/remove/promote/demote)
bot.on('presence', ...)  // contact presence updates
bot.on('status', ...)    // delivery/read receipts
```

Every provider publishes `provider.capabilities` (`groups`, `presence`,
`edit`, `typing`, ...) so you can branch on what the transport supports.

### 2. The transport-native socket (Baileys only)

For everything else — creating groups, invite links, privacy settings,
chat archive/pin/mute — reach through the Baileys provider to the raw
socket. The provider keeps a debug handle (`provider.connection`) and a
typed getter (`provider.socket`):

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const provider = new BaileysProvider({ session: 'my-bot' })
const bot = new Bot({ provider })

bot.on('ready', async () => {
  const sock = provider.socket // the raw Baileys 7 socket
  if (!sock) return

  // v1 bot.groups.create(...) equivalent:
  const group = await sock.groupCreate('My group', ['573001234567@s.whatsapp.net'])

  // v1 bot.profile.setName(...):
  await sock.updateProfileName('My Bot')

  // v1 bot.privacy.setLastSeen(...):
  await sock.updateLastSeenPrivacy('all')

  // v1 bot.groups.inviteLink(...):
  const code = await sock.groupInviteCode(group.id)
})

await bot.start()
```

::: warning Transport-specific code stays transport-specific
Anything you write against `provider.socket` only works with
`@botmesh/baileys` (and only against a real WhatsApp connection — not the
`MockProvider` used by `createTestBot()`). Guard it behind
`provider.id === 'baileys'` if your code may run on other transports.
:::

See the [Baileys docs](https://github.com/WhiskeySockets/Baileys) for the
full socket API (`groupCreate`, `groupMetadata`, `groupParticipantsUpdate`,
`updateProfilePicture`, `chatModify`, ...).

## Next steps

- [Deployment](./deploy) — production setup
- [API Reference](/api/) — full technical docs
