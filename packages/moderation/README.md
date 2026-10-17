# @bot-wa/moderation

> **Experimental — aún no publicado en npm.** Implementación real y probada, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Plugin de **moderación de grupos** para [`@bot-wa/core`](../core): anti-spam por ventana de tiempo, filtros de palabras/regex, filtro de enlaces (invitaciones a grupos ajenos) y acciones `warn` / `mute` / `kick` / `delete`, con configuración por grupo y bypass para administradores.

Es agnóstico de transporte: los ids de chat y de usuario son strings opacos, los enlaces se detectan en el **texto** del mensaje y cada capacidad del provider (borrar mensajes, expulsar, listar admins) es **opcional**. Si el provider no la tiene, la acción se degrada y se reporta.

## Uso

```ts
import { Bot } from '@bot-wa/core'
import { moderationPlugin } from '@bot-wa/moderation'

const bot = new Bot({ provider })

bot.plug(moderationPlugin({
  provider,                                          // habilita delete/kick/admins si el provider los soporta
  antiSpam: { maxMessages: 5, windowMs: 10_000, action: 'warn' },
  wordFilter: { banned: ['spam', 'estafa', /bit\.ly\/\w+/i], action: 'delete' },
  autoKickOnLink: true,                              // = linkFilter: { action: ['delete', 'kick'] }
  linkFilter: { allowInvites: ['CODIGO_DE_MI_GRUPO'] },
  warnings: { max: 3, then: 'kick' },
  groups: {
    [grupoStaff]: false,                             // sin moderación aquí
    [grupoVentas]: { wordFilter: { banned: ['gratis'] } },
  },
}))

bot.on('moderation', (report) => {
  // { chatId, senderId, rule, detail, ref, results: [{ action, status }], warnings }
})
```

El plugin se engancha en `before('message')` con prioridad `100` (antes que otros hooks y que cualquier handler). Un mensaje que infringe una regla ejecuta sus acciones y **no** llega a los handlers. Los mensajes de un usuario silenciado (`mute`) se ignoran hasta que vence el silencio.

Por defecto solo modera **grupos** (`applyTo: 'all'` incluye chats privados). Las interacciones (botones, slash commands) y los mensajes propios nunca se moderan.

## Reglas

| Regla | Campos | Acción por defecto |
| --- | --- | --- |
| `antiSpam` | `maxMessages`, `windowMs` (ventana deslizante por chat + remitente) | `'warn'` |
| `wordFilter` | `banned: (string \| RegExp)[]`, `wholeWord` (defecto `true`) | `'delete'` |
| `linkFilter` | `groupInvites` (defecto `true`), `allLinks`, `allowInvites`, `allowDomains`, `invitePatterns` | `['delete', 'warn']` |

- Las palabras se comparan sin mayúsculas ni tildes (`'estafa'` detecta `'ESTAFÁ'`) y como palabra completa (`'spam'` no detecta `'spammer'` salvo `wholeWord: false`). Las RegExp se prueban sobre el texto crudo.
- Invitaciones reconocidas: WhatsApp (`chat.whatsapp.com/…`), Telegram (`t.me/+…`, `t.me/joinchat/…`) y Discord (`discord.gg/…`, `discord.com/invite/…`). Añade otras con `invitePatterns` (el primer grupo de captura es el código).
- `action` acepta una acción o varias en orden: `['delete', 'warn']`.

## Acciones y degradación

| Acción | Cómo se ejecuta | Si no hay soporte |
| --- | --- | --- |
| `delete` | `provider.deleteMessage(ref)` | `status: 'unsupported'`. Sin `provider` en la config, se usa `ctx.delete()` y se reporta `'attempted'` (no se puede verificar) |
| `kick` | `provider.groups.removeParticipants(chatId, [userId])` | `'unsupported'` y, por defecto, se degrada a `mute` (`kickFallback: 'none'` lo evita) |
| `mute` | Estado interno: los mensajes del usuario se ignoran `muteMs` (defecto 10 min) | Siempre disponible |
| `warn` | `bot.send` al grupo, citando el mensaje y mencionando al usuario | `'failed'` si el envío falla |

Las advertencias se cuentan por chat + usuario; al llegar a `warnings.max` se ejecuta `warnings.then` (`'mute'` o `'kick'`) y el contador vuelve a cero. `warnings: false` lo desactiva.

El namespace `groups` del provider es opcional y estructural:

```ts
interface GroupAdminApi {
  removeParticipants?(chatId: string, userIds: string[]): Promise<unknown>
  getAdmins?(chatId: string): Promise<readonly string[]>
}
```

## Administradores

Con `adminBypass` (defecto `true`) los administradores no se moderan. Se consideran admins:

1. Los ids de `admins` (global o por grupo).
2. Quien devuelva `true` en `isAdmin(chatId, userId)`.
3. Los que reporte `provider.groups.getAdmins(chatId)`, con caché de `adminCacheMs` (defecto 5 min) que se invalida con los eventos de grupo `promote`/`demote`.

Cuando alguien sale del grupo (evento `remove`) se olvidan sus advertencias, su silencio y su ventana de spam.

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

## Textos

```ts
moderationPlugin({
  messages: {
    warn: '⚠️ {name}: {reason}. Advertencia {count}/{max}.',
    reasons: { antiSpam: 'calma con los mensajes', wordFilter: 'sin insultos', linkFilter: 'nada de links' },
  },
})
```

## Limitaciones

- El estado (ventanas, advertencias, silencios) vive en memoria: se pierde al reiniciar.
- Ningún provider del monorepo expone todavía `groups.removeParticipants`/`getAdmins`; hasta entonces `kick` se degrada a `mute`.
