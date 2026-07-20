# Sub-APIs

El bot expone 5 sub-APIs tipadas para acceder a funcionalidad avanzada de
WhatsApp: grupos, perfil, privacidad, chats y presencia.

## groups — gestión de grupos

```js
// Crear grupo
const { id } = await bot.groups.create('Mi grupo', [
  '573001234567@s.whatsapp.net',
  '573009876543@s.whatsapp.net',
])

// Obtener metadata
const meta = await bot.groups.metadata(id)
console.log(meta.subject, meta.participants.length)

// Listar miembros
const members = await bot.groups.members(id)

// Listar admins
const admins = await bot.groups.admins(id)

// Añadir miembros
await bot.groups.addMember(id, '573001112233@s.whatsapp.net')
await bot.groups.addMember(id, ['573001112233@s.whatsapp.net', '573004445566@s.whatsapp.net'])

// Eliminar miembros
await bot.groups.removeMember(id, '573001112233@s.whatsapp.net')

// Promover a admin
await bot.groups.promote(id, '573001112233@s.whatsapp.net')

// Degradar admin
await bot.groups.demote(id, '573001112233@s.whatsapp.net')

// Salir del grupo
await bot.groups.leave(id)
```

## profile — perfil

```js
// Tu perfil
await bot.profile.setName('Mi Bot')
await bot.profile.setStatus('En línea')
await bot.profile.setPhoto('https://example.com/avatar.png')
await bot.profile.removePhoto()

// Foto de perfil de otro usuario
const url = await bot.profile.getPhoto('573001234567@s.whatsapp.net')
// url = 'https://...' o null si no tiene
```

## privacy — privacidad

```js
// Configurar quién puede ver tu:
await bot.privacy.setLastSeen('all')        // 'all' | 'contacts' | 'none'
await bot.privacy.setOnline('all')           // 'all' | 'match_last_seen'
await bot.privacy.setProfilePhoto('contacts')
await bot.privacy.setStatus('contacts')
await bot.privacy.setReadReceipts('all')
await bot.privacy.setGroups('contacts')     // quién puede añadirte a grupos
```

## chats — gestión de chats

```js
// Archivar chat
await bot.chats.archive('573001234567@s.whatsapp.net')

// Silenciar 24 horas
await bot.chats.mute('573001234567@s.whatsapp.net', 24 * 60 * 60 * 1000)

// Desilenciar
await bot.chats.mute('573001234567@s.whatsapp.net', null)

// Fijar chat
await bot.chats.pin('573001234567@s.whatsapp.net')

// Desfijar
await bot.chats.unpin('573001234567@s.whatsapp.net')

// Marcar como leído
await bot.chats.markRead('573001234567@s.whatsapp.net')

// Eliminar chat
await bot.chats.delete('573001234567@s.whatsapp.net')
```

## presence — presencia y typing

```js
// Mostrar "escribiendo..." en un chat
await bot.presence.typing('573001234567@s.whatsapp.net')

// Mostrar "grabando audio..."
await bot.presence.recording('573001234567@s.whatsapp.net')

// Pausar indicador
await bot.presence.paused('573001234567@s.whatsapp.net')

// Marcar como disponible
await bot.presence.available()

// Marcar como no disponible
await bot.presence.unavailable()
```

## Siguientes pasos

- [Despliegue](./deploy) — cómo poner el bot en producción
- [API Reference](/api/) — documentación técnica completa