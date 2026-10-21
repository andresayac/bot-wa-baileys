# Plugin de IA

`@bot-wa/ai` es un **paquete separado** que añade un autoresponder de IA
multi-proveedor (Anthropic / OpenAI / Ollama / Gemini más nueve presets
compatibles con OpenAI), y un cliente `ctx.tools.ai` que puedes usar desde
tus propios handlers, flows y conversaciones.

::: tip Paquete separado
A diferencia de `slashCommandsPlugin` (incluido en el core), `@bot-wa/ai` se
distribuye como un paquete propio para que el core se mantenga libre de
dependencias de IA.
:::

## Política de IA de WhatsApp (desde el 15-01-2026)

::: warning Los asistentes de IA de propósito general no están permitidos en la WhatsApp Business Platform
Desde el **15 de enero de 2026**, los términos de Meta para la WhatsApp
Business Platform (sección *AI Providers*) **prohíben los asistentes de IA de
propósito general**: chatbots abiertos estilo ChatGPT cuya funcionalidad
principal es la propia IA. Sigue estando **permitido** usar IA **al servicio
del negocio** (atención al cliente, ventas, reservas, seguimiento de pedidos).
:::

Qué significa para `aiPlugin`:

- Escribe una `persona` **acotada a tu negocio** (qué vendes, horarios,
  políticas) que rechace con amabilidad lo que no tenga que ver con él — mira
  el [quickstart](#quickstart-autoresponder) de abajo.
- Ofrece una salida hacia una persona y no presentes el bot como un asistente
  "para todo".
- La regla viene de los términos de la Cloud API oficial (`@bot-wa/meta`).
  Baileys es un cliente no oficial de WhatsApp Web y también está sujeto a los
  términos de WhatsApp.

Es una guía práctica, no asesoría legal: revisa los
[términos vigentes](https://www.whatsapp.com/legal/business-solution-terms)
antes de salir a producción.

## Instalación

::: warning Alpha — primera publicación en npm pendiente
`@bot-wa/ai` forma parte de la primera alpha, que **todavía no está en npm**.
Hasta que se publique, úsalo desde el monorepo (`workspace:*`); los comandos
de abajo son los que funcionarán cuando se publique.
:::

```bash
pnpm add @bot-wa/ai@alpha @anthropic-ai/sdk
```

El segundo paquete es el SDK del proveedor que vayas a usar:

| Proveedor | SDK a instalar |
|---|---|
| `anthropic` (default) | `@anthropic-ai/sdk` |
| `openai` | `openai` |
| `gemini` | `@google/generative-ai` |
| `ollama` | ninguno — habla HTTP directo (`fetch`) contra un servidor Ollama local o remoto |
| `deepseek`, `qwen`, `glm`, `kimi`, `groq`, `openrouter`, `mistral`, `grok`, `together` | `openai` — son presets OpenAI-compatibles que se alcanzan vía el SDK `openai` con un `baseURL` propio |

## Quickstart (autoresponder)

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

Esto registra:
- Un autoresponder catch-all (`bot.onMessage`) que contesta cualquier mensaje
  de **texto** que ningún otro handler/comando/conversación haya consumido,
  manteniendo un historial por chat (ventana acotada, 20 mensajes por
  defecto — ver `context.maxMessages`).
- Un comando `/reset` que limpia el contexto de IA del chat y cancela la
  conversación activa (opt-out con `resetCommand: false`).

## Modo avanzado: `ctx.tools.ai`

El plugin también hace `bot.provide('ai', client)`, así que `ctx.tools.ai`
está disponible en cualquier `when()`, flow o conversación. Desactiva el
autoresponder (`autoReply: false`) si solo quieres esto:

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

`ctx.tools.ai` (un `AIClient`) expone:

- `ask(prompt, opts?): Promise<string>` — una pregunta suelta, **sin**
  historial de chat (no lee ni escribe el contexto guardado). Usa la
  `persona`/`model`/`maxTokens`/`effort` configurados en `aiPlugin` (y las
  [herramientas](/es/guide/ai-herramientas), si las hay).
- `replyInChat(chatKey, text, opts?): Promise<string>` — responde dentro del
  historial de un chat (lo lee y guarda el turno), igual que el
  autoresponder. `opts` acepta `{ userId, isGroup }` para la
  [memoria](/es/guide/ai-memoria-rag) y `{ ctx, confirm, signal }` para las
  herramientas; usa `chatKeyOf(ctx)` como clave. `replyInChatDetailed()`
  devuelve además las citas y los hechos del turno.
- `streamReplyInChat(chatKey, text, opts?)` — el gemelo en streaming de
  `replyInChat`, para pasárselo a [`ctx.stream()`](/es/guide/streaming).
- `runTools(input, opts?)` — ejecuta el
  [bucle de herramientas](/es/guide/ai-herramientas) y devuelve su resultado
  completo.
- `memory()`, `memoryFacts()`, `remember()`, `forget()`, `extractMemory()` —
  la API de [memoria a largo plazo](/es/guide/ai-memoria-rag); `idle()` espera
  a la extracción en segundo plano.
- `generate(input: { messages, system?, model?, maxTokens?, effort?, signal? }): Promise<GenerateResult>` —
  control total: mensajes explícitos y overrides puntuales.
- `stream(input): AsyncIterable<string>` — igual que `generate` pero entrega
  el texto en fragmentos (`for await (const delta of ...)`).

**Tipado (TypeScript).** Importar `@bot-wa/ai` amplía la interfaz
`DefaultTools` del core, así que `ctx.tools.ai` ya es un `AIClient` en los
handlers de `when()`, `onMessage()` y `command()` (y en
`bot.injectTools.ai`), sin casts. El tipo no comprueba que el plugin esté
instalado: sin `bot.plug(aiPlugin(...))` (o después de `unplug()`),
`ctx.tools.ai` es `undefined` en tiempo de ejecución.

## Los proveedores

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

### Gemini

Requiere `@google/generative-ai` (peer opcional, carga lazy). Nota: Google
publicó después un SDK nuevo (`@google/genai`); este provider sigue usando
`@google/generative-ai` — la migración se sigue por separado.

```ts
bot.plug(aiPlugin({
  provider: 'gemini',
  apiKey: process.env.GEMINI_API_KEY,  // o GOOGLE_API_KEY en el entorno
  // model: 'gemini-2.0-flash',        // default si se omite
}))
```

### Ollama (local, sin API key)

```ts
bot.plug(aiPlugin({
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',   // default si se omite
  model: 'llama3.1',                   // OBLIGATORIO: OllamaProvider no trae modelo por defecto
}))
```

### Presets — DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter, Mistral, Grok, Together

Cada preset es un endpoint compatible con OpenAI que se alcanza vía el SDK
`openai` con un `baseURL` propio — cero dependencias extra más allá de
`openai`, y cada uno trae un modelo por defecto y su variable de entorno
convencional para la API key:

```ts
bot.plug(aiPlugin({ provider: 'deepseek' }))  // lee DEEPSEEK_API_KEY, modelo deepseek-chat
```

| Preset | Variable de entorno | Modelo por defecto |
|---|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `qwen` | `DASHSCOPE_API_KEY` | `qwen-plus` |
| `glm` | `ZHIPUAI_API_KEY` | `glm-4-plus` |
| `kimi` | `MOONSHOT_API_KEY` | `moonshot-v1-8k` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/auto` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small-latest` |
| `grok` | `XAI_API_KEY` | `grok-2-latest` |
| `together` | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |

`apiKey` y `model` sobreescriben los defaults:

```ts
bot.plug(aiPlugin({
  provider: 'groq',
  apiKey: process.env.GROQ_API_KEY,
  model: 'llama-3.3-70b-versatile',
}))
```

::: warning `model` es obligatorio en openai y ollama
Ninguno de los dos trae un default razonable (hay demasiados modelos válidos
y cambian seguido) — si lo omites, el provider lanza un error explícito en
el primer `generate`/`stream`. `anthropic` (`claude-opus-4-8`), `gemini` y
los presets sí traen default.
:::

Si el proveedor está mal configurado (SDK sin instalar, proveedor
desconocido, API key ausente), `aiPlugin` **no revienta el proceso**: `install`
es síncrono y resuelve el proveedor de forma perezosa. Al arrancar se hace un
"warmup" que registra el problema en el log de errores (con la pista de qué
`pnpm add` correr cuando falta un SDK), y a partir de ahí cada mensaje responde
el `errorMessage` configurado en vez de tumbar el bot.

## Config completa de `aiPlugin(config)`

| Campo | Tipo | Default | Descripción |
|---|---|---|---|
| `provider` | `'anthropic' \| 'openai' \| 'ollama' \| 'gemini' \| 'deepseek' \| 'qwen' \| 'glm' \| 'kimi' \| 'groq' \| 'openrouter' \| 'mistral' \| 'grok' \| 'together'` | `'anthropic'` | proveedor a resolver |
| `model` | `string` | según proveedor | modelo a usar (obligatorio en openai/ollama) |
| `apiKey` | `string` | fallback a env var | API key (si se omite, cada proveedor intenta su variable de entorno convencional) |
| `baseUrl` | `string` | según preset | override de endpoint (`baseURL` de openai/anthropic / host de ollama) |
| `persona` | `string` | — | system prompt |
| `maxTokens` | `number` | `4096` (anthropic) / `1024` (openai, presets, gemini) | límite de tokens de salida (en ollama solo si lo fijas, como `options.num_predict`; el tope de 1024 de la extracción de memoria no se aplica ahí). En modelos de razonamiento incluye los tokens de pensamiento |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | esfuerzo de razonamiento (solo Anthropic; no se envía a modelos que lo rechazan, como Claude Haiku 4.5 / Sonnet 4.5) |
| `thinking` | `'auto' \| 'adaptive' \| 'off' \| { budgetTokens }` | `'auto'` | pensamiento extendido de Anthropic, ver [Pensamiento (Anthropic)](#pensamiento-anthropic) |
| `timeoutMs` | `number` | `60000` | timeout por llamada no-streaming; al vencer aborta la petición y rechaza, para que un proveedor colgado no bloquee la cola del chat (`0` lo desactiva, no recomendado) |
| `context.maxMessages` | `number` | `20` | ventana de historial guardada por chat (siempre empieza por un turno del usuario; las respuestas vacías no se guardan) |
| `autoReply` | `boolean` | `true` | registra el autoresponder catch-all |
| `resetCommand` | `boolean` | `true` | registra `/reset` |
| `errorMessage` | `string` | `'⚠️ Ahora no puedo responder, intenta luego.'` | respuesta si el proveedor falla o el modelo responde vacío |
| `refusalMessage` | `string` | `'No puedo ayudar con eso.'` | respuesta cuando el proveedor rehúsa (`stopReason === 'refusal'`: rechazo de Anthropic, `refusal` de OpenAI, bloqueo de seguridad de Gemini) |
| `humanizeTyping` | `boolean` | `true` | envía "escribiendo…" (`ctx.typing()`) mientras se genera la respuesta; la respuesta se salta entonces el `BotConfig.typing`, así que el indicador sale una sola vez |
| `tools` | `Record<string, AITool>` | — | funciones que el modelo puede llamar (ver [Herramientas](#herramientas)) |
| `maxSteps` | `number` | `5` | máximo de llamadas al modelo por turno en el bucle de herramientas |
| `toolTimeoutMs` | `number` | `15000` | timeout por defecto de cada herramienta (`0` lo desactiva) |
| `maxStepsMessage` | `string` | mensaje localizado `ai.tools.maxSteps` (es: `'No pude completar la solicitud. Intenta de nuevo con más detalle.'`) | respuesta cuando el bucle llega a `maxSteps` |
| `toolConfirm` | `{ yes?: string[]; no?: string[]; timeout?: number \| string; systemNote?: boolean \| string }` | `{ timeout: '2m' }` | diálogo de confirmación de las herramientas `confirm: true` (ver [Confirmación humana](/es/guide/ai-herramientas#confirmacion-humana)) |
| `format` | `'auto' \| 'whatsapp' \| 'markdown' \| 'html' \| 'plain' \| false` | `'auto'` | convierte el Markdown del modelo al formato del canal (ver [Formato por canal](#formato-por-canal)) |
| `onToolEvent` | `(event: AIToolEvent) => void` | — | auditoría de cada evento del bucle (también se emite como `bot.on('ai.tool')`) |
| `memory` | `boolean \| AIMemoryConfig` | — | memoria a largo plazo por usuario (ver [Memoria y RAG](#memoria-y-rag)) |
| `rag` | `AIRetriever \| AIRagConfig` | — | respuestas basadas en tus documentos (ver [Memoria y RAG](#memoria-y-rag)) |
| `stream` | `boolean \| AIStreamConfig` | apagado | transmite el autoresponder con `ctx.stream()` (ver [Streaming](#streaming)) |

## Pensamiento (Anthropic)

Los modelos Claude piensan antes de responder. `@bot-wa/ai` elige la petición
adecuada para el modelo que configures (`thinking: 'auto'`, el valor por defecto):

| Modelo | Qué se envía |
|---|---|
| Claude Opus / Sonnet 4.6 o posteriores, Haiku 5 o posteriores, Fable, Mythos, ids desconocidos | `thinking: { type: 'adaptive' }` (+ `effort` si lo fijas) |
| Claude Haiku 4.5, Sonnet 4.5, Opus 4.5 y anteriores | sin `thinking` (y sin `effort`, salvo en Opus 4.5) |

```ts
aiPlugin({ provider: 'anthropic', model: 'claude-haiku-4-5', thinking: { budgetTokens: 2048 } })
```

- `'adaptive'` envía siempre pensamiento adaptativo; `'off'` no envía nunca el
  parámetro (los modelos que siempre piensan, como Claude Opus 5.5, lo siguen
  haciendo: baja `effort` en su lugar).
- `{ budgetTokens }` (un entero positivo; cualquier otro valor lanza un
  `RangeError` al construir la configuración) activa el pensamiento con
  presupuesto (`budget_tokens`, elevado al mínimo de 1024) en los modelos sin
  pensamiento adaptativo (Haiku 4.5, Sonnet 4.5, Opus 4.5 y anteriores). Los
  modelos adaptativos reciben pensamiento adaptativo: Opus / Sonnet 4.6 aún
  aceptan presupuestos pero los marcan como obsoletos, y Opus 4.7+, Sonnet 5+,
  Haiku 5+, Fable y Mythos los rechazan. Si `maxTokens` no deja sitio para la
  respuesta, pasa a ser `budgetTokens + maxTokens`.
- Si aun así la API rechaza la petición con un 400 que menciona `thinking` (o
  `effort`), la llamada se reintenta una vez sin ese parámetro y el modelo
  queda recordado, así que las siguientes llamadas ya no lo envían.
  `anthropicModelSupport(model)` expone las reglas.

## Herramientas

Con `tools`, el modelo puede llamar a funciones de tu bot mediante el *tool /
function calling* nativo (Anthropic, OpenAI y los presets compatibles,
Gemini, Ollama), en un bucle de varios pasos con timeout por herramienta,
errores devueltos al modelo, confirmación humana para las herramientas
`confirm: true` y eventos de auditoría:

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  tools: {
    buscar_producto: {
      description: 'Busca productos del catálogo por texto',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      handler: async ({ q }: { q: string }) => db.products.search(q),
    },
  },
}))
```

Guía completa: [Herramientas de IA](/es/guide/ai-herramientas).

## Memoria y RAG

`memory` recuerda hechos de cada usuario entre conversaciones (se guardan en
`ctx.user`, se inyectan en el autoresponder y, opcionalmente, el modelo los
extrae en segundo plano). `rag` responde a partir de tus documentos con citas
numeradas, usando cualquier retriever, como `createRag()` del paquete
experimental `@bot-wa/rag`.

```ts
bot.plug(aiPlugin({
  provider: 'openai',
  model: 'gpt-5-mini',
  memory: { autoExtract: true, ttl: '90d' },
  rag: { retriever: createRag({ documents: ['./docs/faq.md'] }), appendSources: true },
}))
```

Guía completa: [Memoria y RAG](/es/guide/ai-memoria-rag).

## Streaming

`stream: true` envía la respuesta del autoresponder mientras se genera:
borradores nativos en Telegram, ediciones en vivo en Discord y trozos por
frases con "escribiendo…" en WhatsApp. Los turnos con herramientas no se
transmiten. Guía completa:
[Respuestas en streaming](/es/guide/streaming#con-bot-wa-ai).

## Formato por canal

Los modelos escriben Markdown (`**negrita**`, `# título`, `[enlace](url)`,
`- elemento`), pero la mayoría de las apps de chat no lo muestran. El
autoresponder convierte cada respuesta (también en streaming) al formato del
chat, `ctx.textFormat`: el `textFormatFor(chatId)` del provider cuando sirve
varios canales y, si no, su `capabilities.textFormat`:

| `textFormat` | Providers | Resultado |
|---|---|---|
| `'whatsapp'` | `baileys`, `meta`, evolution, wppconnect, gupshup; chats `whatsapp:` de twilio; contactos de WhatsApp en highlevel | `*negrita*`, `_cursiva_`, `~tachado~`, viñetas `•`, títulos en negrita, enlaces como `texto (url)` |
| `'plain'` | `telegram` (se envía sin `parse_mode`), messenger, instagram, tiktok; chats SMS de twilio; contactos de SMS, Email, FB, IG, Live chat y GMB en highlevel | sin marcas |
| `'markdown'` | discord | sin cambios |
| sin declarar | el resto (email) | sin cambios |

Nunca se tocan los bloques ni los spans de código, ni las palabras con
`snake_case` o un `2 * 3`. El historial guarda el texto original del modelo.
`format: 'whatsapp'` (o cualquier formato) fija uno; `format: false` envía el
texto tal cual. `formatMarkdown(text, format)` y
`formatMarkdownStream(source, format)` se exportan para tus propios handlers.

## Notas de voz

El autoresponder solo contesta mensajes de texto. Con el plugin experimental
[`@bot-wa/voice`](/es/guide/voz), las notas de voz se transcriben antes de
enrutarse (usa `autoTranscribe: { asText: true }` para que la IA las
conteste) y `autoReplyWithVoice` puede devolver la respuesta como audio.

## `/reset` y `slashCommandsPlugin`

`aiPlugin` registra su propio `/reset`: limpia el contexto de IA del chat
**y** cancela la conversación activa. El registro de comandos es "último
`plug()` gana" (comportamiento documentado del core), así que si también usas
`slashCommandsPlugin` (que trae su propio `/reset` para cancelar
conversaciones), **instala `aiPlugin` después** para que su `/reset`
prevalezca:

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

const client = new AIClient(new MockAIProvider({ reply: 'respuesta simulada' }), new ContextManager(store))

const respuesta = await client.ask('¿qué hora es?')
// respuesta === 'respuesta simulada'
```

`reply` también puede ser una función de la petición que devuelva
`{ toolCalls }` para simular llamadas a herramientas (ver
[Testing en la guía de herramientas](/es/guide/ai-herramientas#testing)), y
`mock.calls` registra cada petición que envió el cliente.

## Roadmap

No-objetivos de esta primera versión, ya contemplados en el diseño de
`AIProvider`/`ContextManager` para poder añadirlos después sin romper la API:

- **Auto-summarize / compaction** del historial (en vez de recortar por
  ventana fija de mensajes).
- Multi-persona por número.

## Siguientes pasos

- [Herramientas de IA](/es/guide/ai-herramientas) — deja que el modelo llame a funciones de tu bot
- [Memoria y RAG](/es/guide/ai-memoria-rag) — hechos por usuario y respuestas con tus documentos
- [Respuestas en streaming](/es/guide/streaming) — `ctx.stream()` por canal
- [Voz](/es/guide/voz) — transcribe notas de voz y responde con audio
- [Plugins](./plugins) — cómo funcionan `bot.plug()`/`definePlugin` en general
- [Inyección de dependencias](./di) — cómo se conecta `ctx.tools`
