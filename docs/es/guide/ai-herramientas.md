# Herramientas de IA (tool calling)

Con `tools`, el modelo de [`@bot-wa/ai`](/es/guide/ai) puede llamar a funciones
de tu bot (buscar en el catálogo, consultar un pedido, crear una reserva)
mediante el *tool / function calling* nativo de cada proveedor. Declaras cada
herramienta una vez; el plugin la traduce para Anthropic, OpenAI, Gemini u
Ollama, ejecuta un bucle de varios pasos y le devuelve los resultados al modelo
hasta que escribe la respuesta final.

::: warning Alpha — primera publicación en npm pendiente
`@bot-wa/ai` forma parte de la primera alpha, que **todavía no está en npm**.
Úsalo desde el monorepo (`workspace:*`) hasta que se publique.
:::

## Declarar herramientas

```ts
import { aiPlugin, defineTool } from '@bot-wa/ai'
import { z } from 'zod' // optional: any schema with safeParse()

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  persona: 'Eres el asistente de Panadería La Espiga.',
  tools: {
    buscar_producto: {
      description: 'Busca productos del catálogo por texto',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: async ({ q }: { q: string }) => db.products.search(q),
    },
    crear_pedido: defineTool({
      title: 'Crear pedido', // shown to the user in the confirmation
      description: 'Crea un pedido para el cliente. items: claves del menú y cantidades',
      schema: z.object({
        items: z.array(z.object({ producto: z.enum(['pan_centeno', 'croissant']), cantidad: z.number().int().min(1) })).min(1),
      }),
      confirm: true, // ask the user "yes/no" before running it
      dedupe: 'args', // never run the very same order twice in a row
      timeoutMs: 10_000,
      handler: async (args, { ctx }) => db.orders.create({ ...args, chat: ctx?.from }),
    }),
  },
}))
```

Cada entrada de `tools` es un `AITool`; la clave es el nombre que ve el modelo.

| Campo | Tipo | Descripción |
|---|---|---|
| `description` | `string` | Qué hace la herramienta. El modelo lo lee para decidir cuándo llamarla; nunca se le muestra al usuario. |
| `title` | `string` | Etiqueta corta que ve el usuario en la confirmación por defecto (`'Crear pedido'`). Por defecto, el nombre humanizado (`crear_pedido` → `Crear pedido`). |
| `schema` | JSON Schema o validador con `safeParse` | Argumentos. Si se omite, no tiene argumentos. |
| `jsonSchema` | JSON Schema | Esquema que ve el modelo (útil con validadores `safeParse`). |
| `handler` | `(args, tctx) => unknown` | Ejecuta la herramienta. Un string vuelve al modelo tal cual, `undefined` como `'ok'` y cualquier otra cosa serializada a JSON. |
| `confirm` | `boolean` | Pide confirmación humana antes de ejecutarla (ver [más abajo](#confirmacion-humana)). |
| `confirmMessage` | `string \| (args) => string` | Texto de confirmación propio. |
| `dedupe` | `'args' \| { windowMs }` | No la vuelve a ejecutar con los mismos argumentos dentro de la ventana (`'args'`: 10 minutos) en el mismo chat (ver [Efectos secundarios repetidos](#efectos-secundarios-repetidos)). |
| `timeoutMs` | `number` | Timeout de esta herramienta; manda sobre `toolTimeoutMs`. |

`defineTool<TArgs>(tool)` es un helper identidad: solo infiere el tipo de los
argumentos del handler para que el editor autocomplete `args`.

### Esquemas

- **JSON Schema**: se envía tal cual al modelo y se valida con un subconjunto
  propio (`type`, `required`, `properties`, `enum`, `const`, `items`,
  `additionalProperties: false`, `minimum`/`maximum` y sus formas exclusivas,
  `minLength`/`maxLength`, `minItems`/`maxItems`).
- **Validadores con `safeParse`** (zod y similares): los argumentos se validan
  con `safeParse()` y el handler recibe el `data` ya parseado. El esquema para
  el modelo sale de `toJSONSchema()` si el validador lo tiene (zod v4); si no,
  pasa `jsonSchema` a mano.

Los argumentos inválidos nunca llegan al handler **ni al usuario**: se validan
antes de cualquier confirmación, así que nadie aprueba una llamada que no se
puede ejecutar. El modelo recibe un resultado de error (que dice que no se le
preguntó al usuario) y puede reintentar. Usa `enum` para conjuntos cerrados
como las claves de producto: en una prueba real el modelo pasó
`"torta de chocolate"` en vez de la clave `torta_chocolate`, y solo el `enum`
lo frena antes de preguntarle al usuario.

### El contexto del handler

El segundo argumento de `handler` es un `AIToolContext`:

| Campo | Descripción |
|---|---|
| `tool` | Nombre de la herramienta en ejecución. |
| `callId` | Id de esta llamada (lo asigna el proveedor o se sintetiza). |
| `chatKey` | Clave de conversación (`chatKeyOf(ctx)`) si la llamada viene de un turno de chat. |
| `ctx` | El `MessageContext` del turno (autoresponder, o `replyInChat(..., { ctx })`). |
| `signal` | Se aborta cuando vence el timeout o se cancela el turno. Pásalo a `fetch` y compañía. |

## El bucle de herramientas

Cada turno ejecuta un bucle: llama al modelo con las definiciones; mientras
pida herramientas, valida los argumentos, pide confirmación si hace falta,
ejecuta cada handler con su timeout y le devuelve los resultados.

- **`maxSteps`** (por defecto `5`) limita las llamadas al modelo por turno. Las
  herramientas pedidas en el último paso permitido **no** se ejecutan (el
  modelo nunca vería su resultado): el turno responde `maxStepsMessage` y emite
  `loop.max_steps`.
- Varias llamadas en el mismo paso se ejecutan una tras otra, en orden.
- **Los errores van al modelo, nunca al usuario**: un handler que lanza,
  argumentos inválidos, una herramienta desconocida, un timeout o una
  confirmación rechazada se convierten en resultados fallidos, para que el
  modelo se recupere o lo explique.
- **Timeouts**: `toolTimeoutMs` (por defecto `15000`, `0` lo desactiva) se
  aplica a todas las herramientas salvo a las que fijan su propio `timeoutMs`.
  Al vencer se aborta el `signal` del handler. Cada llamada al modelo mantiene
  el `timeoutMs` del plugin.
- El historial guardado sigue siendo texto plano usuario/asistente: los turnos
  intermedios de herramientas no se persisten.

| Opción | Por defecto | Descripción |
|---|---|---|
| `tools` | — | El conjunto de herramientas. |
| `maxSteps` | `5` | Máximo de llamadas al modelo por turno. |
| `toolTimeoutMs` | `15000` | Timeout por defecto de cada herramienta (`0` lo desactiva). |
| `maxStepsMessage` | mensaje localizado `ai.tools.maxSteps` (es: `'No pude completar la solicitud. Intenta de nuevo con más detalle.'`) | Respuesta cuando el bucle llega a `maxSteps`. |
| `toolConfirm` | `{ timeout: '2m' }` | `{ yes?, no?, timeout?, systemNote? }` para las herramientas `confirm: true` del autoresponder. |
| `onToolEvent` | — | Callback de auditoría para cada evento del bucle. |

::: tip Herramientas y streaming
Un turno con herramientas nunca se transmite en vivo: con `tools`
configuradas, el autoresponder ignora la opción
[`stream`](/es/guide/streaming#con-bot-wa-ai) y responde en un solo mensaje, y
`streamReplyInChat()` no ejecuta herramientas.
:::

## Confirmación humana

Una herramienta con `confirm: true` solo se ejecuta cuando una persona la
aprueba.

**En el autoresponder** el plugin le pregunta al usuario. La pregunta
(`confirmMessage`, o una legible por defecto, ver más abajo) se hace dentro de
una conversación del runtime, así que el handler termina y libera la cola FIFO
del chat: la respuesta del usuario llega a la conversación y el bucle
continúa. Nunca bloquea el chat.

La respuesta se clasifica con `classifyConfirmation()`:

- **Un sí claro** (`sí`, `ok`, `dale`, `sí, por favor`…) ejecuta la herramienta.
- **Un no claro** (`no`, `no, gracias`, `cancelar`…) la rechaza y se le dice
  al modelo que no reintente.
- **Cualquier otra cosa**, incluido un sí que pide cambios (`sí pero cambia a
  5 unidades`), **no** ejecuta la herramienta ni se descarta: el modelo recibe
  `{ "executed": false, "reason": "user_replied", "userReply": "…" }` para
  volver a llamarla con los argumentos corregidos (el usuario confirma de
  nuevo) o responder la pregunta.

Las respuestas se comparan sin mayúsculas, tildes ni puntuación, y se ignoran
las cortesías alrededor del sí/no. Las palabras de "sí" por defecto
(`DEFAULT_YES`) son `si`, `s`, `yes`, `y`, `ok`, `okay`, `confirmo`,
`confirmar`, `dale`, `claro`, `de acuerdo`, `acepto`, `1`, `vale`, `listo`,
`perfecto`, `adelante`, `hazlo`, `correcto`, `está bien`, `sure`, `yeah` y
`yep`; las de "no" (`DEFAULT_NO`) son `no`, `n`, `nop`, `nope`, `nel`,
`cancelar`, `cancela`, `cancelo`, `cancel`, `negativo`, `mejor no`,
`para nada`, `tampoco`, `no gracias`, `2` y `0`. Cámbialas con
`toolConfirm.yes` / `toolConfirm.no`.

- **Sin doble confirmación**: cuando el turno tiene confirmador, el prompt de
  sistema lleva una nota localizada (`ai.tools.confirmNote`) con las
  herramientas `confirm: true`, que le pide al modelo no preguntar "¿te lo
  registro?" sino llamar a la herramienta en cuanto el usuario exprese la
  intención. `toolConfirm.systemNote` la cambia por tu texto o la apaga
  (`false`).
- `toolConfirm.timeout` (por defecto `'2m'`) limita la espera. Un timeout o
  `/reset` cancela el turno **en silencio**; `/reset` también lo cancela
  después de la aprobación, así que el turno viejo no responde ni escribe en el
  historial recién borrado.
- Los turnos de un mismo chat se serializan: un mensaje nuevo espera a que
  termine un turno desacoplado. Una confirmación nunca reemplaza una
  conversación que el usuario haya abierto entretanto; el turno se cancela y no
  responde encima de ese flujo.

El texto por defecto nunca muestra la descripción de la herramienta (escrita
para el modelo) ni JSON crudo. Es el mensaje localizado `ai.tools.confirm` con
el `title` de la herramienta y una línea corta por argumento; un único
argumento lista muestra una línea por elemento, y los elementos con cantidad
se leen como `cantidad × producto`:

```text
Voy a: Crear pedido
• 5 × torta_chocolate
• 2 × cafe
¿Confirmas? (sí/no)
```

Está en español por defecto y en inglés (`About to: Create order … Do you
confirm? (yes/no)`) cuando `ctx.lang` es `en` (ver
[i18n](/es/guide/i18n#mensajes-internos)). Cámbialo por idioma con
`bot.locale('es', { ai: { tools: { confirm: '¿Ejecuto {tool}?{args}' } } })`
(`{tool}` es el título y `{args}` un salto de línea más las líneas `• `, o
vacío), o usa `confirmMessage` en la herramienta.

**Dentro de tu propia conversación** pasa `confirmWith(c)`: pregunta con
`c.ask()`, que tampoco bloquea la cola.

```ts
import { chatKeyOf, confirmWith } from '@bot-wa/ai'

bot.conversation('soporte', async (c, ctx) => {
  const texto = await c.ask('¿En qué te ayudo?')
  const respuesta = await ctx.tools.ai.replyInChat(chatKeyOf(ctx), texto, {
    ctx,
    confirm: confirmWith(c, { timeout: '1m' }),
  })
  await ctx.reply(respuesta)
})
```

`confirmWith(c, { yes, no, timeout })` clasifica la respuesta igual que el
autoresponder: `'approved'`, `'denied'` o `{ reply }`. Un error
de control de la conversación (timeout, cancelación, conversación
reemplazada) sale del bucle como siempre, para que lo gestione el runtime.

**Sin confirmador** (por ejemplo un `ctx.tools.ai.ask()` suelto), las
herramientas `confirm: true` se deniegan y se le dice al modelo que no había
confirmación humana disponible.

También puedes escribir tu propio `ToolConfirmer`: una función async que
recibe `{ tool, callId, args, description, title, prompt, previous? }` y
resuelve `'approved'`, `'denied'`, `{ reply: string }` (la respuesta libre del
usuario, que se le pasa al modelo) o `'cancelled'`. `'cancelled'` aborta el
turno entero: el bucle lanza `AIToolCancelledError` (con el nombre en `tool`).

## Efectos secundarios repetidos

A veces el modelo vuelve a llamar por su cuenta a una herramienta con efectos
(por ejemplo para "corregir" el total de un pedido después de que el usuario
dijo "no, nada más"). El cliente recuerda por chat las ejecuciones correctas de
las herramientas `confirm: true` y `dedupe` (en memoria, 30 minutos; `/reset` y
`ctx.tools.ai.clearToolHistory(chatKey)` las olvidan) y las usa de tres formas:

- **Aviso en la confirmación**: si una herramienta `confirm: true` ya se
  ejecutó en el chat, la pregunta empieza con una línea localizada
  (`ai.tools.confirmRepeat`): `Ojo: ya hice «Crear pedido» hace un momento
  (resultado: …). Si confirmas, se hará otra vez.` El confirmador la recibe
  también como `previous`.
- **Prompt de sistema**: los turnos siguientes listan las acciones ya hechas
  (`ai.tools.doneNote`) y le piden al modelo no repetirlas salvo que el usuario
  lo pida explícitamente.
- **`dedupe`** (opcional por herramienta): una llamada con los mismos
  argumentos validados que una ejecución correcta dentro de la ventana no se
  ejecuta ni se confirma; el modelo recibe
  `{ "executed": false, "reason": "duplicate", "previous": { "result", "secondsAgo" } }`.
  `dedupe: 'args'` usa una ventana de 10 minutos; `dedupe: { windowMs: 60_000 }`
  fija la tuya. También sirve para herramientas sin `confirm`.

`toolConfirm.systemNote: false` también apaga la lista del prompt de sistema.

## Eventos de auditoría

Cada paso del bucle emite un `AIToolEvent`, tanto a `onToolEvent` como en el
bot como `'ai.tool'`:

```ts
import type { AIToolEvent } from '@bot-wa/ai'

bot.on('ai.tool', (e: AIToolEvent) => {
  audit.write({ type: e.type, tool: e.tool, step: e.step, chat: e.chatKey, ms: e.durationMs })
})
```

| `type` | Cuándo |
|---|---|
| `tool.call` | Argumentos validados; la herramienta va a ejecutarse (o a confirmarse). |
| `tool.confirm.requested` | Una herramienta `confirm: true` pidió aprobación. |
| `tool.confirm.approved` / `.denied` / `.cancelled` | Resultado de la confirmación. |
| `tool.confirm.replied` | El usuario respondió algo distinto de un sí/no claro; el texto pasó al modelo. |
| `tool.duplicate` | Se volvió a llamar a una herramienta `dedupe` con los mismos argumentos; no se ejecutó. |
| `tool.result` | El handler terminó (`durationMs`). |
| `tool.error` | El handler lanzó (`error`, `durationMs`). |
| `tool.timeout` | El handler superó su timeout (`error`, `durationMs`). |
| `tool.invalid_args` | Los argumentos no pasaron la validación (`error`). |
| `tool.unknown` | El modelo pidió una herramienta que no existe. |
| `loop.max_steps` | El bucle se detuvo en `maxSteps`. |

Cada evento lleva `at` (ms epoch), `step` (empieza en 1) y, cuando aplica,
`tool`, `callId`, `chatKey`, `args`, `durationMs` y `error`.

::: warning `args` puede contener datos personales
Los eventos incluyen los argumentos que generó el modelo. Trátalos como datos
personales en tu sistema de auditoría. El log de depuración del plugin solo
registra metadatos (herramienta, tipo, paso, duración).
:::

## Proveedores

| Proveedor | Tool calling nativo |
|---|---|
| `anthropic` | Sí (`tools` / `tool_use`) |
| `openai` y los presets compatibles con OpenAI | Sí (`tools` / `tool_calls`); depende de que el modelo del proveedor lo soporte |
| `gemini` | Sí (`functionDeclarations` / `functionCall`) |
| `ollama` | Sí (`tools` / `tool_calls`); depende de que el modelo local lo soporte |

Las llamadas en streaming (`stream()`, `streamReplyInChat()`) nunca envían
herramientas.

## Usar herramientas desde tu código

Con `tools` configuradas, `ctx.tools.ai.ask()` y `ctx.tools.ai.replyInChat()`
ejecutan el bucle solos. Ambos aceptan `{ ctx, confirm, signal, chatKey }`.
Para control total, `runTools()` devuelve el resultado del bucle:

```ts
const r = await ctx.tools.ai.runTools(
  { messages: [{ role: 'user', content: ctx.body }] },
  { ctx },
)
r.text            // final answer
r.steps           // model calls made
r.toolResults     // every tool result, in order
r.maxStepsReached // true when the loop stopped at maxSteps
```

`runToolLoop()` es el mismo bucle sin `AIClient`: le pasas las herramientas,
una función `generate` y los mensajes.

```ts
import { resolveProvider, runToolLoop } from '@bot-wa/ai'

const provider = await resolveProvider({ provider: 'anthropic' })
const r = await runToolLoop({
  tools,
  generate: (input) => provider.generate(input),
  base: { system: 'Eres un asistente de inventario.' },
  messages: [{ role: 'user', content: '¿Queda pan de centeno?' }],
  maxSteps: 3,
  onEvent: (e) => console.log(e.type),
})
```

## Testing

`MockAIProvider` puede simular llamadas a herramientas: devuelve
`{ toolCalls }` desde `reply` para que el "modelo" llame a una herramienta, y
texto plano para terminar. Construye un `AIClient` con tus herramientas y
comprueba el resultado:

```ts
import { AIClient, ContextManager, MockAIProvider } from '@bot-wa/ai'
import { MemoryStore } from '@bot-wa/core'

const mock = new MockAIProvider({
  reply: (input) => input.messages.at(-1)?.role === 'tool'
    ? 'Tenemos pan de centeno.'
    : { toolCalls: [{ name: 'buscar_producto', args: { q: 'centeno' } }] },
})

const buscados: string[] = []
const client = new AIClient(mock, new ContextManager(new MemoryStore()), {
  tools: {
    buscar_producto: {
      description: 'Busca en el catálogo',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: ({ q }: { q: string }) => { buscados.push(q); return ['pan de centeno'] },
    },
  },
})

expect(await client.ask('¿tienen centeno?')).toBe('Tenemos pan de centeno.')
expect(buscados).toEqual(['centeno'])
```

`mock.calls` guarda cada petición que envió el cliente (con sus `messages` y
`tools`), así que también puedes comprobar qué vio el modelo.

## Siguientes pasos

- [Plugin de IA](/es/guide/ai) — proveedores y la referencia completa de `aiPlugin`
- [Memoria y RAG](/es/guide/ai-memoria-rag) — hechos por usuario y respuestas con tus documentos
- [Flujos conversacionales](/es/guide/flujos) — el runtime que aloja las confirmaciones
