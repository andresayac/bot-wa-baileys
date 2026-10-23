# @bot-wa/ai

## 0.2.0-alpha.0

### Minor Changes

- a398e1f: Tool confirmations use native Yes/No buttons on channels that render them (`capabilities.buttons`: Telegram inline keyboards, WhatsApp Cloud API reply buttons, Discord, Messenger, Instagram). The button text is the summary without the "(yes/no)" hint (new `ai.tools.confirmButtons` key; a `bot.locale()` override of `ai.tools.confirm` is reused when it is the only one translated) and the labels are localized (`ai.tools.button.yes` / `ai.tools.button.no`: "Sí"/"No", "Yes"/"No"). A press resolves the confirmation exactly like typing yes/no (typed answers keep working), the interaction is acknowledged, and the buttons are removed by editing the message where the provider can edit. A press on a stale confirmation (answered, superseded, timed out, `/reset`) is acknowledged and ignored. Channels without buttons (Baileys, Twilio, SMS…) keep the typed question. New `toolConfirm.buttons` option (`false` always asks for a typed answer), `ToolConfirmRequest.buttonsPrompt` and an optional `{ buttons }` argument of `defaultConfirmPrompt()`.
- 39a8149: `confirmWith(c)` (confirmations inside your own conversation) asks with the same native Yes/No buttons as the autoreply when the channel renders them: typed answers keep working, the press is acknowledged and the buttons are edited away where the provider edits. It sends them to the chat of the `ctx` given to `replyInChat` (new `ToolConfirmRequest.ctx`) or of its new `ctx` option; `buttons: false` keeps the typed question. A press on a confirmation that is no longer pending is now acknowledged and dropped in a `before(message)` hook (also with `autoReply: false`), so it never answers a later question of a conversation. On channels that cannot edit messages (WhatsApp Cloud API, Messenger, Instagram) such a press gets a short localized reply (`ai.tools.confirmExpired`, on by default, `toolConfirm.expiredNotice: false` turns it off; never in a chat handed off to a human); `toolConfirm.answeredNotice` / `confirmWith({ answeredNotice })` (off by default) also acknowledge the pressed answer there (`ai.tools.confirmAnswered`).
  
  Built-in texts for a language without its own catalog (anything but `es` and `en`) now use the bot default locale (`ctx.defaultLang`) when it is `es` or `en`, else English, instead of always Spanish. Without a context they stay in Spanish.
- 522bcca: Type `ctx.tools.ai` as `AIClient` through the core `DefaultTools` augmentation, so it needs no cast in handlers or `bot.conversation()`.
- 003be68: The built-in user-facing texts are localizable: the `confirm: true` tool prompt, the `maxSteps` reply and the `rag.appendSources: true` line now come from the `ai.*` catalog (`AI_MESSAGES`, `AI_LOCALES` with `es` and `en`) resolved through `ctx.t`, so they follow `ctx.lang` and can be overridden with `bot.locale('en', { ai: { tools: { confirm: '…' } } })`. Without i18n (or without a message context) the Spanish texts are unchanged. `defaultConfirmPrompt()` and `formatSources()` take an optional context, `streamReplyInChat()` accepts `ctx`, and the `toolConfirm.yes` doc now lists the real `DEFAULT_YES` words.
- 5703d57: Long-term per-user memory and RAG hooks. `aiPlugin({ memory })` stores facts about each user in `ctx.user` (namespace `ai.memory`), injects them into the autoreply and, with `autoExtract`, extracts new facts in the background as strict JSON (`{"facts": string[]}`), with `maxFacts` and per-fact `ttl`; `bot.deleteSubject()` erases them. New `ctx.tools.ai.memory(userId)`, `memoryFacts()`, `remember()`, `forget()`, `extractMemory()` and `idle()`. `aiPlugin({ rag })` accepts any `AIRetriever` (such as `createRag()` from `@bot-wa/rag`) and injects the retrieved passages with numbered citations; `appendSources` adds a "Fuentes:" line, and retrieval is bounded by `rag.timeoutMs` (default 10 s). Facts are not injected into group replies unless `memory.injectInGroups` is on, and facts extracted in the background are dropped when the user's data is erased meanwhile. New `replyInChatDetailed()` returns the citations and facts of the turn, and `replyInChat()` accepts `{ userId, isGroup }`.
- 687a8ca: Model-aware Anthropic thinking, safer tool loop, roomier memory extraction and stable source numbers:
  
  - New `thinking` option (`'auto' | 'adaptive' | 'off' | { budgetTokens }`, default `'auto'`). The Anthropic provider used to always send `thinking: { type: 'adaptive' }`, which models before 4.6 (e.g. `claude-haiku-4-5`) reject with a 400. `'auto'` now sends it only to models that support it (Opus/Sonnet 4.6+, Haiku 5+, Fable, Mythos and unknown ids), and `effort` only to models that accept it. `{ budgetTokens }` enables budgeted thinking on older models. A 400 whose message names `thinking`/`effort` is retried once without that parameter, and the model is remembered. New `anthropicModelSupport(model)` helper.
  - The tool loop never runs tool calls cut off by the output-token cap (`stopReason` `max_tokens` / `length` / `MAX_TOKENS`): their arguments may be incomplete. The model gets an error result explaining it, a `tool.truncated` event is emitted, the plugin logs a warning and `ToolLoopResult.truncatedToolCalls` counts them.
  - `memory.autoExtract.maxTokens` defaults to 1024 instead of 300 (still a soft cap that Ollama ignores), so reasoning models no longer spend the whole budget thinking.
  - `rag.appendSources` keeps the original `[n]` of the cited passages (`Fuentes: [2] b.md`); uncited replies still list every source unnumbered. A custom `appendSources` function receives a second `cited` argument (`{ n, chunk }[]`); new `citedPassages()` helper. Visible change: the default sources line now carries the numbers.
- 2e16743: `@bot-wa/ai`: native tool / function calling. `aiPlugin({ tools })` maps each tool (description, JSON Schema or `safeParse` schema, handler, `confirm`) to Anthropic, OpenAI (and OpenAI-compatible presets), Gemini and Ollama, with a multi-step loop (`maxSteps`), per-tool timeouts, errors returned to the model, human confirmation for `confirm: true` tools through the conversation runtime (no FIFO deadlock) and audit events (`onToolEvent`, `bot.on('ai.tool')`). New exports: `defineTool`, `confirmWith`, `runToolLoop`, `AIToolCancelledError` and the tool types; `MockAIProvider` can script tool calls.
  
  `@bot-wa/core`: `bot.enterConversation(nameOrHandler, ctx)` enters a conversation programmatically, fire-and-forget, so a handler can start one and release the chat queue; it returns a promise that settles (never rejects) once the conversation has ended.
- 96d2a8e: Tool confirmations that read like a person wrote them, and fewer duplicated side effects:
  
  - The default confirmation prompt shows the tool `title` (new optional field; default: the humanized name, `crear_pedido` → `Crear pedido`) and the arguments as short lines (`• 5 × torta_chocolate`), never the model-facing description nor raw JSON. The `ai.tools.confirm` default text changes to `Voy a: {tool}{args}\n¿Confirmas? (sí/no)` (en: `About to: {tool}{args}\nDo you confirm? (yes/no)`).
  - An answer that is not a clear yes/no (e.g. "sí pero cambia a 5 unidades") no longer counts as a denial: the tool is not run and the model gets `{ executed: false, reason: 'user_replied', userReply }` so it can re-propose. New `classifyConfirmation()`, `DEFAULT_NO`, `toolConfirm.no`, `ToolConfirmReply`, event `tool.confirm.replied`; `DEFAULT_YES` gains a few words.
  - A localized system prompt note lists the tools the system confirms itself, so the model does not ask before calling them (`toolConfirm.systemNote`, `AIClientOptions.toolNote`).
  - Successful runs of `confirm`/`dedupe` tools are remembered per chat (in memory, cleared by `/reset` / `clearToolHistory()`): a repeated call is flagged in the confirmation prompt (`ai.tools.confirmRepeat`, `ToolConfirmRequest.previous`) and in the system prompt, and the new per-tool `dedupe: 'args' | { windowMs }` blocks an identical re-run (`{ executed: false, reason: 'duplicate', previous }`, event `tool.duplicate`).
  - The JSON Schema validator also checks `minimum`/`maximum`, `minLength`/`maxLength` and `minItems`/`maxItems`; invalid arguments (including `enum` inside `items`) are rejected before any confirmation.
  - The autoreply converts the model's Markdown to the channel's format from `capabilities.textFormat` (WhatsApp `*bold*`, stripped on plain channels), also when streaming. New `format` option and `formatMarkdown()` / `formatMarkdownStream()` exports.
- c5e8fcb: Tools can render their confirmation for humans without a full custom message: `labels` maps argument values to human labels per argument key (`{ producto: { pan_de_bono: 'Pan de bono' } }` → `• 2 × Pan de bono`, also inside list items), and `confirmLines(args)` replaces the argument lines with your own (e.g. prices and a total computed in code) inside the localized `ai.tools.confirm` wrapper. The model and the handler keep the raw values. `argLines()` and `summarizeValue()` accept the labels as an optional extra argument; new exported type `AIToolLabels`. Defaults are unchanged.
- a0707c1: Per-turn tool selection: `replyInChat`/`ask` accept `tools: ['id', …]` to restrict the tool loop to those configured tools (unknown ids reject with a clear error; `[]` runs the turn without tools). Used by the declarative `ai` step of `@bot-wa/flow-schema`.
- 397c2be: Export `AIPluginConfig` and the injectable client shapes (`AnthropicLike`, `OpenAILike`, `GeminiLike` and the request/response types they reference). `AITimeoutError` now extends core's `TimeoutError`.
- 0a2291f: Breaking (alpha): `aiPlugin({ instance })` is the public way to inject a ready-built `AIProvider` (`MockAIProvider` in tests, or your own); it skips the `provider`/`apiKey`/`model` resolution and the lazy SDK load. The test-only `__provider` hook is stripped from the published types (`stripInternal`) but still honoured at runtime; `instance` wins when both are set.
- e4574e6: Tracing hooks, opt-in through `BotConfig.telemetry`. Without the key nothing changes (no span code runs). With a `BotTracer` (OpenTelemetry through the private `@bot-wa/otel`, or your own) the bot emits spans for inbound events, persistence, dispatch (queue wait, routing stage), handlers, conversation turns (one per stretch between waits; flow steps as events), triggers, broadcasts, pacing and sends, with chat/sender/message ids hashed by default (`ids: 'hash' | 'raw' | 'omit'`, `idKey`) and never message bodies, prompts or error messages (unless `errorMessages: true`). A throwing tracer never breaks the bot. New API: `bot.tracing`, the `BotTracer`/`BotTracing`/`BotSpan`/`TelemetryConfig` types, `TRACE_ATTR`, `SPAN_NAMES`, `noopTracer`, `NOOP_TRACING`, `errorTypeOf`, and `createRecordingTracer()` in `@bot-wa/core/testing`. `Dispatcher.conversationMatcher()` takes an optional `{ flow }`.
  
  `@bot-wa/ai`: `AIClientOptions.tracing` (aiPlugin passes `bot.tracing`) and `providerName`. Model calls become `chat {model}` spans with OpenTelemetry GenAI attributes (models, token usage, finish reason, purpose; a timeout is `error.type = timeout`), tool calls `execute_tool {name}` spans with their outcome, and RAG retrieval a `bot.ai.retrieve` span; no prompts, completions, arguments or results are recorded. `GenerateInput.onStreamEnd` also reports `usage` when the provider streams it (Anthropic, Gemini).
- efb1fa6: Native streaming of long/AI replies with `ctx.stream(source, opts)`. The strategy comes from the new `ProviderCapabilities.streaming` field (`'draft' | 'edit' | 'none'`): native drafts (Telegram `sendMessageDraft`, with `can_stop`/`keep_on_stop`), throttled message edits (Discord, Telegram groups) or sentence chunks with typing (WhatsApp). Updates are throttled, cancellation is supported (`signal`, the user's stop button) and no message exceeds `maxTextLength`. New exports: `streamText`, `resolveStreamStrategy`, `splitMessage`, `findSplitPoint` and their types; `IProvider.sendDraft`; `MockProvider({ streaming })`. `@bot-wa/ai` gains `AIClient.streamReplyInChat()` and the `stream` option for the autoresponder. The Telegram long-poll now also asks for `stopped_message_generation` updates. Live edits and drafts run the `before('send')` hooks (payload `stream: 'draft' | 'edit'`) and the message log keeps the final edited text; rate-limited edits back off for `retryAfterMs`; `onCancel: 'discard'` deletes the live message when the transport can. The streamed autoreply honours refusals (`refusalMessage`, not stored), replies `errorMessage` on an empty answer and, with `onCancel: 'discard'`, keeps a cancelled answer out of the context.

### Patch Changes

- ce7790f: Lazy loading of the optional AI SDKs (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) only reports "not installed" when the SDK package itself cannot be found, and keeps the original resolution error as `cause`. An SDK that is installed but fails while loading (or misses one of its own dependencies) is no longer misreported as missing: its real error is rethrown.
- 637ea2d: Tool loop, thinking and sources polish:
  
  - `thinking: { budgetTokens }` must be a positive integer: NaN, ±Infinity, fractions, zero, negatives or a non-number throw a `RangeError` from `aiPlugin()` / `new AnthropicProvider()` instead of reaching the API.
  - Tool calls cut off by the output-token cap on the last allowed step are reported as truncated (`tool.truncated` events, `truncatedToolCalls`, `stopReason` `'max_tokens'`) with a clear localized reply (`ai.tools.truncated`) instead of the generic `maxSteps` message.
  - `appendSources`: a cited passage without `citation`/`source` is listed as `[2]` instead of `[2] #2`.
  - The `AIThinking` doc comment now says which models accept, deprecate or reject thinking budgets.
- 403929e: The "already done, confirming will do it again" notice of a tool confirmation (`ai.tools.confirmRepeat`) is only shown when the new call has the same (validated) arguments as a previous successful run in the chat; a call with different arguments (e.g. changing an order from 3 to 2 units) is a new action and gets no notice. `ToolConfirmRequest.previous` follows the same rule. The result summary in that notice (and in `summarizeValue()`) leaves out fields too nested to read instead of rendering them as `…, …`.
- 162cc3d: The AI plugin's `/reset` reply now goes through the i18n catalog (`core.commands.reset`): it still defaults to Spanish and comes out in English when the chat resolves to English.
- 8754bee: Robustness fixes across the AI plugin:
  
  - The chat history handed to the providers always starts with a user turn and has no blank turns: an odd `context.maxMessages` no longer makes Anthropic/Gemini reject every later call, and an empty model answer is no longer stored (it used to poison the chat until `/reset`). The one-shot autoreply answers `errorMessage` (and logs a warning) instead of sending a blank message.
  - Refusals are reported uniformly as `stopReason: 'refusal'` (so `refusalMessage` is used): OpenAI `message.refusal` / streamed refusal deltas, and Gemini safety blocks (finish reason `SAFETY`, `RECITATION`, … or a blocked prompt), which used to throw.
  - Gemini and Ollama streams now call `onStreamEnd` with the stop reason (streamed refusals are detected there too).
  - Ollama: the last NDJSON line of a stream is no longer dropped when it has no trailing newline, an `{"error"}` line rejects, HTTP errors include the server message, and `maxTokens` is sent as `options.num_predict` when set. Memory extraction's 300-token default is now a soft cap (new optional `GenerateInput.defaultMaxTokens`): Anthropic, OpenAI-compatible and Gemini apply it as before, Ollama ignores it, so reasoning models are not cut off unless `memory.autoExtract.maxTokens` is set.
  - OpenAI-compatible gateways that answer HTTP 200 with `{ error }` reject with that message instead of producing an empty reply.
  - `baseUrl` is passed to the Anthropic SDK (gateways / proxies).
  - `LazyProvider` retries a failed provider resolution on the next call instead of caching the failure forever.
  - JSON Schema validation of tool arguments checks own keys only (`required` / `additionalProperties: false` are no longer fooled by `toString`, `constructor`, …).
  - `formatMarkdown(..., 'html')` escapes `"` inside link URLs.
  - A memory extraction cut off by the token cap reports an actionable error (raise `memory.autoExtract.maxTokens`).
  - An unknown `provider` name now lists the valid ones in the error.
- 20f6674: The one-shot autoreply no longer shows the typing indicator twice when `BotConfig.typing` is on: with `humanizeTyping` the indicator is shown while the answer is generated and the reply is sent with `typing: false`.
- 8e61c20: A side-effecting tool (`confirm` / `dedupe`) whose handler returns an object with a non-empty `error` (e.g. `{ error: 'No existe el pedido P-1' }`) is no longer remembered as a done action: it does not trigger the repeat notice, the "actions already done" system note or a `dedupe` block.
- 32a2254: The system note for tools that require confirmation tells the model not to claim actions no tool confirmed, not to mention the confirmation process to the user and not to compute amounts on its own (findings from a live test with WhatsApp + Ollama).
- 1f7e9b1: A failing typing indicator no longer turns the autoreply into `errorMessage`: the `ctx.typing()` shown while the answer is generated is ignored when it fails (one-shot, tool and streamed paths).
- 2bab262: `@bot-wa/core`: new optional `IProvider.textFormatFor(chatId)` for providers that serve several channels with different markup through one instance (e.g. Twilio WhatsApp + SMS). It wins over `capabilities.textFormat` (the fallback when it returns `undefined`) and reaches handlers as `ctx.textFormat`. `MockProvider` accepts `textFormatFor`; `ChaosProvider` forwards it.
  
  `@bot-wa/ai`: the autoreply (one-shot and streamed) formats Markdown with the chat's `ctx.textFormat` instead of the provider-wide `capabilities.textFormat`.
- ce7790f: Packaging: dependencies between `@bot-wa/*` packages are published as caret ranges (`^x.y.z`, from `workspace:^`) instead of exact versions, so npm dedupes a single `@bot-wa/core` instead of installing a second copy when one package lags a patch behind. Published READMEs use absolute GitHub links (relative links broke on npmjs.com), and `@bot-wa/core`/`@bot-wa/http` gain `repository.directory`, `homepage` and `bugs` metadata.
- Updated dependencies [2e16743]
- Updated dependencies [397c2be]
- Updated dependencies [0a2291f]
- Updated dependencies [ddfb1e9]
- Updated dependencies [ee5777c]
- Updated dependencies [522bcca]
- Updated dependencies [588fa34]
- Updated dependencies [a33cb08]
- Updated dependencies [909fa96]
- Updated dependencies [9cb6621]
- Updated dependencies [99251ef]
- Updated dependencies [7cc66b2]
- Updated dependencies [39a8149]
- Updated dependencies [31fcc2e]
- Updated dependencies [40fdab4]
- Updated dependencies [4bbd0ad]
- Updated dependencies [f8c1d4f]
- Updated dependencies [231cbd2]
- Updated dependencies [ca25eb7]
- Updated dependencies [18958c6]
- Updated dependencies [40ec0bd]
- Updated dependencies [fd07c8c]
- Updated dependencies [0149d66]
- Updated dependencies [9c94d93]
- Updated dependencies [08a933f]
- Updated dependencies [1a81406]
- Updated dependencies [64fb59f]
- Updated dependencies [2549ffe]
- Updated dependencies [a4e9429]
- Updated dependencies [310db8d]
- Updated dependencies [2bab262]
- Updated dependencies [6ea4442]
- Updated dependencies [136caa5]
- Updated dependencies [634993f]
- Updated dependencies [b866fbd]
- Updated dependencies [c6a4292]
- Updated dependencies [7b00477]
- Updated dependencies [6504335]
- Updated dependencies [ce42173]
- Updated dependencies [1984f6f]
- Updated dependencies [522bcca]
- Updated dependencies [02a21cc]
- Updated dependencies [23371fb]
- Updated dependencies [9b97391]
- Updated dependencies [f25b2af]
- Updated dependencies [2232f88]
- Updated dependencies [27620ef]
- Updated dependencies [e4574e6]
- Updated dependencies [ce7790f]
- Updated dependencies [b95b523]
- Updated dependencies [5196990]
- Updated dependencies [2c4f9f0]
- Updated dependencies [efb1fa6]
- Updated dependencies [4fc0560]
  - @bot-wa/core@2.0.0-alpha.2
