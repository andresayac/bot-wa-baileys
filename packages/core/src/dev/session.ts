/**
 * DevSession — the I/O-free engine behind `bot-wa dev`.
 *
 * It owns the simulated identity (who is typing, in which chat), builds your bot
 * from its factory around a {@link DevProvider}, prints what the bot sends, runs
 * the `:commands`, and hot-swaps the bot on reload. Everything it prints goes
 * through the injected `write`, and your module is obtained through the injected
 * `load`, so it runs (and is tested) without a TTY, a filesystem watcher or
 * real module loading. The `bot-wa` CLI wires it to readline + `fs.watch`.
 *
 * All operations (lines, reloads, resets) are serialised in one queue, so a
 * reload never interleaves with a half-processed command.
 *
 * @example
 * ```ts
 * import { DevSession } from '@bot-wa/core/dev'
 *
 * const session = new DevSession({
 *   load: () => import('./bot.js'),
 *   write: (text) => process.stdout.write(text),
 * })
 * await session.start()
 * await session.handleLine('hola')      // the bot's reply is written via `write`
 * await session.handleLine(':state')
 * await session.stop()
 * ```
 */

import { readFile as fsReadFile } from 'node:fs/promises'
import { basename, extname, resolve as resolvePath } from 'node:path'
import { inspect } from 'node:util'

import type { Bot } from '../core/Bot.js'
import type { ChatId, MessageRef, UserId } from '../core/provider.js'
import { DEV_HELP, parseDevInput, type DevCommand } from './commands.js'
import type { BotFactory } from './defineBot.js'
import { DevProvider, type DevMediaKind, type DevOutbound } from './DevProvider.js'
import { DevEntryError, resolveBotFactory } from './loader.js'
import { formatMessage, renderOutbound, type DevChoice, type DevInteractiveKind } from './render.js'

/** Who the developer is pretending to be. */
export interface DevIdentity {
  /** Opaque sender id (`ctx.sender`). In a DM it is also the chat id. */
  user: UserId
  /** Display name (`ctx.pushName`). */
  name: string
  /** Group chat id when chatting inside a group; `undefined` in a DM. */
  group?: ChatId
}

/** Options for {@link DevSession}. */
export interface DevSessionOptions {
  /**
   * Load (or re-load) the bot module. Must resolve to the module namespace
   * (whose `default` export is the factory) or to the factory itself. Called on
   * `start()` and on every `reload()`.
   */
  load: () => Promise<unknown>
  /** Output sink. Receives complete lines (always ending in `\n`). */
  write: (text: string) => void
  /** Initial sender id. Default `'user'`. */
  user?: string
  /** Initial display name. Default `'Dev User'`. */
  name?: string
  /** Start inside this group chat instead of a DM. */
  group?: string
  /** Base directory for relative `:media` paths. Default `process.cwd()`. */
  cwd?: string
  /** File reader for `:media`. Default `fs/promises` `readFile`. */
  readFile?: (path: string) => Promise<Uint8Array>
  /** ANSI colours in labels and notices. Default `false`. */
  color?: boolean
  /**
   * Echo each sent message into the output (`user › hola`). Useful when input
   * is piped and therefore not shown by a terminal. Default `false`.
   */
  echo?: boolean
  /**
   * When > 0, `handleLine` resolves only after the bot has been quiet for this
   * many ms (capped by `maxSettleMs`), so piped transcripts keep their order.
   * Default `0` (interactive: replies print whenever they arrive).
   */
  settleMs?: number
  /** Upper bound for one settle wait. Default 10 000 ms. */
  maxSettleMs?: number
}

/** What the caller should do after a line: keep reading, or shut down. */
export type DevLineResult = 'continue' | 'quit'

interface LiveBot {
  bot: Bot
  provider: DevProvider
  dispose(): void
}

interface LastInteractive {
  kind: DevInteractiveKind
  choices: DevChoice[]
  ref: MessageRef
}

type Tone = 'dim' | 'red' | 'green' | 'yellow' | 'cyan'
const TONES: Record<Tone, [number, number]> = {
  dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39],
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** Best-effort mimetype from a file extension (`application/octet-stream` when unknown). */
export function guessMimeType(path: string, kind?: DevMediaKind): string {
  const known = MIME_TYPES[extname(path).toLowerCase()]
  if (known) return known
  return kind === 'sticker' ? 'image/webp' : 'application/octet-stream'
}

function isBotLike(value: unknown): value is Bot {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { start?: unknown; stop?: unknown; on?: unknown }
  return typeof v.start === 'function' && typeof v.stop === 'function' && typeof v.on === 'function'
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object without start()/stop()/on()' : typeof value
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class DevSession {
  private readonly options: DevSessionOptions
  private readonly color: boolean
  private readonly settleMs: number
  private readonly maxSettleMs: number
  private readonly cwd: string
  private readonly readFile: (path: string) => Promise<Uint8Array>
  private ident: DevIdentity
  private factory?: BotFactory
  private live?: LiveBot
  /** Provider of the bot currently being booted or running; output from any other is stale. */
  private currentProvider?: DevProvider
  private interactive = new Map<ChatId, LastInteractive>()
  private queue: Promise<unknown> = Promise.resolve()
  private reloadCount = 0
  private lastActivity = 0
  private stopped = false

  constructor(options: DevSessionOptions) {
    this.options = options
    this.color = options.color ?? false
    this.settleMs = Math.max(0, options.settleMs ?? 0)
    this.maxSettleMs = options.maxSettleMs ?? 10_000
    this.cwd = options.cwd ?? process.cwd()
    this.readFile = options.readFile ?? ((path) => fsReadFile(path))
    const user = options.user ?? 'user'
    this.ident = { user, name: options.name ?? (options.user ? user : 'Dev User'), group: options.group }
  }

  /** The simulated sender and chat. */
  get identity(): Readonly<DevIdentity> { return { ...this.ident } }
  /** The running bot, if any. */
  get bot(): Bot | undefined { return this.live?.bot }
  /** The provider injected into the running bot, if any. */
  get provider(): DevProvider | undefined { return this.live?.provider }
  /** Successful reloads so far. */
  get reloads(): number { return this.reloadCount }
  /** True while a bot is running. */
  get running(): boolean { return this.live !== undefined }

  /** Prompt label for the current identity: `user › ` or `user @ group › `. */
  prompt(): string {
    return `${this.ident.user}${this.ident.group ? ` @ ${this.ident.group}` : ''} › `
  }

  /** Load the module and start the bot. Resolves `false` (after printing why) when it cannot. */
  start(): Promise<boolean> { return this.enqueue(() => this.loadAndBoot('start')) }

  /**
   * Re-load the module and swap the running bot for a fresh one built by the new
   * factory. When loading fails the previous bot keeps running.
   * @param reason shown in the `↻ reloaded (...)` notice.
   */
  reload(reason = 'manual'): Promise<boolean> { return this.enqueue(() => this.loadAndBoot('reload', reason)) }

  /** Restart the bot from the current factory with fresh in-memory state. */
  reset(): Promise<boolean> { return this.enqueue(() => this.resetNow()) }

  /** Process one line typed by the developer (a message or a `:command`). */
  handleLine(line: string): Promise<DevLineResult> {
    return this.enqueue(async () => {
      try {
        return await this.execute(parseDevInput(line))
      } catch (error) {
        this.printError('simulator error', error)
        return 'continue'
      }
    })
  }

  /** Resolves once every queued operation has finished. */
  idle(): Promise<void> { return this.enqueue(async () => undefined) }

  /** Stop the running bot. Later reloads are ignored. Idempotent. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.stopped = true
      await this.teardown()
    })
  }

  /* ----------------------------------------------------------------------- */

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private chatId(): ChatId { return this.ident.group ?? this.ident.user }

  private async execute(command: DevCommand): Promise<DevLineResult> {
    switch (command.kind) {
      case 'empty':
        return 'continue'
      case 'message':
        this.sendText(command.text)
        await this.settle()
        return 'continue'
      case 'as':
        this.ident = { ...this.ident, user: command.user, name: command.name ?? command.user }
        this.info(`you are now "${this.ident.user}" (${this.ident.name})${this.ident.group ? ` in group "${this.ident.group}"` : ''}`)
        return 'continue'
      case 'group':
        this.ident = { ...this.ident, group: command.id }
        this.info(`now in group "${command.id}" as "${this.ident.user}" — mention the bot as @${this.live?.provider.selfId ?? 'bot'}`)
        return 'continue'
      case 'dm':
        this.ident = { ...this.ident, group: undefined }
        this.info(`back to a DM as "${this.ident.user}"`)
        return 'continue'
      case 'media':
        await this.sendMedia(command.mediaKind, command.path, command.caption)
        await this.settle()
        return 'continue'
      case 'click':
        this.click(command.target)
        await this.settle()
        return 'continue'
      case 'reset':
        await this.resetNow()
        return 'continue'
      case 'reload':
        await this.loadAndBoot('reload', ':reload')
        return 'continue'
      case 'state':
        await this.printState()
        return 'continue'
      case 'help':
        this.out(`${DEV_HELP}\n`)
        return 'continue'
      case 'quit':
        return 'quit'
      case 'invalid':
        this.problem(command.message)
        return 'continue'
    }
  }

  private async loadAndBoot(mode: 'start' | 'reload', reason?: string): Promise<boolean> {
    if (this.stopped) return false
    let factory: BotFactory
    try {
      factory = resolveBotFactory(await this.options.load())
    } catch (error) {
      if (mode === 'reload' && this.live) this.printError('reload failed — keeping the previous version', error)
      else this.printError(mode === 'start' ? 'could not load your bot' : 'reload failed', error)
      return false
    }
    this.factory = factory
    await this.teardown()
    const ok = await this.boot(factory)
    if (ok && mode === 'reload') {
      this.reloadCount++
      this.info(`↻ reloaded (${reason})`)
    }
    return ok
  }

  private async resetNow(): Promise<boolean> {
    if (!this.factory) {
      this.problem('nothing to reset — the bot is not loaded')
      return false
    }
    await this.teardown()
    this.interactive.clear()
    const ok = await this.boot(this.factory)
    if (ok) this.info('↺ fresh bot — conversations and in-memory state cleared')
    return ok
  }

  private async boot(factory: BotFactory): Promise<boolean> {
    const provider = new DevProvider()
    this.currentProvider = provider
    let candidate: unknown
    try {
      candidate = await factory(provider)
    } catch (error) {
      this.currentProvider = undefined
      this.printError('your bot factory threw', error)
      return false
    }
    if (!isBotLike(candidate)) {
      this.currentProvider = undefined
      this.printError('could not start your bot', new DevEntryError(
        `The bot factory must return the Bot it built (got ${describeValue(candidate)}): ` +
          'defineBot((provider) => { const bot = new Bot({ provider }); ...; return bot })',
      ))
      return false
    }
    const bot = candidate
    if (typeof bot.getProvider === 'function' && bot.getProvider() !== provider) {
      this.currentProvider = undefined
      this.printError('refusing to start your bot', new DevEntryError(
        'It was built with its own provider instead of the one bot-wa dev passed to the factory, so it could ' +
          'connect to a real transport. Build it with the given provider: defineBot((provider) => new Bot({ provider }))',
      ))
      return false
    }

    const offOutbound = provider.onOutbound((message) => this.onOutbound(provider, message))
    const onError = (payload: { error: unknown }) => this.onBotError(provider, payload)
    bot.on('error', onError)
    // Without any onError('message') hook the dispatcher rethrows a handler's
    // error into its own catch and it never reaches the 'error' event. A no-op
    // hook lets it through, so the simulator can print every handler error.
    if (typeof bot.onError === 'function') bot.onError('message', () => undefined)
    const dispose = () => {
      offOutbound()
      if (typeof bot.off === 'function') bot.off('error', onError)
    }
    try {
      await bot.start()
    } catch (error) {
      this.printError('your bot failed to start', error)
      try { await bot.stop() } catch { /* already reported the start failure */ }
      dispose()
      this.currentProvider = undefined
      return false
    }
    this.live = { bot, provider, dispose }
    return true
  }

  private async teardown(): Promise<void> {
    const live = this.live
    this.live = undefined
    if (!live) {
      this.currentProvider = undefined
      return
    }
    try {
      await live.bot.stop()
    } catch (error) {
      this.printError('stopping the previous bot failed', error)
    }
    live.dispose()
    if (this.currentProvider === live.provider) this.currentProvider = undefined
  }

  private requireLive(): LiveBot | undefined {
    if (!this.live) this.problem('the bot is not running — fix the error above, then save the file (or type :reload)')
    return this.live
  }

  private sendText(text: string): void {
    if (this.options.echo) this.out(formatMessage(this.prompt(), text))
    const live = this.requireLive()
    if (!live) return
    const mentions = [...text.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1]!)
    this.lastActivity = Date.now()
    live.provider.incoming(text, {
      from: this.chatId(),
      sender: this.ident.user,
      isGroup: this.ident.group !== undefined,
      pushName: this.ident.name,
      mentions,
    })
  }

  private async sendMedia(kind: DevMediaKind, path: string, caption?: string): Promise<void> {
    if (this.options.echo) this.out(formatMessage(this.prompt(), `[${kind}: ${path}]${caption ? `\n${caption}` : ''}`))
    const live = this.requireLive()
    if (!live) return
    const absolute = resolvePath(this.cwd, path)
    let data: Uint8Array
    try {
      data = await this.readFile(absolute)
    } catch (error) {
      this.printError(`cannot read ${path}`, error)
      return
    }
    this.lastActivity = Date.now()
    live.provider.injectMedia({
      chatId: this.chatId(),
      senderId: this.ident.user,
      isGroup: this.ident.group !== undefined,
      displayName: this.ident.name,
      kind,
      data,
      filename: basename(absolute),
      mimetype: guessMimeType(absolute, kind),
      caption,
    })
  }

  private click(target: string): void {
    const live = this.requireLive()
    if (!live) return
    const last = this.interactive.get(this.chatId())
    if (!last) {
      this.problem('nothing to click — the bot has not sent buttons, a list or a poll in this chat')
      return
    }
    const wanted = target.trim().toLowerCase()
    const choice = /^\d+$/.test(wanted)
      ? last.choices.find((c) => c.n === Number(wanted))
      : last.choices.find((c) => c.value.toLowerCase() === wanted || c.label.toLowerCase() === wanted)
    if (!choice) {
      this.problem(`no option ${target.trim()} — pick 1-${last.choices.length}, an id or a label`)
      return
    }
    if (choice.url) {
      this.info(`"${choice.label}" is a link button (${choice.url}); it opens a URL and sends nothing to the bot`)
      return
    }
    this.lastActivity = Date.now()
    const isGroup = this.ident.group !== undefined
    if (last.kind === 'poll') {
      this.info(`voted for "${choice.label}"`)
      live.provider.injectPollVote({
        poll: last.ref,
        options: last.choices.map((c) => c.value),
        chosen: [choice.value],
        senderId: this.ident.user,
      })
      return
    }
    this.info(`tapped "${choice.label}"`)
    live.provider.interaction(choice.value, {
      from: this.chatId(),
      sender: this.ident.user,
      isGroup,
      pushName: this.ident.name,
    })
  }

  private async printState(): Promise<void> {
    const { user, name, group } = this.ident
    const lines = [
      `you: "${user}" (${name}) · ${group ? `group "${group}"` : 'DM'}`,
      `chat: ${this.chatId()}`,
    ]
    const live = this.live
    if (!live) {
      lines.push('bot: not running')
    } else {
      const connection = typeof live.bot.getConnectionState === 'function' ? live.bot.getConnectionState() : 'running'
      lines.push(`bot: ${connection} · reloads: ${this.reloadCount}`)
      const snapshot = typeof live.bot.inspectConversation === 'function'
        ? live.bot.inspectConversation({ from: this.chatId(), sender: user, isGroup: group !== undefined })
        : undefined
      if (!snapshot) {
        lines.push('conversation: none')
      } else {
        lines.push(`conversation: ${snapshot.waiting ? 'waiting for a reply' : 'running'}${snapshot.queued ? ` · ${snapshot.queued} queued` : ''}`)
        lines.push(`state: ${inspect(snapshot.state, { depth: 4, colors: this.color, breakLength: Infinity })}`)
      }
      if (typeof live.bot.getStore === 'function') {
        try {
          const history = await live.bot.getStore().getMessagesByChat(this.chatId())
          lines.push(`history: ${history.length} message(s) stored for this chat`)
        } catch { /* custom stores may not support it */ }
      }
    }
    this.out(`${lines.map((line) => this.paint('dim', `• ${line}`)).join('\n')}\n`)
  }

  private onOutbound(provider: DevProvider, message: DevOutbound): void {
    if (provider !== this.currentProvider) return
    this.lastActivity = Date.now()
    const rendered = renderOutbound(message.content)
    if (rendered.interactive) {
      this.interactive.set(message.chatId, { kind: rendered.interactive, choices: rendered.choices, ref: message.ref })
    }
    const label = message.chatId === this.chatId() ? 'bot › ' : `bot → ${message.chatId} › `
    this.out(formatMessage(this.paint('green', label), rendered.text))
  }

  private onBotError(provider: DevProvider, payload: { error: unknown }): void {
    if (provider !== this.currentProvider) return
    this.lastActivity = Date.now()
    this.printError('bot error', payload?.error ?? payload)
  }

  private async settle(): Promise<void> {
    if (this.settleMs <= 0) return
    const started = Date.now()
    for (;;) {
      await delay(this.settleMs)
      const now = Date.now()
      if (now - this.lastActivity >= this.settleMs || now - started >= this.maxSettleMs) return
    }
  }

  /* Output helpers --------------------------------------------------------- */

  private out(text: string): void { this.options.write(text) }

  private paint(tone: Tone, text: string): string {
    if (!this.color) return text
    const [open, close] = TONES[tone]
    return `\u001b[${open}m${text}\u001b[${close}m`
  }

  private info(text: string): void { this.out(`${this.paint('dim', `• ${text}`)}\n`) }

  private problem(text: string): void { this.out(`${this.paint('red', `✖ ${text}`)}\n`) }

  private printError(title: string, error: unknown): void {
    const err = error instanceof Error ? error : undefined
    const [first = '', ...more] = (err ? err.message : String(error)).split('\n')
    const lines = [this.paint('red', `✖ ${title}: ${first}`), ...more.map((line) => `  ${line}`)]
    if (err && !(err instanceof DevEntryError) && err.stack) {
      const frames = err.stack.split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 6)
      lines.push(...frames.map((frame) => this.paint('dim', `  ${frame.trim()}`)))
    }
    const cause = err?.cause
    if (cause instanceof Error && err instanceof DevEntryError) {
      const frames = (cause.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 4)
      lines.push(...frames.map((frame) => this.paint('dim', `  ${frame.trim()}`)))
    }
    this.out(`${lines.join('\n')}\n`)
  }
}
