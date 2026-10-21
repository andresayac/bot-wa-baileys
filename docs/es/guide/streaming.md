# Respuestas en streaming (`ctx.stream`)

`ctx.stream(source, opts)` envía una respuesta que todavía se está generando
(tokens de un LLM, un informe largo) a medida que se produce, con la mejor
estrategia que admite el canal: borradores nativos en Telegram, ediciones en
vivo en Discord y mensajes del tamaño de una frase con "escribiendo…" en
WhatsApp. El mismo handler funciona en todos los canales.

```ts
bot.when('cuento', async (ctx) => {
  const result = await ctx.stream(
    ctx.tools.ai.stream({ messages: [{ role: 'user', content: 'Cuéntame un cuento corto' }] }),
  )
  result.text       // full text received
  result.messages   // every message sent
  result.strategy   // 'draft' | 'edit' | 'chunk' | 'buffer'
})
```

La fuente puede ser cualquier `AsyncIterable` de strings o bytes (un
generador async, un `Readable` de Node), un `ReadableStream` web o un
`Iterable` de strings. Los fragmentos en bytes se decodifican como UTF-8.

## Estrategias por canal

El provider declara `capabilities.streaming` (`'draft' | 'edit' | 'none'`) y
`ctx.stream()` elige la estrategia a partir de ahí:

| Estrategia | Qué ve el usuario | Se usa por defecto en |
|---|---|---|
| `'draft'` | Una vista previa efímera nativa que se actualiza en el sitio y luego un mensaje final. | Chats privados de Telegram (`sendMessageDraft`) |
| `'edit'` | Se envía el primer texto y luego ese mensaje se edita a medida que llega texto. | Discord; grupos de Telegram |
| `'chunk'` | Sin vista previa: mensajes del tamaño de una frase, con "escribiendo…" entre ellos. | WhatsApp (Baileys y Cloud API), Messenger, Instagram y cualquier provider sin `streaming` |
| `'buffer'` | "Escribiendo…" mientras se junta todo y luego un solo envío (partido si es largo). | Solo si se pide |

- Los borradores solo se intentan en chats privados. Si el transporte rechaza
  un borrador en tiempo de ejecución, el stream baja a ediciones (si el canal
  puede editar) o a trozos.
- `strategy` fuerza una opción; una no soportada baja
  `draft` → `edit` → `chunk`. `'chunk'` y `'buffer'` siempre están
  disponibles.
- Ningún mensaje supera `maxLength` (por defecto
  `capabilities.maxTextLength`, si no 4096): el texto largo se parte por
  límites naturales (párrafos, líneas, frases, palabras) y sigue en un mensaje
  nuevo.

## Opciones

| Opción | Por defecto | Descripción |
|---|---|---|
| `strategy` | `'auto'` | `'auto' \| 'draft' \| 'edit' \| 'chunk' \| 'buffer'`. |
| `throttleMs` | `400` (draft), `1000` (edit) | Mínimo de ms entre dos actualizaciones en vivo. |
| `signal` | — | `AbortSignal` que cancela el stream. |
| `onCancel` | `'flush'` | Al cancelar, `'flush'` envía lo producido; `'discard'` no envía nada más y quita la vista previa (ver abajo). |
| `maxLength` | `capabilities.maxTextLength`, si no 4096 | Máximo de caracteres por mensaje. |
| `minChunkChars` | `160` | `'chunk'`: mínimo de caracteres antes de enviar un trozo en un fin de frase. |
| `maxChunkChars` | `min(maxLength, 1500)` | `'chunk'`: tamaño fijo de un trozo sin fin de frase. |
| `typing` | `true` | Muestra "escribiendo…" mientras espera (chunk, buffer y edit antes de su primer mensaje). |
| `typingIntervalMs` | `8000` | Cada cuánto se refresca el indicador. |
| `cursor` | `''` | Sufijo de los borradores y ediciones en curso (p. ej. `' ▌'`); nunca aparece en el texto final. |
| `canStop` | `false` | Borrador: muestra un botón de parar (Telegram `can_stop`). |
| `keepOnStop` | — | Borrador: mantiene el borrador visible cuando el usuario lo para (Telegram `keep_on_stop`). |
| `sendOptions` | — | Opciones del primer mensaje enviado (p. ej. `{ quoted: ctx.ref }`). |
| `draftPlatformData` | — | Datos del transporte para los borradores (p. ej. `message_thread_id` de Telegram). |

`ctx.stream()` resuelve con un `StreamResult`: `text`, `messages`,
`strategy` (la que se usó al final, tras cualquier fallback), `cancelled` y
`stoppedByUser`. Rechaza con el error de la fuente (después de enviar lo
producido) o con el primer error de envío.

## Cancelación

Un stream se detiene cuando se aborta `signal` o, en los borradores de
Telegram con `canStop: true`, cuando el usuario pulsa el botón de parar
(`stoppedByUser: true`). Se deja de leer y se llama al `return()` de la
fuente, así que una petición de IA también se aborta. `bot.stop()` también cancela
todos los `ctx.stream()` en curso (después del `drain`, si lo hay), pero no envía
nada más: ni envío final, ni edición, ni borrado, diga lo que diga `onCancel`.

- `onCancel: 'flush'` (por defecto) envía el texto producido hasta entonces.
- `onCancel: 'discard'` no envía nada más: un borrador simplemente caduca y,
  con la estrategia de edición, se borra el mensaje que se estaba editando (si
  el canal puede borrar; si no, solo se quita el cursor). Los mensajes ya
  completados antes de cancelar se quedan.

El long-poll de Telegram pide las actualizaciones
`stopped_message_generation`, que traen las pulsaciones del botón de parar.

## Límites de envío

Las actualizaciones en vivo se espacian y nunca corren en paralelo. Si el
transporte responde con un `RateLimitedError`, se pausan durante su
`retryAfterMs`. La edición final (que quita el cursor y muestra el texto
completo) espera a que pase la pausa y reintenta un límite hasta tres veces.

## Hooks y el log de mensajes

Todo lo que envía `ctx.stream()` pasa por los [hooks](/es/guide/hooks)
`before('send')`, así que un hook que censura, traduce o aborta respuestas
también cubre el texto en streaming. El payload lleva una marca `stream`:

| `payload.stream` | Qué es | Hooks |
|---|---|---|
| `'draft'` | Una vista previa en borrador. | Solo `before('send')` |
| `'edit'` | Una edición en vivo del mensaje en streaming. | Solo `before('send')` |
| `'message'` | Un mensaje nuevo que envía el stream: el primero de un stream de edición, cada trozo, el mensaje final tras los borradores. | `before('send')` y `after('send')` |

```ts
bot.before('send', async (payload, next) => {
  if (payload.stream === 'draft' || payload.stream === 'edit') {
    // live preview: cheap transforms only, it runs on every update
  }
  await next()
})
```

Un hook que aborta un borrador o una edición se salta esa actualización. El
log de mensajes guarda el texto final editado de cada mensaje.

## Con `@botmesh/ai`

El autoresponder de IA transmite su respuesta con la opción `stream`:

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',
  persona,
  stream: true,                                        // default StreamOptions
  // stream: { cursor: ' ▌', canStop: true, onCancel: 'discard' },
}))
```

- `stream` acepta `true` o las `StreamOptions` de arriba (sin `signal` ni
  `sendOptions`), más `enabled: false` para apagarlo conservando las opciones.
  Por defecto está apagado (un mensaje al final).
- El "escribiendo…" sigue a `humanizeTyping` salvo que fijes `typing`.
- Un rechazo responde `refusalMessage` y no se guarda; una respuesta vacía
  responde `errorMessage`, igual que un stream que falla.
- Con `onCancel: 'discard'`, una respuesta cancelada tampoco entra en el
  contexto de IA, porque el usuario nunca la vio completa.
- Con `tools` configuradas los turnos no se transmiten: el
  [bucle de herramientas](/es/guide/ai-herramientas) necesita la respuesta
  completa, así que el autoresponder vuelve a un solo mensaje.

En tus propios handlers, `ctx.tools.ai.streamReplyInChat()` es el gemelo en
streaming de `replyInChat()`: lee y guarda el historial del chat, aplica
[memoria y RAG](/es/guide/ai-memoria-rag) y entrega la respuesta por partes.

```ts
import { chatKeyOf } from '@botmesh/ai'

bot.when('explica', async (ctx) => {
  await ctx.stream(
    ctx.tools.ai.streamReplyInChat(chatKeyOf(ctx), ctx.body, { userId: ctx.sender, isGroup: ctx.isGroup }),
    { cursor: ' ▌' },
  )
})
```

Detener el stream aborta la petición al proveedor; la respuesta parcial se
guarda salvo que pases `keepPartial: false` (combínalo con
`onCancel: 'discard'`). El `timeoutMs` del plugin funciona como timeout de
inactividad: si no llega ningún fragmento en ese tiempo, lanza
`AITimeoutError`.

Con [`@botmesh/voice`](/es/guide/voz) y `autoReplyWithVoice`, la salida en
streaming siempre se queda en texto.

## Destinos propios

`ctx.stream()` es `streamText()` ligado al chat actual. Para otros destinos
(un widget web, un test) úsalo directamente con un `StreamTarget`:

```ts
import { streamText, splitMessage } from '@botmesh/core'

const result = await streamText({
  capabilities: { streaming: 'edit', maxTextLength: 2000 },
  send: async (content) => widget.post(content),
  edit: async (ref, content) => widget.update(ref, content),
}, source, { throttleMs: 500 })

for (const part of splitMessage(longText, 4096)) await ctx.reply(part)
```

`resolveStreamStrategy(target, requested)` dice qué estrategia tendría un
destino, y `findSplitPoint(text, max)` dónde se cortaría el texto.

## Testing

`MockProvider` simula cada modo con su opción `streaming`:

```ts
import { vi } from 'vitest'
import { createTestBot } from '@botmesh/core/testing'

const { bot, chat, provider } = await createTestBot({}, { provider: { streaming: 'edit' } })
let done = false
bot.when('hola', async (ctx) => {
  await ctx.stream(['Hola', ' humano'], { throttleMs: 0 })
  done = true
})

await chat.send('hola')
await vi.waitFor(() => expect(done).toBe(true)) // the stream outlives chat.send()
provider.outbox // the first message
provider.edits  // the live and final edits
```

`streaming: 'edit'` también expone `editMessage` (se registra en `edits`) y
`deleteMessage` (`deleted`); `streaming: 'draft'` añade `sendDraft` (se
registra en `drafts`). `maxTextLength` simula el límite de longitud y
`supports` activa u oculta cada método por separado.

## Siguientes pasos

- [Plugin de IA](/es/guide/ai) — el autoresponder y `ctx.tools.ai`
- [Mensajes y media](/es/guide/mensajes) — ediciones, "escribiendo…" y soporte por transporte
- [Hooks](/es/guide/hooks) — el pipeline de `send`
