# Plugin de IA

`@bot-wa/ai` es un **paquete separado** que añade un autoresponder de IA
multi-proveedor (Anthropic / OpenAI / Ollama), más un cliente `ctx.tools.ai`
que puedes usar desde tus propios handlers, flows y conversaciones.

::: tip Paquete separado
A diferencia de `slashCommandsPlugin` (incluido en el core), `@bot-wa/ai` se
distribuye como un paquete propio para que el core se mantenga libre de
dependencias de IA.
:::

## Instalación

```bash
pnpm add @bot-wa/ai @anthropic-ai/sdk
```

El segundo paquete es el SDK del proveedor que vayas a usar:

| Proveedor | SDK a instalar |
|---|---|
| `anthropic` (default) | `@anthropic-ai/sdk` |
| `openai` | `openai` |
| `ollama` | ninguno — habla HTTP directo (`fetch`) contra un servidor Ollama local o remoto |

## Quickstart (autoresponder)

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'
import { aiPlugin } from '@bot-wa/ai'

const bot = new Bot({ session: 'mi-bot' })

bot.plug(aiPlugin({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  persona: 'Eres un asistente de soporte, responde breve y en español.',
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

bot.conversation('resumen', async (c, ctx) => {
  await ctx.reply('📋 Pega el texto a resumir:')
  const texto = await c.waitText()
  const resumen = await ctx.tools.ai.ask(`Resume en 3 líneas: ${texto}`)
  await ctx.reply(resumen)
})
```

`ctx.tools.ai` (un `AIClient`) expone:

- `ask(prompt: string): Promise<string>` — una pregunta suelta, **sin**
  historial de chat (no lee ni escribe el contexto guardado). Usa la
  `persona`/`model`/`maxTokens`/`effort` configurados en `aiPlugin`.
- `generate(input: { messages, system?, model?, maxTokens?, effort?, signal? }): Promise<GenerateResult>` —
  control total: mensajes explícitos y overrides puntuales.
- `stream(input): AsyncIterable<string>` — igual que `generate` pero entrega
  el texto en fragmentos (`for await (const delta of ...)`).

## Los 3 proveedores

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

::: warning `model` es obligatorio en openai y ollama
Ninguno de los dos trae un default razonable (hay demasiados modelos válidos
y cambian seguido) — si lo omites, el provider lanza un error explícito en
el primer `generate`/`stream`. `anthropic` sí trae default
(`claude-opus-4-8`).
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
| `provider` | `'anthropic' \| 'openai' \| 'ollama'` | `'anthropic'` | proveedor a resolver |
| `model` | `string` | según proveedor | modelo a usar (obligatorio en openai/ollama) |
| `apiKey` | `string` | — | API key (anthropic/openai; si se omite, el SDK del proveedor intenta leerla del entorno) |
| `baseUrl` | `string` | — | override de endpoint (`baseURL` de openai / host de ollama) |
| `persona` | `string` | — | system prompt |
| `maxTokens` | `number` | `4096` (anthropic) / `1024` (openai) | límite de tokens de salida (anthropic/openai; ollama lo ignora hoy) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | esfuerzo de razonamiento (solo Anthropic) |
| `context.maxMessages` | `number` | `20` | ventana de historial guardada por chat |
| `autoReply` | `boolean` | `true` | registra el autoresponder catch-all |
| `resetCommand` | `boolean` | `true` | registra `/reset` |
| `errorMessage` | `string` | `'⚠️ Ahora no puedo responder, intenta luego.'` | respuesta si el proveedor falla |
| `refusalMessage` | `string` | `'No puedo ayudar con eso.'` | respuesta cuando el proveedor rehúsa (`stopReason === 'refusal'`) |
| `humanizeTyping` | `boolean` | `true` | envía "escribiendo…" (`ctx.typing()`) antes de responder |

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

## Roadmap

No-objetivos de esta primera versión, ya contemplados en el diseño de
`AIProvider`/`ContextManager` para poder añadirlos después sin romper la API:

- **Function/tool calling** — que la IA pueda ejecutar acciones del bot.
- **Auto-summarize / compaction** del historial (en vez de recortar por
  ventana fija de mensajes).
- RAG / embeddings.
- Multi-persona por número.

## Siguientes pasos

- [Plugins](./plugins) — cómo funcionan `bot.plug()`/`definePlugin` en general
- [Inyección de dependencias](./di) — cómo se conecta `ctx.tools`
