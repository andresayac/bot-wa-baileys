import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'

import { Bot } from '../src/core/Bot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { InboundEvent, IProvider, LoggerLike, MediaRef, PollVote } from '../src/core/provider.js'
import { defineBot, isBotFactory, isMainModule } from '../src/dev/defineBot.js'
import { DevProvider, DEV_BOT_ID } from '../src/dev/DevProvider.js'
import { DevSession, type DevSessionOptions } from '../src/dev/session.js'
import * as publicApi from '../src/index.js'
import * as devApi from '../src/dev/index.js'

const silent: LoggerLike = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }

/** A DevSession whose output is captured in memory, plus a poller for assertions. */
function harness(load: DevSessionOptions['load'], opts: Partial<DevSessionOptions> = {}) {
  const out: string[] = []
  const session = new DevSession({ load, write: (s) => { out.push(s) }, ...opts })
  const text = () => out.join('')
  async function until(pattern: string | RegExp, timeoutMs = 2000): Promise<void> {
    const ok = () => (typeof pattern === 'string' ? text().includes(pattern) : pattern.test(text()))
    const deadline = Date.now() + timeoutMs
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${String(pattern)}. Output:\n${text()}`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  return { session, out, text, until }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('defineBot / isMainModule', () => {
  it('returns the same factory, branded so tooling can recognise it', () => {
    const factory = (provider: IProvider) => new Bot({ provider, logger: silent })
    const defined = defineBot(factory)
    expect(defined).toBe(factory)
    expect(isBotFactory(defined)).toBe(true)
    expect(isBotFactory(() => undefined)).toBe(false)
    expect(isBotFactory({})).toBe(false)
  })

  it('rejects anything that is not a function', () => {
    expect(() => defineBot('nope' as never)).toThrow(TypeError)
  })

  it('isMainModule honours import.meta.main and falls back to process.argv[1]', () => {
    expect(isMainModule({ url: 'file:///x.js', main: true })).toBe(true)
    expect(isMainModule({ url: 'file:///x.js', main: false })).toBe(false)
    expect(isMainModule({ url: import.meta.url })).toBe(false)
    expect(isMainModule({ url: pathToFileURL(process.argv[1]!).href })).toBe(true)
    // Windows terminals may report a lowercase drive letter (c:\...) for the same file.
    const lowerDrive = process.argv[1]!.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
    expect(isMainModule({ url: pathToFileURL(lowerDrive).href })).toBe(true)
  })

  it('is exported from @bot-wa/core and the full simulator API from @bot-wa/core/dev', () => {
    expect(publicApi.defineBot).toBe(defineBot)
    expect(publicApi.isMainModule).toBe(isMainModule)
    expect(typeof devApi.DevSession).toBe('function')
    expect(typeof devApi.DevProvider).toBe('function')
    expect(typeof devApi.runCli).toBe('function')
    expect(typeof devApi.renderOutbound).toBe('function')
    expect(typeof devApi.parseDevInput).toBe('function')
  })
})

describe('DevProvider', () => {
  it('is a MockProvider that notifies outbound listeners with the send ref', async () => {
    const p = new DevProvider()
    expect(p).toBeInstanceOf(MockProvider)
    expect(p.selfId).toBe(DEV_BOT_ID)
    const seen: Array<{ chatId: string; id: string }> = []
    const off = p.onOutbound((m) => seen.push({ chatId: m.chatId, id: m.ref.id }))
    const res = await p.send('c1', { kind: 'text', text: 'hola' })
    off()
    await p.send('c1', { kind: 'text', text: 'again' })
    expect(seen).toEqual([{ chatId: 'c1', id: res.ref.id }])
    expect(p.outbox).toHaveLength(2)
  })

  it('injects media whose bytes come back from downloadMedia', async () => {
    const p = new DevProvider()
    const events: InboundEvent[] = []
    p.onEvent((e) => { events.push(e) })
    p.injectMedia({ chatId: 'g1', senderId: 'u1', isGroup: true, displayName: 'U', kind: 'image', data: new Uint8Array([1, 2, 3]), filename: 'cat.png', mimetype: 'image/png', caption: 'gato' })
    await sleep(0)
    const ev = events.find((e) => e.kind === 'message')
    expect(ev?.kind).toBe('message')
    if (ev?.kind !== 'message') return
    expect(ev.message).toMatchObject({ chatId: 'g1', senderId: 'u1', isGroup: true, type: 'image', body: 'gato' })
    expect(ev.message.media).toMatchObject({ kind: 'image', mimetype: 'image/png', filename: 'cat.png', size: 3 })
    const bytes = await p.downloadMedia(ev.message.media as MediaRef)
    expect([...bytes]).toEqual([1, 2, 3])
    expect((await p.downloadMedia({ kind: 'image', token: null })).length).toBe(0)
  })
})

describe('Bot.inspectConversation', () => {
  it('returns a read-only snapshot of the live conversation', async () => {
    const { bot, chat } = await createTestBot({ logger: silent })
    bot.use(flow('reg').ask('¿Nombre?', 'name').ask('¿Edad?', 'age').say('ok'))
    const target = { from: chat.jid, sender: chat.jid, isGroup: false }
    expect(bot.inspectConversation(target)).toBeUndefined()

    await chat.send('reg')
    await chat.expectReply('¿Nombre?')
    await chat.send('Ana')
    await chat.expectReply('¿Edad?')

    const snap = bot.inspectConversation(target)
    expect(snap).toMatchObject({ key: chat.jid, waiting: true, queued: 0, state: { name: 'Ana' } })
    snap!.state.name = 'mutated'
    expect(bot.inspectConversation(target)?.state.name).toBe('Ana')
    await bot.stop()
  })
})

describe('DevSession', () => {
  const greeter = defineBot((provider) => {
    const bot = new Bot({ provider, logger: silent })
    bot.when('hola', async (ctx) => { await ctx.reply('¡Hola! 👋') })
    bot.when('who', async (ctx) => { await ctx.reply(`${ctx.from}|${ctx.sender}|${ctx.isGroup}|${ctx.pushName}`) })
    bot.when('boom', async () => { throw new Error('kaboom') })
    bot.when('psst', async () => { await bot.sendText('someone-else', 'secreto') })
    bot.use(flow('registro').ask('¿Tu nombre?', 'name').ask('¿Tu edad?', 'age').say((_ctx, c) => `listo ${String(c.state.name)}`))
    return bot
  })

  it('prints bot replies to the simulated chat', async () => {
    const { session, until } = harness(async () => ({ default: greeter }))
    expect(await session.start()).toBe(true)
    expect(await session.handleLine('hola')).toBe('continue')
    await until('bot › ¡Hola! 👋\n')
    await session.stop()
  })

  it('runs flows end to end and shows captured state with :state', async () => {
    const { session, until, text } = harness(async () => ({ default: greeter }))
    await session.start()
    await session.handleLine(':state')
    await until('conversation: none')
    await session.handleLine('registro')
    await until('¿Tu nombre?')
    await session.handleLine('Ana')
    await until('¿Tu edad?')
    await session.handleLine(':state')
    await until('waiting for a reply')
    expect(text()).toContain("name: 'Ana'")
    expect(text()).toMatch(/you: "user" \(Dev User\) · DM/)
    expect(text()).toMatch(/bot: ready · reloads: 0/)
    await session.handleLine('30')
    await until('listo Ana')
    await session.stop()
  })

  it(':as and :group switch the simulated sender and chat', async () => {
    const { session, until } = harness(async () => ({ default: greeter }))
    await session.start()
    expect(session.prompt()).toBe('user › ')
    await session.handleLine(':group team')
    expect(session.prompt()).toBe('user @ team › ')
    await session.handleLine('who')
    await until('team|user|true|Dev User')
    await session.handleLine(':as alice Alice Smith')
    expect(session.prompt()).toBe('alice @ team › ')
    await session.handleLine('who')
    await until('team|alice|true|Alice Smith')
    await session.handleLine(':dm')
    expect(session.prompt()).toBe('alice › ')
    await session.handleLine('who')
    await until('alice|alice|false|Alice Smith')
    expect(session.identity).toEqual({ user: 'alice', name: 'Alice Smith', group: undefined })
    await session.stop()
  })

  it('labels messages the bot sends to other chats', async () => {
    const { session, until } = harness(async () => ({ default: greeter }))
    await session.start()
    await session.handleLine('psst')
    await until('bot → someone-else › secreto')
    await session.stop()
  })

  it('turns @mentions into mentions so groupMode "mentions" bots can be tested', async () => {
    const factory = defineBot((provider) => {
      const bot = new Bot({ provider, logger: silent, groupMode: 'mentions' })
      bot.onMessage(async (ctx) => { await ctx.reply(`heard ${ctx.mentions.join(',')}`) })
      return bot
    })
    const { session, text } = harness(async () => factory, { settleMs: 30 })
    await session.start()
    await session.handleLine(':group team')
    await session.handleLine('hola a todos')
    expect(text()).not.toContain('heard')
    await session.handleLine(`@${DEV_BOT_ID} hola`)
    expect(text()).toContain(`heard ${DEV_BOT_ID}`)
    await session.stop()
  })

  it(':media sends a file from disk as an inbound media message', async () => {
    const reads: string[] = []
    let downloaded: number[] = []
    const factory = defineBot((provider) => {
      const bot = new Bot({ provider, logger: silent })
      bot.onType('image', async (ctx) => {
        const bytes = await provider.downloadMedia!((ctx as unknown as { __mediaRef: MediaRef }).__mediaRef) as Buffer
        downloaded = [...bytes]
        await ctx.reply(`got ${ctx.type} "${ctx.body}"`)
      })
      return bot
    })
    const { session, until } = harness(async () => factory, {
      cwd: '/proj',
      readFile: async (p) => {
        reads.push(p.replace(/\\/g, '/'))
        if (p.replace(/\\/g, '/').endsWith('/proj/cat.png')) return new Uint8Array([7, 8])
        throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' })
      },
    })
    await session.start()
    await session.handleLine(':media image cat.png un gato')
    await until('got image "un gato"')
    expect(downloaded).toEqual([7, 8])
    expect(reads[0]).toMatch(/\/proj\/cat\.png$/)
    await session.handleLine(':media image missing.png')
    await until(/✖ .*missing\.png/)
    await session.stop()
  })

  it(':click taps a numbered button and votes on polls', async () => {
    const votes: PollVote[] = []
    const factory = defineBot((provider) => {
      const bot = new Bot({ provider, logger: silent })
      bot.when('menu', async (ctx) => { await ctx.buttons('Elige', [{ id: 'info', title: 'Info' }, { id: 'ping', title: 'Ping' }]) })
      bot.when('encuesta', async (ctx) => { await ctx.poll('¿Color?', ['Rojo', 'Azul']) })
      bot.on('poll', (vote) => { votes.push(vote) })
      bot.onMessage(async (ctx) => { if (ctx.interaction) await ctx.reply(`tap:${ctx.interaction.data}`) })
      return bot
    })
    const { session, until } = harness(async () => factory)
    await session.start()
    await session.handleLine(':click 1')
    await until('nothing to click')
    await session.handleLine('menu')
    await until('[2] Ping')
    await session.handleLine(':click 2')
    await until('tap:ping')
    await session.handleLine(':click info')
    await until('tap:info')
    await session.handleLine(':click 9')
    await until('no option 9')
    await session.handleLine('encuesta')
    await until('[2] Azul')
    await session.handleLine(':click Azul')
    for (let i = 0; i < 100 && votes.length === 0; i++) await sleep(5)
    expect(votes[0]).toMatchObject({ senderId: 'user' })
    expect(votes[0]!.options).toEqual([
      { name: 'Rojo', votes: 0, voters: [] },
      { name: 'Azul', votes: 1, voters: ['user'] },
    ])
    await session.stop()
  })

  it(':reset starts a fresh bot, dropping live conversations', async () => {
    const stopped: number[] = []
    let n = 0
    const factory = defineBot((provider) => {
      const id = ++n
      const bot = new Bot({ provider, logger: silent })
      bot.on('stopped', () => stopped.push(id))
      bot.use(flow('registro').ask('¿Tu nombre?', 'name').say('fin'))
      bot.onMessage(async (ctx) => { await ctx.reply(`fallback ${ctx.body}`) })
      return bot
    })
    const { session, until, text } = harness(async () => factory)
    await session.start()
    await session.handleLine('registro')
    await until('¿Tu nombre?')
    await session.handleLine(':reset')
    await until('fresh bot')
    await session.handleLine('Bob')
    await until('fallback Bob')
    expect(text()).not.toContain('fin')
    expect(stopped).toEqual([1])
    await session.stop()
    expect(stopped).toEqual([1, 2])
  })

  it('reload() swaps in the re-imported factory and stops the old bot', async () => {
    let version = 1
    const stopped: number[] = []
    const load = async () => {
      const v = version
      return {
        default: defineBot((provider) => {
          const bot = new Bot({ provider, logger: silent })
          bot.when('v', async (ctx) => { await ctx.reply(`v${v}`) })
          bot.on('stopped', () => stopped.push(v))
          return bot
        }),
      }
    }
    const { session, until } = harness(load)
    await session.start()
    await session.handleLine('v')
    await until('bot › v1')
    version = 2
    expect(await session.reload('bot.js changed')).toBe(true)
    await until('↻ reloaded (bot.js changed)')
    expect(session.reloads).toBe(1)
    expect(stopped).toEqual([1])
    await session.handleLine('v')
    await until('bot › v2')
    await session.stop()
  })

  it('a failed reload keeps the previous bot running', async () => {
    let fail = false
    const load = async () => {
      if (fail) throw new SyntaxError('Unexpected token }')
      return { default: defineBot((provider) => {
        const bot = new Bot({ provider, logger: silent })
        bot.when('v', async (ctx) => { await ctx.reply('still v1') })
        return bot
      }) }
    }
    const { session, until } = harness(load)
    await session.start()
    fail = true
    expect(await session.reload('bot.js changed')).toBe(false)
    await until('reload failed')
    await until('Unexpected token }')
    await until('keeping the previous version')
    await session.handleLine('v')
    await until('bot › still v1')
    await session.stop()
  })

  it('explains bad entries and keeps running so a fix can be reloaded', async () => {
    let mod: unknown = {}
    const { session, until } = harness(async () => mod)
    expect(await session.start()).toBe(false)
    await until('defineBot')
    await session.handleLine('hola')
    await until('not running')

    mod = { default: () => ({ nope: true }) }
    expect(await session.reload('fix')).toBe(false)
    await until('must return the Bot')

    mod = { default: greeter }
    expect(await session.reload('fix')).toBe(true)
    await session.handleLine('hola')
    await until('¡Hola! 👋')
    await session.stop()
  })

  it('refuses to start a bot that ignores the simulator provider', async () => {
    let created: Bot | undefined
    const factory = defineBot(() => {
      created = new Bot({ provider: new MockProvider(), logger: silent })
      return created
    })
    const { session, until } = harness(async () => factory)
    expect(await session.start()).toBe(false)
    await until('provider')
    expect(created!.getConnectionState()).toBe('closed')
    await session.stop()
  })

  it('prints handler errors instead of swallowing them', async () => {
    const { session, until } = harness(async () => ({ default: greeter }))
    await session.start()
    await session.handleLine('boom')
    await until(/✖ .*kaboom/)
    await session.stop()
  })

  it('echoes input and waits for replies when settleMs is set (non-TTY transcripts)', async () => {
    const { session, text } = harness(async () => ({ default: greeter }), { echo: true, settleMs: 30 })
    await session.start()
    await session.handleLine('hola')
    await session.handleLine('who')
    const t = text()
    const order = ['user › hola', 'bot › ¡Hola! 👋', 'user › who', 'bot › user|user|false|Dev User'].map((s) => t.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    await session.stop()
  })

  it(':help, unknown commands and :quit', async () => {
    const { session, until } = harness(async () => ({ default: greeter }))
    await session.start()
    await session.handleLine(':help')
    await until(':media <kind> <path>')
    await session.handleLine(':nope')
    await until('Unknown command :nope')
    expect(await session.handleLine(':quit')).toBe('quit')
    await session.stop()
  })
})
