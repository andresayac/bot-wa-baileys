/**
 * `bot.plug()`: installs a plugin against a scoped bot (`Object.create(receiver)`) whose
 * registration methods are tracked, so unplugging removes, newest first, everything the
 * plugin registered through `ctx.bot`.
 *
 * Works on the RECEIVER passed by the facade (the bot `plug` was called on), never on a
 * captured instance: the scoped bot's methods run with `this` set to it, so Bot must not
 * use ECMAScript `#private` fields (reading one through the scoped object would throw).
 */
import type { Bot } from '../Bot.js'
import type { HookEvent, HookHandler, HookPhase, Plugin, PluginContext } from '../types.js'
import { isThenable, type BotKernel } from './kernel.js'

/** The private member of Bot the scoped bot overrides (bracket access keeps it private on Bot). */
type EnterMatcherHost = { registerEnterMatcher: (trigger: unknown, target: string) => () => void }

export class PluginHost {
  /** Names of the plugins currently plugged (with a count), for `PluginSpec.requires`. */
  private readonly pluggedNames = new Map<string, number>()

  constructor(private readonly k: BotKernel) {}

  plug(receiver: Bot, plugin: Plugin, config?: Record<string, unknown>): () => void {
    const spec = typeof plugin === 'function' ? plugin(config) : plugin
    if (!spec || typeof spec !== 'object' || typeof spec.install !== 'function') {
      throw new TypeError(
        'plug() expects a plugin object { name, version, install(ctx) } or a factory returning one, ' +
          `got ${spec === null ? 'null' : typeof spec}`,
      )
    }
    const missing = (Array.isArray(spec.requires) ? spec.requires : [])
      .filter((name) => !this.pluggedNames.has(name))
    if (missing.length > 0) {
      throw new Error(
        `Plugin "${spec.name}" requires plugin(s) ${missing.map((n) => `"${n}"`).join(', ')}, which ` +
          `${missing.length === 1 ? 'is' : 'are'} not plugged. Plug ${missing.length === 1 ? 'it' : 'them'} ` +
          `before "${spec.name}" (PluginSpec.requires).`,
      )
    }
    const disposables: Array<() => void> = []
    const track = <A extends unknown[]>(fn: (...a: A) => () => void) =>
      (...a: A): (() => void) => {
        const un = fn(...a)
        disposables.push(un)
        return un
      }

    const bot = receiver
    const scopedBot = Object.create(bot) as Bot
    scopedBot.on = bot.on.bind(bot) as Bot['on']
    scopedBot.off = bot.off.bind(bot) as Bot['off']
    scopedBot.once = bot.once.bind(bot) as Bot['once']
    scopedBot.emit = bot.emit.bind(bot) as Bot['emit']
    scopedBot.addListener = bot.addListener.bind(bot) as Bot['addListener']
    scopedBot.removeListener = bot.removeListener.bind(bot) as Bot['removeListener']
    scopedBot.prependListener = bot.prependListener.bind(bot) as Bot['prependListener']
    scopedBot.prependOnceListener = bot.prependOnceListener.bind(bot) as Bot['prependOnceListener']
    scopedBot.command = track(bot.command.bind(bot))
    scopedBot.when = track(bot.when.bind(bot))
    scopedBot.onMessage = track(bot.onMessage.bind(bot))
    scopedBot.onType = track(bot.onType.bind(bot))
    // `conversation()`, `use(flow)` and `when(trigger, flow)` all route through this one
    // (called on scopedBot), so their trigger routes are disposed with the plugin too.
    const host = bot as unknown as EnterMatcherHost
    ;(scopedBot as unknown as EnterMatcherHost).registerEnterMatcher = track(host.registerEnterMatcher.bind(bot))
    // `use(plugin)` calls `this.plug()`: a nested plugin is unplugged with its parent.
    scopedBot.plug = track(bot.plug.bind(bot))
    const hook = (event: HookEvent, phase: HookPhase, handler: HookHandler, priority = 0): Bot => {
      disposables.push(this.k.hooks.register(event, phase, handler, priority))
      return scopedBot
    }
    scopedBot.before = ((event: HookEvent, handler: HookHandler, priority = 0) => hook(event, 'before', handler, priority)) as Bot['before']
    scopedBot.after = ((event: HookEvent, handler: HookHandler, priority = 0) => hook(event, 'after', handler, priority)) as Bot['after']
    scopedBot.onError = ((event: HookEvent, handler: HookHandler, priority = 0) => hook(event, 'error', handler, priority)) as Bot['onError']
    scopedBot.hook = hook as Bot['hook']
    // Flows registered at runtime through ctx.bot are unregistered with the plugin. Tracked by
    // id; an id the plugin unregisters itself is forgotten, so a later bot flow under the same
    // id survives the unplug. replaceFlow() is tracked only when it CREATES the flow.
    const pluginFlows = new Set<string>()
    scopedBot.registerFlow = (f) => {
      const id = bot.registerFlow(f)
      pluginFlows.add(id)
      return id
    }
    scopedBot.replaceFlow = (id, f) => {
      const created = !bot.hasFlow(id)
      bot.replaceFlow(id, f)
      if (created) pluginFlows.add(id)
    }
    scopedBot.unregisterFlow = (id) => {
      pluginFlows.delete(id)
      return bot.unregisterFlow(id)
    }
    disposables.push(() => {
      for (const id of pluginFlows) bot.unregisterFlow(id)
      pluginFlows.clear()
    })

    const ctx: PluginContext = {
      bot: scopedBot,
      logger: bot.logger.child({ plugin: spec.name }),
      tools: this.k.tools,
      config: config ?? {},
      onDispose: (fn: () => void) => disposables.push(fn),
    }
    const reportAsync = (result: unknown) => {
      if (isThenable(result)) result.then(undefined, (error: unknown) => this.k.events.error({ error }))
    }
    const disposeRegistrations = () => {
      while (disposables.length) {
        try { disposables.pop()!() } catch (error) { this.k.events.error({ error }) }
      }
    }

    // Counted before install() so a nested plugin may require its parent.
    this.pluggedNames.set(spec.name, (this.pluggedNames.get(spec.name) ?? 0) + 1)
    const unregisterName = () => {
      const left = (this.pluggedNames.get(spec.name) ?? 1) - 1
      if (left > 0) this.pluggedNames.set(spec.name, left)
      else this.pluggedNames.delete(spec.name)
    }
    try {
      reportAsync(spec.install(ctx, config))
    } catch (error) {
      disposeRegistrations()
      unregisterName()
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      unregisterName()
      if (spec.uninstall) {
        try { reportAsync(spec.uninstall(ctx)) } catch (error) { this.k.events.error({ error }) }
      }
      disposeRegistrations()
    }
  }
}
