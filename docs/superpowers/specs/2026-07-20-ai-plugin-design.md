# Spec — @bot-wa/ai (plugin de IA oficial)

- **Fecha:** 2026-07-20
- **Paquete nuevo:** `@bot-wa/ai` v0.1.0
- **Depende de:** `@bot-wa/bot-wa-baileys` v2 (core ya mergeado en main)
- **Estado:** borrador para revisión

## Decisiones tomadas con el usuario

- **Empaquetado:** monorepo pnpm. El core actual se mueve a `packages/core`; el plugin vive en `packages/ai`.
- **Proveedores v1:** los 3 desde el día uno — Anthropic, OpenAI, Ollama — tras una interfaz `AIProvider` común.
- **Modo principiante:** `bot.plug(aiPlugin())` responde SOLO a mensajes no-manejados (se engancha como catch-all; convive con `when()`/flows/comandos).
- **Contexto:** historial por chat en el `IStore` existente, ventana acotada; sobrevive reinicios si el store tiene archivo.

## 1. Problema / objetivo

El core v2 tiene sistema de plugins, hooks, DI (`bot.provide`) y conversaciones async, pero ninguna capacidad de IA. Objetivo: un plugin oficial que (a) para principiante convierta el bot en autoresponder con IA en 3 líneas, (b) para avanzado exponga la IA como herramienta (`ctx.tools.ai`) dentro de flows/conversations, (c) sea agnóstico de proveedor (Anthropic/OpenAI/Ollama), (d) gestione contexto conversacional por chat sin que el usuario lo cablee.

**No-objetivos v1 (roadmap):** function/tool calling (IA ejecutando acciones del bot), auto-summarize/compaction del historial, RAG/embeddings, multi-persona por número. La interfaz `AIProvider` y el `ContextManager` quedan diseñados para admitirlos después.

## 2. Reestructuración a monorepo (Fase 0)

Prerrequisito mecánico. El repo hoy es paquete único. Conversión:

```
bot-wa-baileys/
├─ package.json                 raíz privada (workspace root; scripts agregados)
├─ pnpm-workspace.yaml          packages: ['packages/*']
├─ tsconfig.base.json           config TS compartida (ESM/NodeNext/strict)
├─ vitest.workspace.ts          corre tests de todos los packages
├─ packages/
│  ├─ core/                     @bot-wa/bot-wa-baileys (contenido actual de src/, tests/, examples/, docs sitio)
│  │  ├─ src/ tests/ examples/ package.json tsconfig.json
│  └─ ai/                       @bot-wa/ai (nuevo)
```

Reglas de la conversión:
- Mover `src/`, `tests/`, `examples/`, `vitest.config.ts`, `tsconfig.json` a `packages/core/` **sin cambios de código** (los imports internos son relativos, no se rompen). Historia git: `git mv`.
- El sitio VitePress (`docs/`) y `docs/superpowers/` **quedan en la raíz** (docs del monorepo). `docs:*` scripts apuntan a `packages/core` para typedoc.
- `packages/core/package.json` conserva nombre `@bot-wa/bot-wa-baileys`, versión, exports (`.` y `./testing`), deps. Sin cambios de API pública.
- Raíz: `package.json` privado (`"private": true`) con scripts que delegan (`pnpm -r build`, `pnpm -r test`).
- `@bot-wa/ai` referencia al core vía `workspace:*`.
- **Criterio de no-regresión:** tras la conversión, `pnpm -r test` = los 101 tests del core verdes, `pnpm -r build` limpio, `@bot-wa/bot-wa-baileys` publicable idéntico a antes (mismo `files`/`exports`).

## 3. Arquitectura del paquete ai

```
packages/ai/src/
├─ index.ts            barrel: aiPlugin, createAI, MockAIProvider, tipos
├─ types.ts            AIMessage, GenerateInput, GenerateResult, AIProvider, AIConfig
├─ providers/
│  ├─ resolve.ts       resuelve config.provider → instancia (carga lazy del SDK)
│  ├─ anthropic.ts     AnthropicProvider
│  ├─ openai.ts        OpenAIProvider
│  └─ ollama.ts        OllamaProvider
├─ ContextManager.ts   historial por chat, ventana acotada, store-backed
├─ AIClient.ts         orquesta provider + contexto: ask/generate/stream
└─ plugin.ts           aiPlugin(config) → definePlugin
```

`package.json`:
- `dependencies`: `@bot-wa/bot-wa-baileys: workspace:*` (peer en publicación).
- `optionalDependencies` / `peerDependenciesMeta` (optional:true): `@anthropic-ai/sdk`, `openai`. Ollama sin SDK (fetch).
- ESM-only, Node ≥ 20, igual que el core.

## 4. Interfaz de proveedor

```ts
export interface AIMessage { role: 'user' | 'assistant'; content: string }

export interface GenerateInput {
  system?: string
  messages: AIMessage[]
  model?: string
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'  // solo Anthropic lo usa; otros lo ignoran
  signal?: AbortSignal
}

export interface GenerateResult {
  text: string
  model: string
  stopReason?: string
  usage?: { input: number; output: number }
}

export interface AIProvider {
  readonly name: string
  generate(input: GenerateInput): Promise<GenerateResult>
  stream(input: GenerateInput): AsyncIterable<string>   // deltas de texto
}
```

### 4.1 AnthropicProvider (`@anthropic-ai/sdk`)

- Construcción: `new Anthropic({ apiKey })` — `apiKey` de config o env `ANTHROPIC_API_KEY`.
- `generate`: `client.messages.create({ model, max_tokens, system, messages, thinking: { type: 'adaptive' }, output_config: { effort } })`. `max_tokens` default **1024** (respuestas de chat cortas; configurable).
- `stream`: `client.messages.stream({...})`, yield de `text_delta` (o `.on('text')`); `getFinalMessage()` para usage al final.
- **Refusal:** si `stop_reason === 'refusal'` → `generate` devuelve `{ text: '', stopReason: 'refusal' }`; el AIClient lo traduce al mensaje de fallback (no lanza).
- Modelo por defecto: `claude-opus-4-8`. Documentar `claude-sonnet-5` / `claude-haiku-4-5` como opciones más baratas para chat de alto volumen.
- Sin `temperature`/`top_p` (rechazados por los modelos actuales; se omiten).

### 4.2 OpenAIProvider (`openai`)

- `new OpenAI({ apiKey })` (env `OPENAI_API_KEY`). `chat.completions.create({ model, messages: [{role:'system',...}, ...], max_tokens, stream })`. Mapea `AIMessage` → formato OpenAI (system como primer mensaje).
- `model` requerido en config (sin default — evita apostar por un id que cambie).
- `effort` ignorado.

### 4.3 OllamaProvider (fetch, sin SDK)

- POST `${baseUrl}/api/chat` (default `http://localhost:11434`), body `{ model, messages, stream }`. Stream = NDJSON línea a línea (`message.content`).
- `model` requerido en config. Sin apiKey.

### 4.4 resolve.ts (carga lazy)

```ts
async function resolveProvider(cfg: AIConfig): Promise<AIProvider>
```
`await import('@anthropic-ai/sdk')` (etc.) dentro del branch del proveedor elegido. Si el módulo no existe → `Error('El proveedor "openai" requiere el paquete "openai". Instálalo: pnpm add openai')`.

## 5. ContextManager

- Clave por chat: el plugin la deriva del `ctx` con la **misma fórmula documentada** del core (scope participante por defecto): `ctx.isGroup ? `${ctx.from}:${ctx.sender}` : ctx.from`. Se implementa como helper local `chatKeyOf(ctx)` en el paquete ai (no requiere export nuevo del core). Si en el futuro el core expone `keyFor` públicamente, se sustituye.
- Almacenamiento en `IStore`. Se añaden métodos a `IStore` (aditivos, `MemoryStore` los implementa):
  ```ts
  getConversation(key: string): Promise<AIMessage[] | undefined>
  setConversation(key: string, messages: AIMessage[]): Promise<void>
  clearConversation(key: string): Promise<void>
  ```
  Serializados junto al resto del store (sobreviven reinicio con archivo).
- **Ventana acotada:** `maxMessages` (default 20). Al exceder, recorta los más viejos (pares user/assistant). El `system`/persona NO se guarda en el historial — se pasa aparte en cada `GenerateInput.system`.
- `append(key, msg)`: carga, push, recorta, guarda.
- Limpieza del contexto: `ContextManager.clear(chatKey)` es público. El plugin registra su propio `bot.command('reset', ...)` (opt-out con `resetCommand: false`) que hace **superset** del `/reset` del slash plugin: limpia el contexto IA **y** llama `bot.abortConversation(ctx)` (cancela también conversaciones activas). Como el registro de comandos es "último plug gana" (comportamiento documentado del core), la regla es: **plug `aiPlugin` después de `slashCommandsPlugin`** para que su `/reset` prevalezca. Se documenta en el README.

## 6. AIClient

```ts
class AIClient {
  constructor(provider: AIProvider, ctxMgr: ContextManager, cfg: ResolvedAIConfig)
  ask(prompt: string, opts?): Promise<string>                    // one-shot, SIN historial de chat
  generate(input: Partial<GenerateInput>): Promise<GenerateResult>
  stream(input: Partial<GenerateInput>): AsyncIterable<string>
  // usado por el plugin para la autorespuesta con contexto:
  replyInChat(chatKey: string, userText: string): AsyncIterable<string>  // carga ctx, stream, al terminar guarda user+assistant
}
```

`ask` es el atajo del modo avanzado (sin contexto de chat, sin persistir). `replyInChat` es lo que usa la autorespuesta: inyecta persona como `system`, historial del chat como `messages`, hace stream, y al completar persiste `user` + `assistant`.

## 7. plugin.ts — aiPlugin()

```ts
export interface AIConfig {
  provider?: 'anthropic' | 'openai' | 'ollama'   // default 'anthropic'
  model?: string
  apiKey?: string
  baseUrl?: string                                // ollama / openai-compat
  persona?: string                                // system prompt
  maxTokens?: number                              // default 1024
  effort?: 'low'|'medium'|'high'|'xhigh'|'max'
  context?: { maxMessages?: number }              // default 20
  autoReply?: boolean                             // default true (catch-all)
  errorMessage?: string                           // default '⚠️ Ahora no puedo responder, intenta luego.'
  refusalMessage?: string                         // default 'No puedo ayudar con eso.'
  humanizeTyping?: boolean                        // default true
}
export function aiPlugin(config?: AIConfig): Plugin
```

`install(pluginCtx, config)`:
1. Resuelve provider (lazy), crea `ContextManager(store)` y `AIClient`.
2. `bot.provide('ai', aiClient)` → disponible como `ctx.tools.ai` en handlers/flows/conversations.
3. Si `autoReply !== false`: registra `bot.onMessage(async (ctx) => { ... })` (catch-all — corre solo si nada consumió el mensaje):
   - Solo tipo `text` (ignora media en v1; documentado).
   - `humanizeTyping` → `ctx.typing()` durante la generación.
   - `for await (delta of aiClient.replyInChat(keyOf(ctx), ctx.body))` acumula; al terminar `ctx.reply(fullText)`. (v1 envía una sola vez al final; streaming interno para no bloquear/typing. Streaming parcial a WhatsApp = roadmap.)
   - Errores del provider → `logger.warn` + `ctx.reply(errorMessage)`. Refusal → `ctx.reply(refusalMessage)`.
4. Si `resetCommand !== false`: registra `bot.command('reset', ...)` que limpia el contexto IA del chat + `bot.abortConversation(ctx)` (ver §5 — plug después del slash plugin para que prevalezca).
5. `onDispose`: quita el catch-all y listeners (el core ya soporta unplug).

## 8. Testing

- **MockAIProvider** (exportado): implementa `AIProvider`, respuestas fijas/scriptables, cero red. Para tests de usuarios y del propio plugin.
- Suite vitest en `packages/ai/tests/`:
  - ContextManager: append/recorte por ventana, persistencia round-trip contra MemoryStore, aislamiento por chat-key (grupos por-participante).
  - AIClient: `ask` no toca historial; `replyInChat` persiste user+assistant; refusal → texto de fallback.
  - plugin: con `createTestBot` + MockAIProvider — autorespuesta solo a lo no-manejado (no pisa un `when()`), `ctx.tools.ai.ask` dentro de una conversación, `/reset` limpia contexto, `autoReply:false` no engancha catch-all, unplug quita todo.
  - resolve: proveedor sin SDK instalado → error accionable (mock del import fallido).
- Smoke real (opcional, gated por `AI_SMOKE=1` + api key): una llamada por proveedor. No en CI.
- Cero `console.*`; cero `any` en API pública; ESM `.js` imports.

## 9. Docs

- README de `packages/ai` con quickstart (principiante + avanzado + los 3 proveedores).
- Página en el sitio VitePress (`docs/guide/ai.md` + `es`) y entrada en `llms.txt`.
- Nota de instalación: `pnpm add @bot-wa/ai @anthropic-ai/sdk` (SDK del proveedor elegido).

## 10. Criterios de éxito

1. `pnpm -r test` verde (core 101 + nuevos de ai); `pnpm -r build` limpio; core sigue publicable idéntico.
2. Principiante: `bot.plug(aiPlugin({ persona }))` responde a un mensaje no-manejado con MockAIProvider en un test, y NO responde a uno que un `when()` consumió.
3. Avanzado: `ctx.tools.ai.ask(...)` devuelve texto dentro de una conversación.
4. Contexto: segundo mensaje del mismo chat incluye el primero en `messages`; `/reset` lo borra; sobrevive reinicio con store de archivo.
5. Los 3 proveedores implementan `AIProvider`; falta de SDK → error accionable, no crash.
6. Refusal/rate-limit del proveedor → el bot responde el mensaje de fallback, no crashea.

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| Conversión a monorepo rompe el build/publish del core | Fase 0 aislada con criterio de no-regresión (101 tests + build + exports idénticos) antes de tocar ai |
| IDs de modelo OpenAI/Ollama cambian | Sin default para esos dos — `model` requerido en config; solo Anthropic trae default |
| Deps LLM pesan / no todos las quieren | optionalDependencies + carga lazy; instalas solo tu proveedor |
| Costo de autorespuesta con Opus en alto volumen | Documentar Sonnet 5 / Haiku 4.5; `maxTokens` bajo por defecto (1024) |
| Streaming parcial a WhatsApp deseado | v1 envía al final (con typing); streaming incremental = roadmap explícito |
