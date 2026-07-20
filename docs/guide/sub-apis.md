# Sub-APIs

The bot exposes 5 typed sub-APIs for advanced WhatsApp functionality.

## groups — group management

```js
const { id } = await bot.groups.create('My group', ['573001234567@s.whatsapp.net'])
const meta = await bot.groups.metadata(id)
const members = await bot.groups.members(id)
const admins = await bot.groups.admins(id)
await bot.groups.addMember(id, '573001112233@s.whatsapp.net')
await bot.groups.removeMember(id, '573001112233@s.whatsapp.net')
await bot.groups.promote(id, '573001112233@s.whatsapp.net')
await bot.groups.demote(id, '573001112233@s.whatsapp.net')
await bot.groups.leave(id)
```

## profile — profile

```js
await bot.profile.setName('My Bot')
await bot.profile.setStatus('Online')
await bot.profile.setPhoto('https://example.com/avatar.png')
await bot.profile.removePhoto()
const url = await bot.profile.getPhoto('573001234567@s.whatsapp.net')
```

## privacy — privacy

```js
await bot.privacy.setLastSeen('all')        // 'all' | 'contacts' | 'none'
await bot.privacy.setOnline('all')
await bot.privacy.setProfilePhoto('contacts')
await bot.privacy.setStatus('contacts')
await bot.privacy.setReadReceipts('all')
await bot.privacy.setGroups('contacts')
```

## chats — chat management

```js
await bot.chats.archive('573001234567@s.whatsapp.net')
await bot.chats.mute('573001234567@s.whatsapp.net', 24 * 60 * 60 * 1000)
await bot.chats.pin('573001234567@s.whatsapp.net')
await bot.chats.unpin('573001234567@s.whatsapp.net')
await bot.chats.markRead('573001234567@s.whatsapp.net')
await bot.chats.delete('573001234567@s.whatsapp.net')
```

## presence — presence & typing

```js
await bot.presence.typing('573001234567@s.whatsapp.net')
await bot.presence.recording('573001234567@s.whatsapp.net')
await bot.presence.paused('573001234567@s.whatsapp.net')
await bot.presence.available()
await bot.presence.unavailable()
```

## Next steps

- [Deployment](./deploy) — production setup
- [API Reference](/api/) — full technical docs