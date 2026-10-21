# Testing

`@botmesh/core/testing` te deja probar un bot sin WhatsApp, sin teléfono y
sin red. Funciona con cualquier test runner (el repo usa Vitest).

```ts
import { createTestBot, MockProvider } from '@botmesh/core/testing'
```

## `createTestBot` y `MockProvider`

```ts
import { flow } from '@botmesh/core'
import { createTestBot } from '@botmesh/core/testing'

const { bot, provider, chat } = await createTestBot()
bot.use(flow('hola').ask('¿Tu nombre?', 'name').say((_ctx, c) => `Hola ${c.state.name}`))

await chat.send('hola')
await chat.expectReply('¿Tu nombre?')
await chat.send('Ana')
await chat.expectReply(/Hola Ana/)
await chat.expectNoReply()   // nada más en 300 ms
chat.replies()        // todos los textos/captions enviados a este chat
provider.outbox       // todos los mensajes salientes, de cualquier chat
```

`createTestBot(config?)` crea un `Bot` ya arrancado sobre un `MockProvider`.
`chat` es un DM (`user@s.whatsapp.net`): sus helpers simulan lo que hace el
usuario y comprueban lo que respondió el bot. Cada helper `send*`/`press*` cede
una macrotarea antes de resolver, así que el despacho ya ha empezado.

| Helper | Qué hace |
| --- | --- |
| `send(text, { type? })` | un mensaje entrante (`type` es `'text'` por defecto) |
| `sendMedia(kind, bytes \| { url, bytes? }, caption? \| { caption, mimetype, filename, size })` | un mensaje con media: `ctx.body` es el caption y `loadMediaOf(ctx)` resuelve con los bytes. `{ url }` a secas es solo metadato: la descarga rechaza con `MediaUnavailableError` (el mock nunca toca la red) |
| `sendLocation(location)` / `sendLocation(lat, lng, { name? })` | una ubicación compartida (`ctx.sharedLocation`, `c.waitLocation()`) |
| `sendReaction(emoji, target?)` | una reacción al último mensaje del bot en el chat (si no, al último del usuario), a un `MessageRef` explícito, o `{ to?, removed: true }` para retirarla; llega a `bot.on('reaction')` y a los hooks `'reaction'` |
| `pressButton(id \| título \| índice)` | pulsa un botón nativo, una fila de lista o un botón de card del último mensaje interactivo que envió el bot; el bot recibe lo mismo que con una pulsación real (un mensaje `'buttons'` cuyo body es el id, `ctx.interaction.data`). Lanza si no se envió nada interactivo, si el destino no existe o si es un botón de URL. Con `new MockProvider({ buttons: false })` los menús son texto numerado: usa `chat.send('1')` |
| `sendInteraction(data, { kind?, id? })` | una interacción cruda (`ctx.interaction.data`), p. ej. `{ kind: 'command' }` |
| `expectReply(texto \| regexp, timeoutMs?)` | resuelve con la primera respuesta que coincide (ya enviada o que llega antes del timeout, 1 s por defecto) |
| `expectNoReply({ timeout? } \| ms)` | resuelve cuando no hay ninguna respuesta sin consumir ni llega ninguna en la ventana (300 ms por defecto); rechaza listando las respuestas inesperadas. No consume nada |
| `replies()` / `sent()` / `lastReply()` | los textos de cada respuesta; cada envío con su `content` completo y su `ref`; el último |
| `transcript(opts?)` | el intercambio como transcripción dorada (ver [Snapshots de conversación](#snapshots-de-conversacion)) |

Los helpers lanzan `TestKitError` con un mensaje accionable. `expectReply` y
`expectNoReply` sondean con timers reales: con `vi.useFakeTimers()` avánzalos
(`vi.advanceTimersByTimeAsync`) o deja `setTimeout`/`setInterval` sin simular.

También puedes manejar el mock directamente: `provider.incoming(text, { from, sender, ... })`,
`provider.incomingMedia(kind, bytes, opts)`, `provider.interaction(data, { kind })`
(pulsar botones y listas), `provider.incomingLocation(location, opts)`,
`provider.reaction(emoji, { to })` y `provider.call({ id, from, status })` (para los
[triggers `CALL`](./triggers#call)). `provider.journal` guarda en orden los mensajes
e interacciones entrantes y los envíos (con su `ref`), acotado por `maxJournal`
(10 000 por defecto).

`editMessage`, `deleteMessage` y `sendDraft` son métodos de verdad (se
registran en `edits`, `deleted` y `drafts`) que puedes sobrescribir en una
subclase. Se exponen según `new MockProvider({ streaming, supports })`: `edit`
y `delete` cuando `streaming` no es `'none'`, `drafts` con `'draft'`. Uno
desactivado vale `undefined`, así que el bot lo trata como no soportado; pasa
`supports: { edit: true }` para activarlo o `supports: { edit: false }` para
simular un transporte sin él (también oculta la versión de una subclase).

### Varios usuarios y grupos

```ts
const { bot, chat, dm, group } = await createTestBot()

const ana = dm('ana@s.whatsapp.net', { displayName: 'Ana' })      // otro DM
const team = group('team@g.us', { as: 'ana@s.whatsapp.net' })     // un grupo, manejado por Ana
const beto = team.as('beto@s.whatsapp.net', { displayName: 'Beto' })  // el mismo grupo, otro participante

await team.send('hola'); await beto.send('hola')
await team.expectReply('¿Tu nombre?'); await beto.expectReply('¿Tu nombre?')
```

Cada vista lleva `chatId`, `senderId`, `isGroup` y `displayName`. Las vistas de
un mismo chat comparten el cursor de respuestas (en un grupo las respuestas no
son por remitente), así que los participantes leen las respuestas del chat en
orden, mientras las conversaciones siguen siendo por participante
(`conversationScope: 'participant'`). En un DM, `chat.as(userId)` es otro DM.
`provider.journal` guarda los eventos que emitió cada vista, listos para
`assertStableIdentity`.

### Snapshots de conversación

```ts
expect(chat.transcript()).toMatchSnapshot()

chat.transcript({ as: 'text' })
// user@s.whatsapp.net> hola
// bot< ¿Tu nombre?
```

`chat.transcript({ name?, ids?, timestamps?, scope?, as? })` devuelve una
[transcripción dorada](/es/guide/transcripciones) con la misma forma que produce
`recordTranscript`: se parsea, se redacta (`redactTranscript`) y se reproduce
(`assertTranscript`) sin cambios. Los ids y los offsets `t` se omiten por defecto
para que el snapshot sea estable; `scope: 'all'` intercala todos los chats que vio
el mock y `as: 'text'` lo pinta una línea por turno. Las reacciones no son turnos
de la transcripción.

### Matchers de Vitest

```ts
// vitest.setup.ts (una entrada de `setupFiles`) o al principio de un test
import { expect } from 'vitest'
import { botMatchers } from '@botmesh/core/testing/vitest'
expect.extend(botMatchers)

expect(chat).toHaveReplied('¿Tu nombre?')              // includes de string / RegExp
expect(chat).toHaveRepliedMatching((text, content) => content.kind === 'image')
expect(provider).toHaveRepliedTimes(2)                 // también provider.outbox o un string[]
```

`@botmesh/core/testing/vitest` exporta los matchers y amplía el tipo `Matchers`
de vitest (`.not` funciona). `vitest` es una peer dependency opcional: en tiempo
de ejecución no importa nada de ella. Los matchers son síncronos: espera con
`expectReply` y después comprueba.

`MockProvider` usa siempre un `from` estable. Para probar cambios de
identidad y entregas hostiles, usa el kit de caos.

## Kit de caos: entrega adversaria

`ChaosProvider` envuelve cualquier `IProvider` (normalmente `MockProvider`)
y entrega su tráfico de forma adversaria: duplicados, reordenación,
latencia, envíos fallidos, desconexiones y alias de identidad. Es
determinista para una `seed` dada.

```ts
import { createTestBot } from '@botmesh/core/testing'

const { bot, provider, chaos } = await createTestBot({}, {
  chaos: {
    seed: 7,
    duplicates: 0.3,                        // o { probability, copies, delayMs }
    reorder: 3,                             // o { window, maxHoldMs, strategy: 'shuffle' | 'reverse' }
    latency: { min: 0, max: 5 },
    sendFailures: { attempts: [2], errors: ['rate-limited'], retryAfterMs: 500 },
    disconnects: { afterInbound: [5], downtimeMs: 20, replayOnReconnect: 2 },
    aliases: { map: { '573001@s.whatsapp.net': ['999@lid'] }, strategy: 'cycle' },
  },
})
bot.when('hola', async (ctx) => await ctx.reply('👋'))
provider.incoming('hola', { from: 'u1' })   // se sigue manejando el mock
await chaos.settle()                        // espera las entregas pendientes (timers reales)
```

Con cualquier provider: `const chaos = withChaos(miProvider, { seed: 1, duplicates: 1 }); new Bot({ provider: chaos })`.

| Opción | Qué simula |
| --- | --- |
| `duplicates` | re-entregas (reintentos de webhook). Con `delayMs: 0` (por defecto) la copia llega en el mismo tick, el peor caso |
| `reorder` | permuta los eventos dentro de una ventana, en orden de llegada |
| `latency` / `sendLatency` | retardo fijo o rango `{ min, max }`, en ms |
| `sendFailures` | fallos transitorios con errores tipados: `'rate-limited'`, `'unreachable'`, `'payload-too-large'`, `'outside-window'`, `'unsupported'`, `'disconnected'` o una fábrica propia. Se ciclan en orden; se eligen por `attempts` (desde 1), por `probability` o se acotan con `maxConsecutive`. Un envío fallido no llega al `outbox` |
| `disconnects` | caídas automáticas (`closed → connecting → ready`). Mientras está caído, la entrada se retiene y los envíos fallan con `ChaosDisconnectedError`. `replayOnReconnect` reenvía los últimos N mensajes, como una sincronización offline |
| `aliases` | la misma persona con varios ids (LID/PN). Sin `resolve` simula un provider que filtra alias y rompe el contrato de identidad; con `resolve` prueba tu resolvedor |
| `kinds` | tipos de evento afectados. Por defecto `['message', 'interaction']`; los eventos `connection` siempre pasan directos |

Controles manuales: `chaos.disconnect({ reason, downtimeMs })` (sin
`downtimeMs` queda caído hasta `chaos.reconnect()`), `chaos.replay(n)` (un
reintento de webhook explícito), `chaos.flush()` y `chaos.settle()`. Para
las aserciones: `chaos.log` (lo inyectado) y `chaos.delivered` (lo que llegó
al bot). Para tiempos exactos usa `vi.useFakeTimers()` y
`vi.advanceTimersByTimeAsync()`.

Como el [dedupe de entrada](./conceptos#dedupe-de-entrada) está activado por
defecto, un bot sometido a `duplicates` y `replay` debería seguir
respondiendo una sola vez a cada mensaje.

## Contrato de identidad para providers

Todo provider debe emitir el mismo `senderId` para la misma persona, use el
alias que use el transporte (ver el contrato de identidad en `IProvider`).
Estas funciones revisan una lista de eventos emitidos:

```ts
import { assertStableIdentity, checkIdentityContract, recordEvents } from '@botmesh/core/testing'

const events = [toInbound(a, identity), toInbound(b, identity), toInbound(c, identity)]
assertStableIdentity(events, { andres: { events: [0, 1, 2], senderId: PN, chatId: PN, kind: 'dm' } })

checkIdentityContract(events, { andres: [0, 1, 2] })   // → IdentityViolation[] en vez de lanzar

const rec = recordEvents(provider)                      // captura lo que emite un provider real
// ... manejar el provider ...
assertStableIdentity(rec.events, { andres: [0, 1] })
rec.stop()
```

Qué comprueba:

- ids no vacíos y que no parezcan `undefined`/`null`/`NaN`/`[object Object]`;
- que concuerden `from`/`chatId`/`chat.id`, `sender`/`senderId`/`senderInfo.id`
  y `ref.chatId`;
- un `ChatKind` válido y coherente con `isGroup`/`isBroadcast`, y que un
  chat nunca cambie de kind;
- por persona: un único `senderId`, un único `chatId` de DM y los ids/kind
  esperados;
- que dos personas distintas no compartan `senderId`.

Opciones: `requireRefChatId`, `rejectSuspiciousIds`, `distinctHumans`.
`assertStableIdentity` lanza un `IdentityContractError` con `violations`.
Hay un ejemplo real en
`packages/baileys-provider/tests/identity-contract.test.ts`.

## Transcripciones doradas

Para fijar conversaciones completas, graba una (`recordTranscript`) o léela
del log del store (`transcriptFromStore`), redáctala, commitéala como JSON y
reprodúcela en un test con `assertTranscript`: cualquier respuesta cambiada,
ausente o de más falla con un diff esperado frente a real. La misma
reproducción puede condicionar un despliegue. Consulta
[Transcripciones doradas](/es/guide/transcripciones).

```ts
import { assertTranscript, parseTranscript } from '@botmesh/core/testing'

await assertTranscript(parseTranscript(readFileSync('tests/golden/checkout.json', 'utf8')), buildBot)
```

## Comprobaciones estáticas

[`eslint-plugin-botmesh`](/es/guide/eslint) (experimental) detecta restos de la
API v1, un `runtime.enter()` bloqueante, `install()` async en plugins,
triggers vacíos, esperas sin timeout y estado por usuario en variables de
módulo antes de ejecutar el código.

## Siguientes pasos

- [Simulador en la terminal](./simulador): prueba el bot a mano
- [Inspeccionar y validar flujos](./inspeccion-flujos)
