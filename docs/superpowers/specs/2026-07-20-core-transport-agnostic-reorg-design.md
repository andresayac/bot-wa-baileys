# Spec 1.0 — Core transport-agnostic reorg + `IProvider v2`

> Fase 1 (Fundación) del roadmap omnicanal. Este spec cubre **solo** la reorganización
> del monorepo y el contrato `IProvider v2`. Cloud API (1.1), presets de IA (1.2) y
> Redis store (1.3) son specs separados que se construyen **encima** de este.

**Goal:** Convertir `@bot-wa/core` en un motor de bots agnóstico de transporte (cero
concepto de WhatsApp), con Baileys re-alojado en `@bot-wa/baileys`, de modo que
Telegram/Discord/Cloud API entren después implementando `IProvider v2` sin tocar el core.

**Architecture:** Se voltea la frontera de transporte al revés. Hoy el core (`context.ts`)
parsea proto de Baileys, hace LID/PN y arma JSON de Baileys. En v2 **el provider** hace
todo eso: emite un `InboundEvent` normalizado y acepta `OutboundContent` normalizado.
`buildMessageContext` queda como envoltura ergonómica pura. `Dispatcher`,
`ConversationRuntime`, flows y `keyFor` no cambian (ya operan sobre strings opacos).

**Tech stack:** TypeScript 7 (ESM/NodeNext, Node ≥20), pnpm workspace, vitest. Cero deps
de runtime nuevas en `@bot-wa/core`.

## Global Constraints

- **Core sin transporte:** `@bot-wa/core` NO importa `@whiskeysockets/baileys` ni contiene
  JID / LID / PN / `@g.us` / `WAMessageKey` / `proto` / QR. Verificable: `grep` de esos
  símbolos en `packages/core/src` da vacío al terminar.
- **Identidad opaca:** `ChatId`/`UserId`/`MessageId` son `string` opacos. Ningún archivo de
  core hace suffix-match (`endsWith('@g.us')`), split por `@`, ni importa helpers jid.
- **Invariante de estabilidad (normativa del contrato):** durante una sesión, la misma
  entidad produce el mismo `senderId` y el mismo chat el mismo `chatId` en cada evento; el
  provider resuelve todo aliasing internamente. `keyFor` = `` `${chatId}:${senderId}` `` es
  correcto para cualquier provider conforme.
- **Cero deps nuevas en core:** proto parsing, sharp/ffmpeg, jid, `IdentityStore`,
  `RateLimiter` viven en `@bot-wa/baileys`. `better-sqlite3` sale del core por completo.
- **ESM:** imports relativos con `.js`, `"type": "module"`.
- **Hard-break 2.0:** `ctx.key`→`ctx.ref`, `ctx.rawMessage`→`ctx.raw`. Sin alias deprecados
  (estamos en `2.0.0-alpha`, sin usuarios en producción).
- **Red de seguridad:** los 156 tests actuales deben quedar verdes (re-alojados donde
  corresponda) al terminar; cada paso de la secuencia deja el build y la suite verdes.

## Scope

**Dentro (Spec 1.0):**
- Contrato `IProvider v2` + tipos normalizados en `@bot-wa/core`.
- Extraer `@bot-wa/baileys` (BaileysProvider, jid, IdentityStore, MediaProcessor,
  RateLimiter anti-ban, QR/pairing, reconnect, Groups/Profile/Privacy APIs,
  normalización proto→`InboundMessage`, mapper `OutboundContent`→JSON Baileys).
- Extraer `@bot-wa/sqlite-store`.
- Renombrar `@bot-wa/bot-wa-baileys` → `@bot-wa/core`.
- `MockProvider v2`, reescritura de `context.ts` y wiring de `Bot.ts` sobre `onEvent`.
- Proyección de interacciones al pipeline de mensajes (`type:'buttons'` + `acknowledge()`).
- Actualizar `@bot-wa/ai` al rename `ref`/`raw` y a los tipos nuevos.

**Fuera (specs posteriores):**
- Cloud API provider (1.1) · presets IA incl. chinos + Gemini (1.2) · Redis store (1.3).
- Telegram/Discord providers, `@bot-wa/menu`, `@bot-wa/metrics`, `broadcast` (Fase 2).
- `create-bot-wa` CLI, dashboard (Fase 3).
- Servidor HTTP para webhooks: **no** se construye aquí; `IProvider.ingest(raw)` queda
  definido y el host conecta la ruta (se ejercita en 1.1 con Cloud API).

## Package layout (objetivo)

```
packages/
  core/              → @bot-wa/core       motor + CONTRATOS (IProvider v2, IStore,
                        InboundEvent/OutboundContent, MessageContext, Dispatcher,
                        ConversationRuntime, flows, hooks, plugins, DI, MemoryStore,
                        testing kit con MockProvider v2)
  baileys-provider/  → @bot-wa/baileys    transporte WhatsApp (Baileys): provider,
                        jid, IdentityStore, MediaProcessor, RateLimiter, QR/pairing,
                        reconnect, Groups/Profile/Privacy, toInbound/outbound mappers
  sqlite-store/      → @bot-wa/sqlite-store   SQLiteStore (better-sqlite3 aquí, no en core)
  ai/                → @bot-wa/ai          (actualizado a ref/raw; ubicación sin cambio)
```

Instalación de un bot WhatsApp clásico: `pnpm add @bot-wa/core @bot-wa/baileys`.

## Decisiones (confirmadas con el usuario)

1. **Modelos IA** (para 1.2): presets OpenAI-compat vía `baseURL` (DeepSeek, Qwen, GLM,
   Kimi, Groq, OpenRouter, Mistral, Grok, Together) — cero deps nuevas; solo Anthropic y
   Gemini con lógica nativa. *(No se implementa en 1.0; se registra la decisión.)*
2. **Canales:** omnicanal (WA + Cloud API + Telegram + Discord). 1.0 diseña el contrato y
   lo prueba con Baileys re-alojado; los demás en fases siguientes.
3. **Estructura:** extraer a paquetes (core magro).
4. **Interacciones** (botón/slash/callback): se **proyectan** al pipeline actual como un
   mensaje `type:'buttons'` (`body=data`) + `ctx.acknowledge()`. En WhatsApp `acknowledge`
   es no-op. Reusa `when()`/flows/dispatcher.
5. **Webhooks:** `provider.ingest(rawEvent)`; el host sirve el HTTP. El Bot no monta server.
6. **Back-compat:** hard-break en 2.0 (`ref`/`raw`), sin alias.

## Contrato `IProvider v2` (autoritativo)

El implementador debe usar estas firmas **verbatim** en `@bot-wa/core`.

```ts
/* 1. IDENTITY PRIMITIVES (opaque) */
export type ChatId = string
export type UserId = string
export type MessageId = string
export interface MessageRef { id: MessageId; chatId: ChatId; native?: unknown }

/* 2. CHAT / SENDER (provider-computed) */
export type ChatKind = 'dm' | 'group' | 'channel' | 'broadcast'
export interface ChatInfo {
  id: ChatId; kind: ChatKind; name?: string
  isGroup: boolean; isBroadcast: boolean
  participants?: UserId[]; platformData?: Record<string, unknown>
}
export interface SenderInfo {
  id: UserId; displayName?: string; username?: string; isBot?: boolean
  platformData?: Record<string, unknown>
}

/* 3. MESSAGE TYPE + MEDIA */
export type MessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document'
  | 'sticker' | 'location' | 'contact' | 'poll' | 'buttons' | 'list' | 'unknown'
export interface MediaRef {
  kind: Exclude<MessageType, 'text' | 'poll' | 'buttons' | 'list' | 'unknown'>
  mimetype?: string; filename?: string; size?: number; token: unknown
}
export interface MediaPayload { buffer: Buffer; mimetype: string; filename?: string; size?: number }
export type MediaSource =
  | string | Buffer | { url: string } | { buffer: Buffer } | { path: string }
  | { stream: NodeJS.ReadableStream } | { native: unknown }

/* 4. INBOUND — normalized events */
export interface QuotedRef { ref?: MessageRef; body?: string; senderId?: UserId }
export interface InboundMessage<TRaw = unknown> {
  ref: MessageRef; chat: ChatInfo; senderInfo: SenderInfo
  from: ChatId; sender: UserId; chatId: ChatId; senderId: UserId
  isGroup: boolean; isBroadcast: boolean; fromMe: boolean
  type: MessageType; body: string; timestamp: number
  mentions: UserId[]; quoted?: QuotedRef; media?: MediaRef
  raw: TRaw
}
export interface InboundInteraction<TRaw = unknown> {
  interactionId: string; ref: MessageRef; chat: ChatInfo; senderInfo: SenderInfo
  from: ChatId; sender: UserId; chatId: ChatId; senderId: UserId; isGroup: boolean
  kind: 'button' | 'list' | 'command' | 'modal' | 'autocomplete'
  data: string; respondBy?: number; timestamp: number; raw: TRaw
}
export interface DeliveryStatus {
  ref: MessageRef; status: 'sent' | 'delivered' | 'read' | 'failed'
  recipient?: UserId; error?: { code?: string | number; message?: string }; timestamp: number
}
export interface InboundReaction { ref: MessageRef; emoji: string; senderId: UserId; removed?: boolean }
export interface PollVote {
  ref: MessageRef; senderId: UserId
  options: Array<{ name: string; votes: number; voters?: UserId[] }>
}
export interface GroupEvent {
  chatId: ChatId; action: 'add' | 'remove' | 'promote' | 'demote' | 'update'
  participants: UserId[]; actor?: UserId
}
export interface PresenceEvent {
  chatId: ChatId; presences: Record<UserId, { lastKnownPresence?: string; lastSeen?: number }>
}
export interface CallEvent { id: string; from: UserId; status: string }
export type InboundEvent<TRaw = unknown> =
  | { kind: 'message'; message: InboundMessage<TRaw> }
  | { kind: 'interaction'; interaction: InboundInteraction<TRaw> }
  | { kind: 'status'; status: DeliveryStatus }
  | { kind: 'reaction'; reaction: InboundReaction }
  | { kind: 'poll-vote'; vote: PollVote }
  | { kind: 'connection'; update: ConnectionUpdate }
  | { kind: 'group'; event: GroupEvent }
  | { kind: 'presence'; event: PresenceEvent }
  | { kind: 'call'; event: CallEvent }

/* 5. OUTBOUND — normalized content */
export interface Button { id: string; title: string; url?: string }
export interface ListSection { title?: string; rows: Array<{ id: string; title: string; description?: string }> }
export interface SendOptions {
  quoted?: MessageRef; mentions?: UserId[]; interactionId?: string
  platformData?: Record<string, unknown>
}
export type OutboundContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; media: MediaSource; caption?: string; viewOnce?: boolean }
  | { kind: 'video'; media: MediaSource; caption?: string; gifPlayback?: boolean; ptv?: boolean; viewOnce?: boolean }
  | { kind: 'audio'; media: MediaSource }
  | { kind: 'voice'; media: MediaSource }
  | { kind: 'document'; media: MediaSource; filename?: string; caption?: string; mimetype?: string }
  | { kind: 'sticker'; media: MediaSource; pack?: string; author?: string }
  | { kind: 'location'; lat: number; lng: number; name?: string; address?: string }
  | { kind: 'contact'; phone: string; displayName?: string }
  | { kind: 'poll'; question: string; options: string[]; multiSelect?: boolean }
  | { kind: 'reaction'; emoji: string; target: MessageRef }
  | { kind: 'buttons'; text: string; buttons: Button[]; footer?: string }
  | { kind: 'list'; text: string; buttonText: string; sections: ListSection[]; footer?: string }
  | { kind: 'card'; title: string; body?: string; imageUrl?: string; buttons?: Button[] }
  | { kind: 'template'; name: string; language: string; components?: unknown }
  | { kind: 'native'; provider: string; payload: unknown }
export interface SendResult<TRaw = unknown> { ref: MessageRef; raw?: TRaw; skipped?: boolean }

/* 6. CAPABILITIES */
export interface ProviderCapabilities {
  contentKinds: ReadonlyArray<OutboundContent['kind']>
  maxTextLength?: number; maxMediaBytes?: number; maxButtonDataBytes?: number
  buttons: boolean; lists: boolean; polls: boolean; reactions: boolean; edit: boolean
  typing: boolean; presence: boolean; readReceipts: boolean; groups: boolean; templates: boolean
  interactionsRequireAck: boolean; pushIngress: boolean
}

/* 7. CONNECTION (neutral — no 'qr') */
export type ConnectionState = 'connecting' | 'authenticating' | 'ready' | 'closed'
export type DisconnectReason =
  | 'sessionInvalid' | 'sessionTakenOver' | 'transient' | 'rateLimited' | 'unknown'
export interface ConnectionUpdate {
  state: ConnectionState; authPayload?: unknown; reason?: DisconnectReason
  retryAfterMs?: number; detail?: { code?: string | number; message?: string }
}

/* 8. TYPED ERRORS (core, zero deps) */
export class ProviderError extends Error {}
export class UnsupportedContentError extends ProviderError {
  constructor(public readonly kind: OutboundContent['kind'], message?: string) {
    super(message ?? `Unsupported content kind: ${kind}`); this.name = 'UnsupportedContentError'
  }
}
export class RateLimitedError extends ProviderError {
  constructor(public readonly retryAfterMs: number, message?: string) {
    super(message ?? `Rate limited; retry after ${retryAfterMs}ms`); this.name = 'RateLimitedError'
  }
}
export class RecipientUnreachableError extends ProviderError {
  constructor(public readonly chatId: ChatId, message?: string) {
    super(message ?? `Recipient unreachable: ${chatId}`); this.name = 'RecipientUnreachableError'
  }
}
export class PayloadTooLargeError extends ProviderError {
  constructor(message?: string) { super(message); this.name = 'PayloadTooLargeError' }
}
export class OutsideSessionWindowError extends ProviderError {
  constructor(public readonly chatId: ChatId, message?: string) {
    super(message ?? `Outside session window for ${chatId}; a template is required`)
    this.name = 'OutsideSessionWindowError'
  }
}

/* 9. IProvider v2 — STABILITY CONTRACT is normative (see Global Constraints) */
export interface IProvider<TRaw = unknown> {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  start(): Promise<void>
  stop(): Promise<void>
  send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult<TRaw>>
  onEvent(listener: (event: InboundEvent<TRaw>) => void | Promise<void>): () => void
  ingest?(rawEvent: unknown): void | Promise<void>
  downloadMedia?(ref: MediaRef): Promise<Buffer | NodeJS.ReadableStream>
  getMessage?(ref: MessageRef): Promise<InboundMessage<TRaw> | undefined>
  markRead?(refs: MessageRef[]): Promise<void>
  typing?(chatId: ChatId, state?: 'typing' | 'recording' | 'paused'): Promise<void>
  deleteMessage?(ref: MessageRef): Promise<void>
  editMessage?(ref: MessageRef, content: OutboundContent): Promise<SendResult<TRaw>>
  acknowledgeInteraction?(interactionId: string, opts?: { text?: string; defer?: boolean }): Promise<void>
  readonly connection?: unknown | null
}
```

`MessageContext<TTools, TRaw>`, `SentMessage`, `BuildContextDeps`, `IStore`
(`StoredMessage`/`StoredChat`/`StoredContact` + cursor opcional), `messageKey(ref)` y
`BotConfig` (con `provider: IProvider` **requerido**, y los campos WhatsApp movidos a
`BaileysProviderConfig`) están definidos en el artefacto completo
[`2026-07-20-iprovider-v2-contract.ts`](./2026-07-20-iprovider-v2-contract.ts) (autoritativo)
y se copian al core en la Tarea 1. Notas clave:
- `MessageContext` conserva **firmas idénticas** de `reply/photo/poll/react/...`; solo cambia
  el cuerpo privado (arma `OutboundContent` y llama `provider.send`). Añade `ref`, `raw`,
  `interaction?` y `acknowledge?`.
- `ctx.markRead/typing/delete` degradan a no-op si el provider no expone la capacidad.
- `BotConfig.provider` es requerido: el usuario construye el provider (`new BaileysProvider(cfg)`)
  y lo inyecta. Los campos `qr/pairingCode/sessionsDir/browser/markOnlineOnConnect/
  syncFullHistory/ignoreNewsletters/ignoreBroadcasts` viven en `BaileysProviderConfig`.

## Placement — qué se mueve

| Símbolo | Paquete | Motivo |
|---|---|---|
| `IProvider v2`, `Inbound*`/`Outbound*`, `MessageRef`, `ChatId/UserId`, `ChatInfo/SenderInfo`, `ConnectionUpdate`, `MediaRef`, errores tipados, `MessageContext`, `buildMessageContext` | `@bot-wa/core` | Contrato neutro; ids opacos, sin concepto WhatsApp |
| `Dispatcher`, `ConversationRuntime`, `keyFor`, `RuntimeMessage`, `HookSystem`, flows/DSL, controls | `@bot-wa/core` | Ya agnósticos; `InboundMessage` reusa `from/sender/body/type/isGroup` → fluye sin cambios |
| `IStore` + `StoredMessage/Chat/Contact`, `messageKey`, cursor | `@bot-wa/core` | Contrato de storage genérico (implementable por Discord/Telegram) |
| `MemoryStore` | `@bot-wa/core` | Store por defecto, sin deps |
| `BaileysProvider`, `buildSocket`, reconnect/`classifyDisconnect`, creds, `downloadMediaMessage`, pairing | `@bot-wa/baileys` | Transporte WhatsApp concreto; mapea Boom→`DisconnectReason` |
| `toInbound()` (proto scan, body/type, mentions, quoted, media) | `@bot-wa/baileys` | Único lugar que entiende `proto.IWebMessageInfo` |
| `IdentityStore` (observe/canonical/knowsPnFor), `seedIdentity`, `getPNForLID`/`lidCache` | `@bot-wa/baileys` | Reconciliación LID/PN pura de Baileys; corre interno → emite ids estables |
| `jid.ts` (toJid, normalize, isPn/isLid, `normalizeInboundKey`, sameUser, ...) | `@bot-wa/baileys` | Asume gramática JID; se re-exporta desde el entry de baileys |
| QR render (terminal/file), `pairingCode` | `@bot-wa/baileys` | UX de linking WhatsApp; el QR sale como `ConnectionUpdate.authPayload` |
| `OutboundContent`→`AnyMessageContent` mapper | `@bot-wa/baileys` | Nombres de campo Baileys; `buttons`→texto numerado (degrade explícito) |
| `MediaProcessor` (sharp/ffmpeg: sticker WebP, Opus) | `@bot-wa/baileys` | Transcode WhatsApp con deps pesadas; core queda sin deps |
| `RateLimiter` anti-ban + `RateLimitConfig` | `@bot-wa/baileys` | Heurística anti-ban WhatsApp; core solo define el seam + `RateLimitedError` |
| Groups/Profile/Privacy/Chats/Presence API impls | `@bot-wa/baileys` | Semántica WA sobre `sock`; namespaces opcionales capability-gated |
| `SQLiteStore` + `better-sqlite3` | `@bot-wa/sqlite-store` | Dep nativa fuera del core |
| `MessageType`, `Button`, `ListSection`, `QuotedRef` | core (consumido por providers) | Vocabulario neutro |

## Migración (secuencia; cada paso deja build+suite verdes)

1. **Contratos en core** — copiar `IProvider v2` + tipos normalizados a
   `packages/core/src/core/` (nuevo `provider.ts`/`types.ts`). Aún sin cambiar impl; el
   `IProvider` viejo coexiste temporalmente. Compila.
2. **Skeleton `@bot-wa/baileys`** — crear paquete, `package.json`, tsconfig, entry. Depende
   de `@bot-wa/core`.
3. **Mover Baileys** — trasladar BaileysProvider + reconnect + jid + IdentityStore +
   MediaProcessor + RateLimiter + QR + Groups/Profile/Privacy a `@bot-wa/baileys`. Mover sus
   tests (`reconnect`, `jid`, `lid-identity`).
4. **`toInbound`/outbound en el provider** — el provider implementa `onEvent(InboundEvent)`
   traduciendo su `TypedEmitter` interno; `send()` mapea `OutboundContent`. Mover la lógica
   de `context.ts` (proto scan + `sendOut`) al provider.
5. **`context.ts` → wrapper fino** — `buildMessageContext(BuildContextDeps)` recibe
   `InboundMessage` ya normalizado; helpers de `ctx` arman `OutboundContent`.
6. **`Bot.ts` sobre `onEvent`** — suscribir a `provider.onEvent`; enrutar `kind:'message'`
   al dispatcher; proyectar `kind:'interaction'` como `type:'buttons'` + `acknowledge()`;
   mapear `kind:'connection'` a los eventos `ready/qr(authPayload)/close`. Quitar
   `seedIdentity`/`getPNForLID` del core.
7. **`MockProvider v2`** — reescribir para emitir `InboundEvent`; helper `incoming()` produce
   `{kind:'message', message}`. Actualizar `createTestBot`.
8. **Rename** — `@bot-wa/bot-wa-baileys` → `@bot-wa/core`; extraer `@bot-wa/sqlite-store`.
   Actualizar imports, `pnpm-workspace`, lockfile.
9. **`@bot-wa/ai`** — actualizar a `ref`/`raw` y a los tipos nuevos (`IProvider`, `IStore`).
10. **Verde total** — build `-r` + suite `-r` + smoke del bot demo (arranca, QR, flow
    `registrar` avanza) contra `@bot-wa/core` + `@bot-wa/baileys`.

## Testing

- **Core (con `MockProvider v2`):** dispatcher, runtime, controls, dsl, checkpoint,
  conversation-store, slash, bot-events, bot-integration, matching, duration, boundedMap,
  ratelimit *(el seam, no la heurística)*, validate-config. Driven por `InboundEvent`.
- **`@bot-wa/baileys`:** `jid`, `reconnect`, `lid-identity`, `e2e-transcript` (LID/PN es
  WhatsApp), `mock-provider` de Baileys si aplica, `RateLimiter` anti-ban.
- **`@bot-wa/sqlite-store`:** `sqlite-store` (lazy require).
- **Nuevos:** conformidad del contrato — un provider fake mínimo que implemente `IProvider v2`
  y pase por dispatcher→flow→send; test de proyección de interacción (`kind:'interaction'` →
  handler `when()` lo ve como `type:'buttons'`, `ctx.acknowledge()` no-op).
- **Meta:** ≥156 tests verdes tras el reorg (re-alojados) + los nuevos.

## Riesgos

- **Churn en `context.ts`/`Bot.ts`** — el corazón del cambio. Mitiga: secuencia por pasos
  con verde en cada uno; SDD con reviewer por tarea.
- **`@bot-wa/ai` acoplado a la forma vieja** (`ctx.key`, `IStore` WhatsApp) — actualizarlo en
  la Tarea 9; sus 25 tests son la red.
- **Rename de paquete** rompe imports internos del monorepo — `pnpm -r` los caza al compilar.
- **`InboundEvent` vs `TypedEmitter`** — el provider mantiene su emitter interno y expone
  `onEvent` encima (migración incremental, no reescribir el emitter en core).

## Diferido a specs posteriores (registrado)

- **1.1 Cloud API provider** — valida el omnicanal (webhook `ingest`, `template` kind,
  session window de 24h, botones interactivos nativos).
- **1.2 Presets IA** — `@bot-wa/ai`: presets OpenAI-compat (DeepSeek/Qwen/GLM/Kimi/Groq/
  OpenRouter/Mistral/Grok/Together) + Gemini nativo.
- **1.3 Redis store** — `@bot-wa/redis-store` (IStore + cursor + lock distribuido para la
  cola FIFO por-chat en modo multi-réplica).
- **Fase 2:** Telegram + Discord providers, `@bot-wa/menu`, `@bot-wa/metrics`, `broadcast`.
- **Fase 3:** `create-bot-wa` CLI, dashboard, templates.

## Open questions (resolver al planear, no bloquean)

- `bot.groups`/`profile`/`privacy`: mantener interfaces opcionales capability-gated en core
  (typed pero sin asumir que todo provider las cumple) vs. exponerlas solo desde `@bot-wa/baileys`.
  Recomendación: interfaces opcionales en core, impl en baileys.
- `ConnectionUpdate.authPayload` opaco vs. discriminante ligero (`{type:'qr'|'oauth-url'|
  'pairing-code'|'none', value}`). Recomendación: discriminante ligero para que el host
  ramifique sin cast por-provider.
- Cursor de entrega (`update_id` de Telegram): en `IStore` (getCursor/setCursor) vs. interno
  del provider. Recomendación: opcional en `IStore` (útil también para reanudar).
