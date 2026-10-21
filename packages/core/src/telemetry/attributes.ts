/**
 * Span names and attribute keys of the tracing hooks.
 */

/**
 * Every span name and attribute key the core and `@bot-wa/ai` write, in one place (so a
 * rename of the OpenTelemetry semantic conventions is a one-line change). The `gen_ai.*`
 * keys follow the OpenTelemetry GenAI conventions (experimental).
 */
export const TRACE_ATTR = {
  // ---- bot ----
  botId: 'bot.id',
  providerId: 'bot.provider.id',
  eventKind: 'bot.event.kind',
  messageType: 'bot.message.type',
  chatKind: 'bot.chat.kind',
  chatId: 'bot.chat.id',
  senderId: 'bot.sender.id',
  messageId: 'bot.message.id',
  inboundOutcome: 'bot.inbound.outcome',
  queueWaitMs: 'bot.queue.wait_ms',
  dispatchStage: 'bot.dispatch.stage',
  handlerStage: 'bot.handler.stage',
  matcherKind: 'bot.matcher.kind',
  commandName: 'bot.command.name',
  flowId: 'bot.flow.id',
  conversationId: 'bot.conversation.id',
  conversationName: 'bot.conversation.name',
  conversationReason: 'bot.conversation.reason',
  conversationOutcome: 'bot.conversation.outcome',
  conversationParked: 'bot.conversation.parked',
  conversationGoto: 'bot.conversation.goto',
  triggerName: 'bot.trigger.name',
  triggerResult: 'bot.trigger.result',
  broadcastRecipients: 'bot.broadcast.recipients',
  paceMs: 'bot.pace.ms',
  contentKind: 'bot.content.kind',
  sendOrigin: 'bot.send.origin',
  sendOutcome: 'bot.send.outcome',
  sendEdit: 'bot.send.edit',
  sendStream: 'bot.send.stream',
  errorType: 'error.type',
  /** Lifecycle step (`storage`, `transport`, `durability`…) and what it was doing. */
  lifecycleStep: 'bot.lifecycle.step',
  lifecyclePhase: 'bot.lifecycle.phase',
  /** Attribute of a span LINK: why it was linked (`'resume'`: a checkpoint carried from another process). */
  linkReason: 'bot.link.reason',
  // ---- scheduled tasks (bot.task) ----
  taskId: 'bot.task.id',
  taskKind: 'bot.task.kind',
  taskDurable: 'bot.task.durable',
  taskCron: 'bot.task.cron',
  taskIntervalMs: 'bot.task.interval_ms',
  taskTimeZone: 'bot.task.time_zone',
  taskScheduledAt: 'bot.task.scheduled_at',
  taskMissed: 'bot.task.missed',
  taskFencingToken: 'bot.task.fencing_token',
  schedulerRole: 'bot.scheduler.role',
  schedulerOwner: 'bot.scheduler.owner',
  // ---- AI (OpenTelemetry GenAI conventions + bot.ai.*) ----
  genAiOperation: 'gen_ai.operation.name',
  genAiProvider: 'gen_ai.provider.name',
  genAiRequestModel: 'gen_ai.request.model',
  genAiRequestMaxTokens: 'gen_ai.request.max_tokens',
  genAiResponseModel: 'gen_ai.response.model',
  genAiInputTokens: 'gen_ai.usage.input_tokens',
  genAiOutputTokens: 'gen_ai.usage.output_tokens',
  genAiFinishReasons: 'gen_ai.response.finish_reasons',
  genAiToolName: 'gen_ai.tool.name',
  genAiToolCallId: 'gen_ai.tool.call.id',
  aiPurpose: 'bot.ai.purpose',
  aiStep: 'bot.ai.step',
  aiStreamed: 'bot.ai.streamed',
  aiCancelled: 'bot.ai.cancelled',
  aiToolOutcome: 'bot.ai.tool.outcome',
  aiRagChunks: 'bot.ai.rag.chunks',
} as const

/** Span names written by the core and `@bot-wa/ai`. */
export const SPAN_NAMES = {
  inbound: 'bot.inbound',
  persist: 'bot.persist',
  dispatch: 'bot.dispatch',
  handler: 'bot.handler',
  conversationTurn: 'bot.conversation.turn',
  trigger: 'bot.trigger',
  broadcast: 'bot.broadcast',
  pace: 'bot.pace',
  send: 'bot.send',
  streamUpdate: 'bot.stream.update',
  aiRetrieve: 'bot.ai.retrieve',
  task: 'bot.task',
  lifecycle: 'bot.lifecycle',
} as const
