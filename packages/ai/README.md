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

- `ask(prompt: string): Promise<string>` — pregunta suelta, **sin** historial
  de chat (no lee ni escribe el contexto guardado). Usa la `persona`/`model`/
  `maxTokens`/`effort` configurados en `aiPlugin`.
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
| `baseUrl` | `string` | endpoint del preset | override de endpoint (`baseURL` de openai/presets / host de ollama) |
| `persona` | `string` | — | system prompt |
| `maxTokens` | `number` | `4096` (anthropic) / `1024` (openai) | límite de tokens de salida (anthropic/openai; ollama lo ignora hoy) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | esfuerzo de razonamiento (solo lo usa Anthropic) |
| `timeoutMs` | `number` | `60000` | timeout por llamada no-streaming; al vencer aborta la petición y rechaza, para que un proveedor colgado no bloquee la cola del chat (`0` lo desactiva, no recomendado) |
| `context.maxMessages` | `number` | `20` | ventana de historial guardada por chat |
| `autoReply` | `boolean` | `true` | registra el autoresponder catch-all |
| `resetCommand` | `boolean` | `true` | registra `/reset` |
| `errorMessage` | `string` | `'⚠️ Ahora no puedo responder, intenta luego.'` | respuesta si el proveedor falla |
| `refusalMessage` | `string` | `'No puedo ayudar con eso.'` | respuesta cuando el proveedor rehúsa (`stopReason === 'refusal'`) |
| `humanizeTyping` | `boolean` | `true` | envía "escribiendo…" (`ctx.typing()`) antes de responder |

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

## Roadmap

No-objetivos de esta primera versión, ya contemplados en el diseño de
`AIProvider`/`ContextManager` para poder añadirlos después sin romper la API:

- **Function/tool calling** — que la IA pueda ejecutar acciones del bot.
- **Auto-summarize / compaction** del historial (en vez de recortar por
  ventana fija de mensajes).
- RAG / embeddings.
- Multi-persona por número.

## Más documentación

- [Guía en el sitio (EN)](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/guide/ai.md) ·
  [Guía en el sitio (ES)](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/es/guide/ai.md)
- [`@bot-wa/core`](../core/README.md) — el framework base (plugins,
  DI, conversaciones)
