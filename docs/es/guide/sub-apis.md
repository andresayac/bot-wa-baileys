# Sub-APIs

El bot expone 5 sub-APIs tipadas para funcionalidad avanzada de WhatsApp:
`bot.groups`, `bot.profile`, `bot.privacy`, `bot.chats`, `bot.presence`.

::: tip Solo con socket real
Estas llaman directamente al socket subyacente de Baileys, así que solo
funcionan contra una conexión real de WhatsApp — no contra el
`MockProvider` que usa `createTestBot()`.
:::

## groups — gestión de grupos

```ts
const { id } = await bot.groups.create('My group', ['573001234567@s.whatsapp.net'])
const meta = await bot.groups.metadata(id)
const members = await bot.groups.members(id)
const admins = await bot.groups.admins(id)

await bot.groups.addMember(id, '573001112233@s.whatsapp.net')
await bot.groups.removeMember(id, '573001112233@s.whatsapp.net')
await bot.groups.promote(id, '573001112233@s.whatsapp.net')
await bot.groups.demote(id, '573001112233@s.whatsapp.net')

await bot.groups.setName(id, 'New name')
await bot.groups.setDescription(id, 'New description')
await bot.groups.setSetting(id, 'locked')          // 'announcement' | 'not_announcement' | 'locked' | 'unlocked'
await bot.groups.setEphemeral(id, 604800)           // 0 | 86400 | 604800 | 7776000 (seconds)
await bot.groups.setMemberAddMode(id, 'admin_add')  // 'all_member_add' | 'admin_add'

const link = await bot.groups.inviteLink(id)
await bot.groups.revokeInviteLink(id)
const info = await bot.groups.infoFromInvite('invite-code')
await bot.groups.join('invite-code')

const all = await bot.groups.listAll()
const pending = await bot.groups.listJoinRequests(id)
await bot.groups.resolveJoinRequests(id, ['573001112233@s.whatsapp.net'], 'approve') // or 'reject'

await bot.groups.leave(id)
```

## profile — el perfil de tu bot

```ts
await bot.profile.setName('My Bot')
await bot.profile.setStatus('Online')
await bot.profile.setPhoto('https://example.com/avatar.png')
await bot.profile.removePhoto()

const photoUrl = await bot.profile.getPhoto('573001234567@s.whatsapp.net')
const status = await bot.profile.getStatus('573001234567@s.whatsapp.net')
const business = await bot.profile.getBusiness('573001234567@s.whatsapp.net')
const me = bot.profile.getMe() // { id, name?, pushName? } — not async
```

## privacy — configuración de privacidad

```ts
await bot.privacy.setLastSeen('all')          // 'all' | 'contacts' | 'contact_blacklist' | 'none'
await bot.privacy.setOnline('all')            // 'all' | 'match_last_seen'
await bot.privacy.setProfilePicture('contacts')  // 'all' | 'contacts' | 'contact_blacklist' | 'none'
await bot.privacy.setStatus('contacts')       // 'all' | 'contacts' | 'contact_blacklist' | 'none'
await bot.privacy.setReadReceipts('all')      // 'all' | 'none'
await bot.privacy.setGroupsAdd('contacts')    // 'all' | 'contacts' | 'contact_blacklist'
await bot.privacy.setDefaultDisappearing(604800) // 0 | 86400 | 604800 | 7776000 (seconds)

await bot.privacy.block('573001234567@s.whatsapp.net')
await bot.privacy.unblock('573001234567@s.whatsapp.net')
const blocked = await bot.privacy.listBlocked()
```

## chats — gestión de chats

```ts
const chatId = '573001234567@s.whatsapp.net'

await bot.chats.archive(chatId)                 // archive(chatId, archive? = true)
await bot.chats.mute(chatId, 24 * 60 * 60 * 1000) // ms, or null to unmute
await bot.chats.pin(chatId)                      // pin(chatId, pin? = true)
await bot.chats.unpin(chatId)
await bot.chats.star([messageKey], true)         // star(messageKeys, star?)
await bot.chats.markRead(chatId, [messageKey])   // markRead(chatId, messageKeys)
await bot.chats.clear(chatId, [messageKey])      // clear(chatId, messageKeys)
await bot.chats.delete(chatId)

const chats = await bot.chats.list()
```

## presence — presencia y typing

```ts
const chatId = '573001234567@s.whatsapp.net'

await bot.presence.update('composing', chatId)  // 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
await bot.presence.update('recording', chatId)
await bot.presence.update('available')          // presencia global, no necesita chatId

await bot.presence.subscribe(chatId)            // suscribirse a las actualizaciones de presencia de este contacto
```

## Siguientes pasos

- [Despliegue](./deploy) — configuración de producción
- [API Reference](/api/) — documentación técnica completa
