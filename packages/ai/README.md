# @bot-wa/ai

Plugin de IA multi-proveedor (Anthropic / OpenAI / Ollama / Gemini + 9 presets
compatibles con OpenAI) para
[`@bot-wa/core`](https://github.com/andresayac/bot-wa-baileys). Un
`bot.plug(aiPlugin(...))` te da un autoresponder catch-all con memoria de
conversación por chat; `ctx.tools.ai` te da el cliente completo para usarlo
donde quieras (flows, conversaciones, comandos).

> **Alpha — primera publicación en npm pendiente.** `@bot-wa/ai` forma parte de
> la primera alpha, pero todavía **no está en npm**: hasta entonces, úsalo
> desde este monorepo (`workspace:*`). Los comandos `pnpm add` de abajo son los
> que funcionarán cuando se publique.

## Política de IA de WhatsApp (desde el 15-01-2026)

Desde el **15 de enero de 2026**, los términos de Meta para la **WhatsApp
Business Platform** (sección *AI Providers*) **prohíben los asistentes de IA de
propósito general**: chatbots abiertos estilo ChatGPT cuya funcionalidad
principal es la propia IA. Sigue estando **permitido** usar IA al servicio del
propio negocio: atención al cliente, ventas, reservas, seguimiento de pedidos.

En la práctica, con `aiPlugin`:

- Escribe una `persona` **acotada a tu negocio** (qué vendes, horarios,
  políticas) que rechace con amabilidad lo que no tenga que ver con él. Mira el
  [Quickstart](#quickstart-modo-principiante).
- Ofrece una salida hacia una persona y no presentes el bot como un asistente
  "para todo".
- La regla viene de los términos de la Cloud API oficial (`@bot-wa/meta`). Baileys es un cliente
  no oficial de WhatsApp Web y también está sujeto a los términos de WhatsApp.

Es una guía práctica, no asesoría legal: revisa los
[términos vigentes](https://www.whatsapp.com/legal/business-solution-terms)
antes de salir a producción.

## Instalación

```bash
pnpm add @bot-wa/ai @anthropic-ai/sdk
```

El segundo paquete es el SDK del proveedor que vayas a usar — instala el que
corresponda:

| Proveedor | SDK a instalar |
|---|---|
| `anthropic` (default) | `@anthropic-ai/sdk` |
| `openai` | `openai` |
| `ollama` | ninguno (habla HTTP directo con `fetch` contra un servidor Ollama) |
| `gemini` | `@google/generative-ai` |
| `deepseek` · `qwen` · `glm` · `kimi` · `groq` · `openrouter` · `mistral` · `grok` · `together` | `openai` (son OpenAI-compatible; usan su `baseURL`, **sin SDK extra**) |

Requiere **Node >= 22** y `@bot-wa/core` ya instalado en tu proyecto.

## Quickstart (modo principiante)

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { aiPlugin } from '@bot-wa/ai'

const bot = new Bot({ provider: new BaileysProvider({ session: 'mi-bot' }) })

// Persona acotada al negocio (ver "Política de IA de WhatsApp" arriba).
const persona = [
  'Eres el asistente de atención al cliente de Panadería La Espiga.',
  'Solo respondes sobre sus productos, precios, horarios (lun-sáb 7:00-20:00), pedidos y encargos.',
  'Si te piden algo ajeno a la panadería, di con amabilidad que solo puedes ayudar con eso',
  'y ofrece pasar la conversación a una persona. Responde breve y en español; no inventes datos.',
].join(' ')

bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  persona,
}))

await bot.start()
```

Con esto el plugin registra:
- Un autoresponder catch-all (`bot.onMessage`) que contesta cualquier mensaje
  de **texto** que ningún otro handler/comando/conversación haya consumido,
  manteniendo el historial por chat (ventana acotada, 20 mensajes por
  defecto, ver `context.maxMessages`).
- Un comando `/reset` que limpia el contexto de IA del chat y cancela la
  conversación activa (opt-out con `resetCommand: false`).

## Modo avanzado: `ctx.tools.ai`

El plugin también hace `bot.provide('ai', client)`, así que puedes usar
`ctx.tools.ai` dentro de tus propios `when()`, flows o conversaciones.
Desactiva el autoresponder (`autoReply: false`) si solo quieres esto:

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  autoReply: false,
}))

bot.conversation('reclamo', async (c, ctx) => {
  await ctx.reply('📝 Cuéntanos qué pasó con tu pedido:')
  const texto = await c.waitText()
  const resumen = await ctx.tools.ai.ask(
    `Resume en 3 líneas este reclamo de un cliente para el equipo de soporte: ${texto}`,
  )
  await ctx.reply(`✅ Registramos tu reclamo:\n${resumen}`)
})
```

`ctx.tools.ai` (la clase `AIClient`) expone:

- `ask(prompt: string, opts?): Promise<string>` — pregunta suelta, **sin** historial
  de chat (no lee ni escribe el contexto guardado). Usa la `persona`/`model`/
  `maxTokens`/`effort` configurados en `aiPlugin` (y las tools, si hay).
- `replyInChat(chatKey, text, opts?): Promise<string>` — responde dentro del
  historial de un chat (lo lee y guarda el turno), como el autoresponder.
  `opts`: `{ userId, isGroup }` (memoria) y `{ ctx, confirm, signal }` (tools).
  `replyInChatDetailed()` devuelve además `citations` y `facts`.
- `streamReplyInChat(chatKey, text, opts?)` — gemelo en streaming de
  `replyInChat`, para `ctx.stream()` (ver [Streaming](#streaming)).
- `runTools(input, opts?)` — ejecuta el bucle de tools y devuelve su resultado
  completo (`text`, `steps`, `toolResults`, `maxStepsReached`).
- `memory()` / `memoryFacts()` / `remember()` / `forget()` / `extractMemory()` /
  `idle()` — memoria a largo plazo (ver [Memoria](#memoria-a-largo-plazo-por-usuario)).
- `generate(input: { messages, system?, model?, maxTokens?, effort?, signal? }): Promise<GenerateResult>` —
  control total: mensajes explícitos y overrides puntuales.
- `stream(input): AsyncIterable<string>` — igual que `generate` pero
  entregando el texto en fragmentos (`for await (const delta of ...)`).

**Tipado (TypeScript).** Importar `@bot-wa/ai` amplía la interfaz
`DefaultTools` de `@bot-wa/core` (*module augmentation*), así que
`ctx.tools.ai` ya es un `AIClient` en los handlers de `when()`, `onMessage()`
y `command()` (y en `bot.injectTools.ai`), sin casts:

```ts
bot.when('resumen', async (ctx) => {
  const texto = await ctx.tools.ai.ask(`Resume en una línea: ${ctx.body}`) // string
  await ctx.reply(texto)
})
```

El tipo no comprueba que el plugin esté instalado: sin
`bot.plug(aiPlugin(...))` (o después de `unplug()`), `ctx.tools.ai` es
`undefined` en tiempo de ejecución.

## Proveedores

### Anthropic (default)

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',                     // opcional, es el default
  apiKey: process.env.ANTHROPIC_API_KEY,     // o deja que el SDK lea ANTHROPIC_API_KEY del entorno
  // model: 'claude-opus-4-8',               // default; considera 'claude-sonnet-5' o
                                              // 'claude-haiku-4-5' para chats de alto volumen (más baratos)
}))
```

### OpenAI

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-5.1',   // OBLIGATORIO: OpenAIProvider no trae modelo por defecto
}))
```

`baseUrl` es opcional (endpoints compatibles con la API de OpenAI).

### Ollama (local, sin API key)

```ts
bot.plug(aiPlugin({
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',   // default si se omite
  model: 'llama3.1',                   // OBLIGATORIO: OllamaProvider no trae modelo por defecto
}))
```

### Presets OpenAI-compatible (DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter, Mistral, Grok, Together)

Todos estos hablan el protocolo de OpenAI, así que se resuelven con el SDK
`openai` apuntando a su endpoint — **sin instalar nada extra**. Cada preset
trae un modelo por defecto y lee la API key de su variable de entorno
convencional:

```ts
bot.plug(aiPlugin({ provider: 'deepseek' }))              // DEEPSEEK_API_KEY, modelo deepseek-chat
bot.plug(aiPlugin({ provider: 'qwen', model: 'qwen-max' })) // DASHSCOPE_API_KEY, override de modelo
bot.plug(aiPlugin({ provider: 'groq' }))                  // GROQ_API_KEY, llama-3.3-70b-versatile
bot.plug(aiPlugin({ provider: 'openrouter' }))            // OPENROUTER_API_KEY, openrouter/auto
```

| Preset | Modelo default | Env de la API key |
|---|---|---|
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `qwen` | `qwen-plus` | `DASHSCOPE_API_KEY` |
| `glm` | `glm-4-plus` | `ZHIPUAI_API_KEY` |
| `kimi` | `moonshot-v1-8k` | `MOONSHOT_API_KEY` |
| `groq` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `openrouter` | `openrouter/auto` | `OPENROUTER_API_KEY` |
| `mistral` | `mistral-small-latest` | `MISTRAL_API_KEY` |
| `grok` | `grok-2-latest` | `XAI_API_KEY` |
| `together` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | `TOGETHER_API_KEY` |

Puedes sobreescribir `model` y `baseUrl` en cualquier preset.

### Gemini (nativo)

```ts
bot.plug(aiPlugin({
  provider: 'gemini',
  // model: 'gemini-2.0-flash',   // default
}))
```

Requiere `@google/generative-ai`. La API key se lee de `apiKey`, `GEMINI_API_KEY`
o `GOOGLE_API_KEY`.

> **`model` obligatorio en `openai` y `ollama`.** ninguno de los dos trae un
> default razonable (hay demasiados modelos válidos y cambian seguido); si lo
> omites, el provider lanza un error explícito al primer `generate`/`stream`.
> `anthropic` (`claude-opus-4-8`), `gemini` (`gemini-2.0-flash`) y todos los
> **presets** sí traen default.

Si el proveedor está mal configurado (SDK sin instalar, proveedor
desconocido, API key ausente), `aiPlugin` **no revienta el proceso**: `install`
es síncrono y resuelve el proveedor de forma perezosa. Al arrancar se hace un
"warmup" que registra el problema en el log de errores (con la pista de qué
`pnpm add` correr), y a partir de ahí cada mensaje responde el `errorMessage`
configurado en vez de tumbar el bot.

## Config completa de `aiPlugin(config)`

| Campo | Tipo | Default | Descripción |
|---|---|---|---|
| `provider` | `'anthropic' \| 'openai' \| 'ollama' \| 'gemini' \| 'deepseek' \| 'qwen' \| 'glm' \| 'kimi' \| 'groq' \| 'openrouter' \| 'mistral' \| 'grok' \| 'together'` | `'anthropic'` | proveedor a resolver (los presets son OpenAI-compatible) |
| `model` | `string` | según proveedor | modelo a usar (obligatorio en openai/ollama; presets/gemini/anthropic traen default) |
| `apiKey` | `string` | env del preset | API key; en presets cae a su env convencional (p.ej. `DEEPSEEK_API_KEY`) |
| `baseUrl` | `string` | endpoint del preset | override de endpoint (`baseURL` de openai/presets/anthropic / host de ollama) |
| `instance` | `AIProvider` | — | proveedor ya construido (`MockAIProvider` en tests, o uno propio): omite la resolución de `provider`/`apiKey`/`model` y la carga perezosa del SDK |
| `persona` | `string` | — | system prompt |
| `maxTokens` | `number` | `4096` (anthropic) / `1024` (openai) | límite de tokens de salida (en ollama solo si lo fijas, como `options.num_predict`; el tope de 1024 de la extracción de memoria no se aplica ahí). En modelos de razonamiento incluye los tokens de pensamiento |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | esfuerzo de razonamiento (solo lo usa Anthropic; no se envía a modelos que lo rechazan, como Claude Haiku 4.5) |
| `thinking` | `'auto' \| 'adaptive' \| 'off' \| { budgetTokens }` | `'auto'` | pensamiento de Anthropic: `'auto'` usa el adaptativo solo en modelos que lo soportan (Opus/Sonnet 4.6+, Haiku 5+); en `claude-haiku-4-5` y anteriores no lo envía. `{ budgetTokens }` = pensamiento con presupuesto en modelos antiguos. Un 400 que menciona `thinking`/`effort` se reintenta una vez sin el parámetro |
| `timeoutMs` | `number` | `60000` | timeout por llamada no-streaming; al vencer aborta la petición y rechaza, para que un proveedor colgado no bloquee la cola del chat (`0` lo desactiva, no recomendado) |
| `context.maxMessages` | `number` | `20` | ventana de historial guardada por chat (siempre empieza por un turno del usuario; las respuestas vacías no se guardan) |
| `autoReply` | `boolean` | `true` | registra el autoresponder catch-all |
| `resetCommand` | `boolean` | `true` | registra `/reset` |
| `errorMessage` | `string` | `'⚠️ Ahora no puedo responder, intenta luego.'` | respuesta si el proveedor falla o el modelo responde vacío |
| `refusalMessage` | `string` | `'No puedo ayudar con eso.'` | respuesta cuando el proveedor rehúsa (`stopReason === 'refusal'`: rechazo de Anthropic, `refusal` de OpenAI, bloqueo de seguridad de Gemini) |
| `humanizeTyping` | `boolean` | `true` | envía "escribiendo…" (`ctx.typing()`) mientras se genera la respuesta; la respuesta se salta entonces el `BotConfig.typing`, así que el indicador sale una sola vez |
| `tools` | `Record<string, AITool>` | — | herramientas que el modelo puede llamar (ver [Tool calling](#tool-calling)) |
| `maxSteps` | `number` | `5` | máximo de llamadas al modelo por turno en el bucle de tools |
| `toolTimeoutMs` | `number` | `15000` | timeout por defecto de cada tool (`0` lo desactiva) |
| `maxStepsMessage` | `string` | mensaje localizado `ai.tools.maxSteps` (es: `'No pude completar la solicitud…'`) | respuesta si se agota `maxSteps` |
| `toolConfirm` | `{ yes?: string[]; no?: string[]; timeout?: number \| string; buttons?: boolean; systemNote?: boolean \| string }` | `{ timeout: '2m', buttons: true }` | diálogo de confirmación de las tools `confirm: true` (botones Sí/No donde el canal los muestra) |
| `onToolEvent` | `(e: AIToolEvent) => void` | — | auditoría: recibe cada evento del bucle (también se emite como `bot.on('ai.tool')`) |
| `memory` | `boolean \| AIMemoryConfig` | — | memoria a largo plazo por usuario (ver [Memoria](#memoria-a-largo-plazo-por-usuario)) |
| `rag` | `AIRetriever \| AIRagConfig` | — | RAG: pasajes de tus documentos con citas (ver [RAG](#rag-respuestas-con-tus-documentos)) |
| `stream` | `boolean \| AIStreamConfig` | apagado | transmite el autoresponder con `ctx.stream()` (ver [Streaming](#streaming)) |
| `format` | `'auto' \| TextFormat \| false` | `'auto'` | convierte el Markdown del modelo al formato del chat, `ctx.textFormat` (el `textFormatFor(chatId)` del provider, p. ej. WhatsApp o SMS en Twilio; si no, `capabilities.textFormat`): `*negrita*` en WhatsApp, sin marcas en SMS/Telegram/Messenger/Instagram, intacto en Discord; `false` lo envía tal cual. El historial guarda el texto original. `formatMarkdown()` / `formatMarkdownStream()` se exportan |

## Tool calling

El modelo puede ejecutar funciones del bot mediante el *tool/function calling*
nativo de cada proveedor (Anthropic, OpenAI y presets compatibles, Gemini y
Ollama). Declaras cada tool una vez:

```ts
import { aiPlugin, defineTool } from '@bot-wa/ai'
import { z } from 'zod' // opcional: cualquier esquema con safeParse()

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  tools: {
    buscar_producto: {
      description: 'Busca productos del catálogo por texto',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: async ({ q }: { q: string }) => db.products.search(q),
    },
    crear_pedido: defineTool({
      title: 'Crear pedido', // lo que ve el usuario al confirmar
      description: 'Crea un pedido. items: claves del menú y cantidades', // solo para el modelo
      schema: z.object({
        items: z.array(z.object({ producto: z.enum(['pan_centeno', 'croissant']), cantidad: z.number().int().min(1) })).min(1),
      }),
      confirm: true, // pide "sí/no" al usuario antes de ejecutar
      dedupe: 'args', // no repite el mismo pedido dos veces seguidas
      timeoutMs: 10_000,
      handler: async (args, { ctx }) => db.orders.create({ ...args, chat: ctx?.from }),
    }),
  },
}))
```

- **Bucle multi-paso**: mientras el modelo pida tools se ejecutan y se le
  devuelve el resultado, hasta `maxSteps` (default 5). Las tools que el modelo
  pida en la última llamada permitida no se ejecutan (nunca vería su resultado):
  el turno responde `maxStepsMessage`.
- **Errores al modelo**: una excepción del handler, argumentos inválidos, una
  tool desconocida, un timeout o una negativa del usuario se devuelven al
  modelo como resultado fallido; nunca llegan al usuario como crash.
- **Esquemas**: JSON Schema (validado con un subconjunto: `type`, `required`,
  `properties`, `enum`, `const`, `items`, `additionalProperties: false`,
  `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`) o cualquier
  validador con `safeParse()`. Con zod v4 se usa su `toJSONSchema()`; si no,
  pasa `jsonSchema` a mano. Los argumentos se validan **antes** de pedir
  confirmación: el usuario nunca aprueba una llamada inválida (usa `enum` para
  las claves de producto) y el error vuelve al modelo.
- **Confirmación humana** (`confirm: true`): el autoresponder pregunta al
  usuario dentro de una conversación del runtime y devuelve la cola FIFO del
  chat, así que la respuesta llega sin bloqueos. `/reset` o el timeout
  cancelan el turno en silencio; `/reset` también lo cancela después de la
  aprobación (no responde ni escribe en el historial recién borrado). Tras una confirmación el turno sigue fuera de
  la cola, pero los turnos de un mismo chat se serializan (un mensaje nuevo
  espera a que termine) y una segunda confirmación nunca reemplaza un flujo que
  el usuario haya abierto entretanto: el turno se cancela en silencio y no
  responde encima de ese flujo.

  La pregunta por defecto es legible: el `title` de la tool (o su nombre
  humanizado) y una línea por argumento, nunca la descripción ni JSON
  (`Voy a: Crear pedido` / `• 5 × torta_chocolate` / `¿Confirmas? (sí/no)`).
  Un sí claro ejecuta, un no claro rechaza y **cualquier otra respuesta**
  (`sí pero cambia a 5 unidades`) no ejecuta: el modelo recibe
  `{ executed: false, reason: 'user_replied', userReply }` y vuelve a proponer
  (`classifyConfirmation()`, `toolConfirm.yes` / `toolConfirm.no`). El prompt de
  sistema le avisa al modelo qué tools confirma el sistema, para que no
  pregunte él antes (`toolConfirm.systemNote`, `false` lo apaga).

  **Botones Sí/No**: en los canales con botones nativos (`capabilities.buttons`:
  Telegram, WhatsApp Cloud API, Discord, Messenger, Instagram…) la pregunta sale
  como mensaje de botones con etiquetas localizadas (`ai.tools.button.yes` /
  `.no`) y el resumen sin la coletilla `(sí/no)` (`ai.tools.confirmButtons`).
  Pulsar equivale a escribir sí/no (escribir sigue funcionando), la interacción
  se reconoce y, si el provider edita (Telegram), se quitan los botones. Una
  pulsación sobre una confirmación ya respondida, sustituida o caducada se
  ignora. En canales sin botones (Baileys, Twilio, SMS…) se pregunta por texto;
  `toolConfirm.buttons: false` lo fuerza siempre.

  **Valores legibles y totales**: `labels` traduce valores de argumentos por
  clave (`labels: { producto: { pan_de_bono: 'Pan de bono' } }` → `• 2 × Pan de bono`,
  también dentro de listas) y `confirmLines(args)` sustituye las líneas de
  argumentos por las tuyas (p. ej. precios y total calculados en código), sin
  perder el envoltorio localizado. El modelo y el handler siguen recibiendo las
  claves crudas.

  **Repeticiones**: las ejecuciones correctas de tools `confirm`/`dedupe` se
  recuerdan por chat (en memoria, 30 min, `/reset` las borra): si la tool se
  vuelve a llamar, la pregunta avisa ("Ojo: ya hice «Crear pedido» hace un
  momento…") y el prompt de sistema lista lo ya hecho; con `dedupe: 'args'`
  (o `{ windowMs }`) una llamada con los mismos argumentos ni se ejecuta ni se
  pregunta y el modelo recibe `{ executed: false, reason: 'duplicate', previous }`.
  Un handler que devuelve `{ error }` no cuenta como ejecución hecha.

  Dentro de tu propia conversación usa `confirmWith(c)`:

  ```ts
  bot.conversation('soporte', async (c, ctx) => {
    const texto = await c.ask('¿En qué te ayudo?')
    await ctx.reply(await ctx.tools.ai.replyInChat(chatKeyOf(ctx), texto, { ctx, confirm: confirmWith(c) }))
  })
  ```

  Sin confirmador (p. ej. `ctx.tools.ai.ask()` suelto), las tools
  `confirm: true` se deniegan.
- **Auditoría**: `bot.on('ai.tool', (e) => ...)` u `onToolEvent` reciben
  `tool.call`, `tool.confirm.*` (también `tool.confirm.replied`), `tool.duplicate`,
  `tool.result`, `tool.error`, `tool.timeout`, `tool.invalid_args`, `tool.unknown`,
  `tool.truncated` (llamada cortada por el tope de tokens: no se ejecuta, se avisa al modelo
  y el plugin registra un aviso) y `loop.max_steps`, con `step`,
  `callId`, `chatKey` y `durationMs`. Los eventos incluyen `args`: trátalos
  como datos personales. El logger solo registra metadatos.
- El historial persistido sigue siendo texto plano usuario/asistente; los
  turnos intermedios de tools no se guardan. El streaming no usa tools.

### Buenas prácticas para herramientas con efectos

Salen de pruebas en vivo con modelos reales en WhatsApp: sin ellas el modelo
calcula mal un total en texto libre, muestra claves como `pan_de_bono` o dice
que "reemplazó" un pedido sin tener herramienta para hacerlo.

1. **Nunca dejes que el modelo calcule dinero**: una tool de cotización sin
   efectos (`cotizar_pedido`) para el "¿cuánto cuesta?", el total recalculado en
   el handler que guarda y mostrado en la confirmación con `confirmLines` (o
   `confirmMessage`), y devuelto en el resultado para que el modelo lo repita.
2. **Valida los valores de catálogo con `enum`** (se validan antes de
   confirmar) y acompáñalos con `labels` para que el usuario vea nombres.
3. **Cada tool de crear trae las de cambiar, cancelar y listar**; si solo
   puede crear, el modelo "corrige" creando otro pedido o inventa cambios.
4. **`dedupe: 'args'` en las de crear**, para no registrar dos veces lo mismo.
5. **`{ error }` explícito para ids desconocidos** (`{ error: 'No existe el pedido P-123. Consulta mis_pedidos.' }`),
   nunca un `ok` silencioso; no se recuerda como hecho.
6. **`confirm: true` en todo lo que tenga efectos**; las de solo lectura no lo necesitan.
7. **Deja activa la nota de sistema** (`toolConfirm.systemNote`): prohíbe al
   modelo afirmar acciones que ninguna tool confirmó, pedir confirmación él
   mismo, mencionar el proceso de confirmación o calcular importes.

```ts
const MENU = { pan_de_bono: { name: 'Pan de bono', price: 2500 }, cafe: { name: 'Café', price: 4000 } }
const quote = (items) => {
  const lines = items.map((i) => ({ ...i, nombre: MENU[i.producto].name, subtotal: MENU[i.producto].price * i.cantidad }))
  return { items: lines, total: lines.reduce((s, l) => s + l.subtotal, 0) }
}
const ITEMS = {
  type: 'array', minItems: 1,
  items: {
    type: 'object',
    properties: { producto: { type: 'string', enum: Object.keys(MENU) }, cantidad: { type: 'integer', minimum: 1 } },
    required: ['producto', 'cantidad'],
  },
}

tools: {
  cotizar_pedido: {
    description: 'Calcula precios y total sin registrar nada.',
    schema: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
    handler: ({ items }) => quote(items),
  },
  crear_pedido: {
    title: 'Crear pedido',
    description: 'Registra un pedido nuevo.',
    schema: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
    confirm: true,
    dedupe: 'args',
    confirmLines: ({ items }) => {
      const q = quote(items)
      return [...q.items.map((l) => `• ${l.cantidad} × ${l.nombre}: $${l.subtotal}`), `Total: $${q.total}`]
    },
    handler: async ({ items }, { ctx }) => db.orders.create({ chat: ctx?.from, ...quote(items) }),
  },
  // + actualizar_pedido, cancelar_pedido ({ error } si el id no existe) y mis_pedidos
}
```

El ejemplo completo de la panadería está en la guía
[Herramientas de IA](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/es/guide/ai-herramientas.md#buenas-prácticas-para-herramientas-con-efectos)
y la plantilla `ai-full` de `create-bot-wa` trae las mismas tools.

Para tests, `MockAIProvider` acepta turnos con llamadas a tools:

```ts
new MockAIProvider({
  reply: (input) => input.messages.at(-1)?.role === 'tool'
    ? 'Listo'
    : { toolCalls: [{ name: 'buscar_producto', args: { q: 'pan' } }] },
})
```

## `/reset` y `slashCommandsPlugin`

`aiPlugin` registra su propio `/reset`: limpia el contexto de IA del chat **y**
cancela la conversación activa. El registro de comandos es "último `plug()`
gana" (comportamiento del core), así que si también usas
`slashCommandsPlugin` (que trae su propio `/reset` para cancelar
conversaciones), **instala `aiPlugin` después** para que su `/reset` prevalezca:

```ts
bot.plug(slashCommandsPlugin, { greeting: '🤖 ¡Hola!' })
bot.plug(aiPlugin({ apiKey: process.env.ANTHROPIC_API_KEY })) // su /reset gana
```

## Testing

`MockAIProvider` implementa `AIProvider` con respuestas fijas o programables
y cero red — úsalo para testear tu propia lógica alrededor de `AIClient` sin
llamar a un proveedor real:

```ts
import { AIClient, ContextManager, MockAIProvider, type ConvStore, type AIMessage } from '@bot-wa/ai'

const memory = new Map<string, AIMessage[]>()
const store: ConvStore = {
  async getConversation(k) { return memory.get(k) },
  async setConversation(k, m) { memory.set(k, m) },
  async clearConversation(k) { memory.delete(k) },
}

const client = new AIClient(new MockAIProvider({ reply: 'hola desde el mock' }), new ContextManager(store))

const respuesta = await client.ask('¿qué hora es?')
// respuesta === 'hola desde el mock'
```

## Memoria a largo plazo por usuario

Con `memory`, el plugin recuerda hechos de cada persona entre conversaciones y
reinicios. Se guardan en el perfil persistente `ctx.user` (namespace
`'ai.memory'`, clave `facts`), por `ctx.sender`: la misma persona comparte
memoria entre su chat privado y los grupos. Por privacidad, los hechos **no** se
inyectan en las respuestas a grupos (las lee todo el grupo) salvo con
`injectInGroups: true`.

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  memory: {
    maxFacts: 50,        // se descartan los más antiguos
    ttl: '90d',          // cada hecho caduca a los 90 días (re-afirmarlo lo renueva)
    autoExtract: true,   // tras cada respuesta, el modelo extrae hechos (JSON estricto)
  },
}))

bot.when('qué sabes de mí', async (ctx) => {
  const facts = await ctx.tools.ai.memory(ctx.sender)
  // → ['Prefiere atención en español', 'Es de Bogotá']
  await ctx.reply(facts.join('\n') || 'Aún nada')
})

await bot.injectTools.ai.remember(userId, 'Cliente VIP')  // a mano
await bot.injectTools.ai.forget(userId, 'Cliente VIP')    // uno
await bot.injectTools.ai.forget(userId)                   // todos
await bot.deleteSubject(userId)                           // derecho al olvido: borra también la memoria
```

`autoExtract` corre **en segundo plano** (no bloquea la cola del chat) y solo
acepta exactamente `{"facts": string[]}`; cualquier otra respuesta se descarta.
Admite `{ model, maxTokens, maxFactsPerTurn, instructions, filter }`. `/reset`
borra el contexto del chat, no la memoria a largo plazo. Si se borran los datos
del usuario (`bot.deleteSubject()` o `forget(userId)`) mientras una extracción
está en curso, sus hechos se descartan: no vuelven a aparecer.

## RAG (respuestas con tus documentos)

`rag` acepta cualquier objeto con `retrieve(query)`; el paquete
[`@bot-wa/rag`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/rag) trae uno listo (loaders, chunking, embeddings e índice):

```ts
import { createRag } from '@bot-wa/rag'

bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  rag: {
    retriever: createRag({ documents: ['./docs/faq.md', './docs/productos.pdf'], embeddings: 'openai', chunkSize: 1000, topK: 3 }),
    appendSources: true, // añade "Fuentes: [1] faq.md › Envíos" (conserva el [n] citado)
  },
}))
```

Los pasajes se inyectan numerados en el prompt de sistema y el modelo cita con
`[1]`. `ctx.tools.ai.replyInChatDetailed()` devuelve además `citations` y
`facts`. Si la recuperación falla o tarda más de `rag.timeoutMs` (10 s por
defecto, incluida la primera construcción del índice), se registra y la
respuesta sigue sin contexto, sin bloquear la cola del chat.

## Streaming

Con `stream`, el autoresponder envía la respuesta mientras se genera con
`ctx.stream()` de `@bot-wa/core`: borradores nativos en Telegram, ediciones en
vivo en Discord y trozos por frases con "escribiendo…" en WhatsApp.

```ts
bot.plug(aiPlugin({
  provider: 'anthropic',
  stream: true, // o { cursor: ' ▌', canStop: true, onCancel: 'discard' }
}))
```

- Acepta `true` o las `StreamOptions` del core (sin `signal` ni
  `sendOptions`), más `enabled: false`. Por defecto está apagado.
- Un rechazo responde `refusalMessage` (no se guarda); una respuesta vacía o un
  stream que falla responde `errorMessage`. Con `onCancel: 'discard'`, una
  respuesta cancelada tampoco entra en el contexto.
- Con `tools` configuradas los turnos **no** se transmiten (el bucle de tools
  responde en un solo mensaje).

En tus handlers, `streamReplyInChat()` aplica historial, memoria y RAG:

```ts
await ctx.stream(ctx.tools.ai.streamReplyInChat(chatKeyOf(ctx), ctx.body, { userId: ctx.sender, isGroup: ctx.isGroup }))
```

Parar el stream aborta la petición; la respuesta parcial se guarda salvo con
`keepPartial: false`. `timeoutMs` funciona como timeout de inactividad entre
fragmentos.

## Roadmap

No-objetivos de esta primera versión, ya contemplados en el diseño de
`AIProvider`/`ContextManager` para poder añadirlos después sin romper la API:

- **Auto-summarize / compaction** del historial (en vez de recortar por
  ventana fija de mensajes).
- Multi-persona por número.

## Más documentación

- [Guía en el sitio (EN)](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/guide/ai.md) ·
  [Guía en el sitio (ES)](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/es/guide/ai.md)
- [`@bot-wa/core`](https://github.com/andresayac/bot-wa-baileys/blob/main/packages/core/README.md) — el framework base (plugins,
  DI, conversaciones)
