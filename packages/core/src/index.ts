/**
 * @bot-wa/bot-wa-baileys — main entry point.
 *
 * A modern WhatsApp bot framework built on Baileys 7 — flows, hooks, plugins,
 * sub-APIs, scheduler and dependency injection.
 *
 * @example Create and start a bot
 * ```ts
 * import { Bot, flow, definePlugin, slashCommandsPlugin } from '@bot-wa/bot-wa-baileys'
 *
 * const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })
 * bot.on('ready', () => bot.logger.info('ready'))
 * await bot.start()
 * ```
 *
 * @example Declarative handlers
 * ```ts
 * bot.when('hola', async (ctx) => await ctx.reply('¡Hola! 👋'))
 * bot.when(['adios', 'chao'], async (ctx) => await ctx.reply('bye'))
 * bot.when(/\d{4,}/, async (ctx) => await ctx.reply('long number'))
 * ```
 *
 * @example Flows (DSL)
 * ```ts
 * const registerFlow = flow('registrar')
 *   .say('¿Nombre?', { capture: true })
 *   .do(async (ctx, { state }) => state.set('name', ctx.body))
 *   .say('¿Email?', { capture: true })
 *   .validate((b) => /@/.test(b) ? true : '❌ invalid')
 *   .end()
 * bot.use(registerFlow)
 * ```
 *
 * @example Plugins & DI
 * ```ts
 * bot.plug(slashCommandsPlugin, { greeting: 'Hi!' })
 * bot.plug(definePlugin({ name: 'log', version: '1.0.0', install(c) { c.bot.before('message', async (x, n) => n()) } }))
 * bot.provide('db', myDatabase)
 * ```
 */

// Core
export { Bot } from './core/Bot.js'
export type { BotEvents, MessageHandler, CommandHandler } from './core/Bot.js'
export { buildMessageContext, loadMediaOf } from './core/context.js'
export type { MediaProcessorAPI, BuildContextDeps } from './core/context.js'
export { Dispatcher } from './core/Dispatcher.js'
export type { DispatchContext } from './core/Dispatcher.js'
export type {
  BotConfig,
  BotConfig as Config,
  ConnectionState,
  ConnectionUpdate,
  ChatId,
  ChatInfo,
  DefaultTools,
  IProvider,
  OutgoingMessage,
  GroupsAPI,
  ProfileAPI,
  PrivacyAPI,
  ChatsAPI,
  PresenceAPI,
  HookEvent,
  HookHandler,
  HookPhase,
  JID,
  JidInput,
  MediaOptions,
  MediaPayload,
  MediaSource,
  MessageContext,
  MessageType,
  Plugin,
  PluginContext,
  PluginSpec,
  QrConfig,
  ScheduledTask,
  SenderInfo,
  SentMessage,
  StoreKind,
  UserId,
  // Trigger matching
  Trigger,
  TriggerObject,
  TriggerScope,
  MatchStrategy,
  // Conversations
  WaitOptions,
} from './core/types.js'

// Flows DSL
export { flow, addKeyword, FlowBuilder, isCompiledFlow } from './flows/FlowBuilder.js'
export type { CompiledFlow, CompiledStep, DynamicText, FlowAction } from './flows/FlowBuilder.js'

// Conversations (async runtime)
export { ConversationRuntime } from './conversations/ConversationRuntime.js'
export type { RuntimeMessage, ConversationFn, ConversationControlsBase, RuntimeConfig } from './conversations/ConversationRuntime.js'
export { createControls } from './conversations/controls.js'
export type { ConversationControls } from './conversations/controls.js'
export {
  ConversationError,
  ConversationTimeout,
  ConversationCancelled,
  ConversationEnded,
  ConversationGoto,
  RetriesExceeded,
} from './conversations/errors.js'

// Hooks & plugins
export { HookSystem } from './hooks/HookSystem.js'
export { definePlugin, isPlugin } from './plugins/definePlugin.js'
export { slashCommandsPlugin } from './plugins/slashCommands.js'

// Provider (advanced users)
export { BaileysProvider, TypedEmitter } from './provider/BaileysProvider.js'

// Store
export { MemoryStore } from './store/MemoryStore.js'
export type { IStore, AIMessage } from './store/IStore.js'
export type { MemoryStoreOptions } from './store/MemoryStore.js'
export { messageKey } from './store/IStore.js'

// Media
export {
  toMediaUpload,
  toBuffer as mediaToBuffer,
  makeSticker,
  transcodeToOpus,
} from './media/MediaProcessor.js'
export type { StickerOptions } from './media/MediaProcessor.js'

// Utils (advanced)
export {
  toJid, sanitizeNumber, normalize as normalizeJid,
  parseJid, buildJid, shortJid,
  isGroup, isBroadcast, isStatus, isNewsletter, isPn, isLid, sameUser,
  isSelfChat, toUserId, toChatId, isValidJid,
} from './utils/jid.js'
export { sleep, parseDuration, humanTypingDelay, withTimeout, TimeoutError, randomId } from './utils/timers.js'

// Scheduler
export { Scheduler } from './scheduler/Scheduler.js'

// Sub-APIs (advanced — used through bot.groups, bot.profile, etc.)
export { GroupsAPIImpl } from './api/GroupsAPI.js'
export { ProfileAPIImpl } from './api/ProfileAPI.js'
export { PrivacyAPIImpl } from './api/PrivacyAPI.js'
export { ChatsAPIImpl } from './api/ChatsAPI.js'
export { PresenceAPIImpl } from './api/PresenceAPI.js'

// Testing helpers live under the "./testing" subpath export (import from
// '@bot-wa/bot-wa-baileys/testing') — not re-exported here to keep the runtime entry lean.
