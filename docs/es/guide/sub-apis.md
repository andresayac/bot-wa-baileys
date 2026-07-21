# Sub-APIs (v1) → escape hatches del transporte (v2)

En v1 el bot exponía 5 sub-APIs tipadas de WhatsApp: `bot.groups`,
`bot.profile`, `bot.privacy`, `bot.chats`, `bot.presence`. **En v2 fueron
eliminadas del core**: `@bot-wa/core` es agnóstico de transporte, y la
gestión de grupos/privacidad/perfil es específica de WhatsApp — no existe
con la misma forma en Telegram o Discord.

## Qué las reemplaza

Dos capas, según lo que necesites:

### 1. Capacidades normalizadas en todos los providers

Las operaciones comunes sobrevivieron en el contrato compartido — detecta
la capacidad, nunca asumas:

```ts
await ctx.markRead()     // provider.markRead(refs)
await ctx.typing()       // provider.typing(chatId, state)
await ctx.delete()       // provider.deleteMessage(ref)
bot.on('group', ...)     // cambios de participantes (add/remove/promote/demote)
bot.on('presence', ...)  // actualizaciones de presencia de contactos
bot.on('status', ...)    // recibos de entrega/lectura
```

Cada provider publica `provider.capabilities` (`groups`, `presence`,
`edit`, `typing`, ...) para que puedas ramificar según lo que el
transporte soporta.

### 2. El socket nativo del transporte (solo Baileys)

Para todo lo demás — crear grupos, links de invitación, ajustes de
privacidad, archivar/fijar/silenciar chats — accede al socket crudo desde
el provider de Baileys. El provider mantiene un handle de depuración
(`provider.connection`) y un getter tipado (`provider.socket`):

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const provider = new BaileysProvider({ session: 'mi-bot' })
const bot = new Bot({ provider })

bot.on('ready', async () => {
  const sock = provider.socket // el socket crudo de Baileys 7
  if (!sock) return

  // Equivalente de bot.groups.create(...) de v1:
  const group = await sock.groupCreate('My group', ['573001234567@s.whatsapp.net'])

  // bot.profile.setName(...) de v1:
  await sock.updateProfileName('My Bot')

  // bot.privacy.setLastSeen(...) de v1:
  await sock.updateLastSeenPrivacy('all')

  // bot.groups.inviteLink(...) de v1:
  const code = await sock.groupInviteCode(group.id)
})

await bot.start()
```

::: warning El código específico de transporte se queda específico
Todo lo que escribas contra `provider.socket` solo funciona con
`@bot-wa/baileys` (y solo contra una conexión real de WhatsApp — no con el
`MockProvider` que usa `createTestBot()`). Protégelo detrás de
`provider.id === 'baileys'` si tu código puede correr en otros transportes.
:::

Ver la [documentación de Baileys](https://github.com/WhiskeySockets/Baileys)
para la API completa del socket (`groupCreate`, `groupMetadata`,
`groupParticipantsUpdate`, `updateProfilePicture`, `chatModify`, ...).

## Siguientes pasos

- [Despliegue](./deploy) — configuración de producción
- [Referencia de API](/api/) — documentación técnica completa
