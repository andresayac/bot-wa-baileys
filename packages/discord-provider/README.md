# @bot-wa/discord

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`); el `pnpm add` de abajo funcionará cuando se publique.

Transporte **Discord** para [`@bot-wa/core`](../core): **Gateway websocket**
para eventos entrantes (mensajes, botones, menús y slash commands) y **REST**
para enviar. El provider es dueño del socket (`pushIngress: false`) — no hay
webhook que cablear.

## Instalación

```bash
pnpm add @bot-wa/core @bot-wa/discord
```

Dependencias: `ws` (gateway), `fetch`/`FormData` nativos de Node ≥ 22 (REST).

## Requisitos (Discord)

1. Una aplicación en el [Developer Portal](https://discord.com/developers/applications) con un **Bot**.
2. El **token del bot** (Bot → Reset Token).
3. **Privileged Gateway Intents** habilitados (Bot → Privileged Gateway Intents):
   - `MESSAGE CONTENT INTENT` — **obligatorio**, sin esto `content` llega vacío.
   - `SERVER MEMBERS INTENT` — solo si necesitás miembros.
4. Invitá el bot con el scope `bot` + `applications.commands` y permisos de
   leer/enviar mensajes.

## Uso

```ts
import { Bot } from '@bot-wa/core'
import { DiscordProvider, GatewayIntents } from '@bot-wa/discord'

const provider = new DiscordProvider({
  token: process.env.DISCORD_TOKEN!,
  // Opcional: además de Guilds|GuildMessages|MessageContent (default),
  // agregá DirectMessages para recibir DMs:
  intents: GatewayIntents.Guilds
    | GatewayIntents.GuildMessages
    | GatewayIntents.MessageContent
    | GatewayIntents.DirectMessages,
  appId: process.env.DISCORD_APP_ID, // opcional: followups dentro de interacciones
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('👋 ¡Hola desde Discord!'))
await bot.start()
```

### Botones e interacciones

Discord exige responder una interacción en **~3 segundos**
(`interactionsRequireAck: true`). Los clics de botón / selección de menú /
slash commands llegan como eventos `interaction` con un `interactionId`
`"<id>:<token>"` y `respondBy` (epoch ms del deadline):

```ts
provider.onEvent(async (e) => {
  if (e.kind !== 'interaction') return
  // ack diferido (type 6) antes del deadline:
  await provider.acknowledgeInteraction(e.interaction.interactionId)
  // …o respuesta inmediata con texto (type 4):
  await provider.acknowledgeInteraction(e.interaction.interactionId, { text: 'Hecho ✅' })
})
```

### Gateway (nota técnica)

`start()` abre `wss://gateway.discord.gg/?v=10&encoding=json` e implementa el
protocolo mínimo: HELLO → heartbeat + IDENTIFY, seguimiento de secuencia,
RESUME tras caídas (con backoff), reconexión con sesión nueva en
INVALID_SESSION no resumible, y parada definitiva en códigos fatales
(4004 token inválido, 4013/4014 intents — emite `connection` con
`reason: 'sessionInvalid'`). Para tests se inyecta un socket falso vía
`socketFactory` (nunca se abre una conexión real).

## Qué soporta

| Feature | Discord |
|---|---|
| Texto, imagen, video, audio, voz, documento, sticker (multipart `files[0]` + `payload_json`) | ✅ |
| **Botones** (`components` action row, hasta 5; botones URL style 5) | ✅ nativo |
| **Listas** → select menu (type 3) | ✅ nativo |
| Card → embed (`title`/`description`/`image`) | ✅ |
| **Encuestas** (poll 24h) | ✅ |
| Reacciones (PUT `.../reactions/{emoji}/@me`) | ✅ |
| Typing, editar y borrar mensajes | ✅ |
| Interacciones: botón / menú / slash command con ack obligatorio (~3s) | ✅ |
| Grupos (guilds) y DMs (con `DirectMessages` intent) | ✅ |
| Plantillas (kind `template`) | ❌ (no existe en Discord) |
| Presence, confirmaciones de lectura (`markRead` no-op) | ❌ (no aplica) |
| Ubicación / contacto | ⚠️ degradación explícita a texto (link de mapa / tarjeta de texto) |

## Errores tipados

Los fallos REST (HTTP ≥ 400) se mapean a los errores de `@bot-wa/core`:
`429` → `RateLimitedError` (con `retryAfterMs` desde `retry_after`), `403` →
`RecipientUnreachableError`, `413`/código 40003 → `PayloadTooLargeError`,
resto → `ProviderError` con el `message` de Discord.

## Identidad

`chatId` es el snowflake del canal (`channel_id`) y `senderId` el del usuario
(`author.id` / `member.user.id`) — estables, sin ambigüedad member-vs-user.
Los mensajes de bots (incluido el propio) se ignoran.

## Configuración completa

```ts
new DiscordProvider({
  token: '…',                 // requerido
  intents?: number,           // default: Guilds | GuildMessages | MessageContent
  appId?: string,             // para followups de interacción (SendOptions.interactionId)
  selfId?: string,            // se autodetecta del READY del gateway
  gatewayUrl?: string,        // default 'wss://gateway.discord.gg'
  apiUrl?: string,            // default 'https://discord.com/api' (sin versión)
  apiVersion?: string,        // default 'v10'
  socketFactory?: SocketFactory, // tests: socket falso
  reconnectDelayMs?: number,  // base del backoff de reconexión, default 500
  debug?: boolean, logger?: Logger,
})
```
