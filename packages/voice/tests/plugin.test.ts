import { describe, expect, it } from 'vitest'
import { Bot, VOICE_NOTE, flow, type MessageContext } from '@bot-wa/core'
import { createTestBot, MockProvider } from '@bot-wa/core/testing'
import { voicePlugin, VoiceClient, VoiceConfigError, type SttAdapter, type TtsAdapter } from '../src/index.js'
import { makeOgg, recordingLogger, waitFor } from './helpers.js'

function fakeStt(text: string | ((n: number) => string) = 'hola'): SttAdapter & { calls: number } {
  const stt = {
    name: 'fake-stt',
    calls: 0,
    async transcribe() {
      stt.calls++
      return { text: typeof text === 'function' ? text(stt.calls) : text, provider: 'fake-stt' }
    },
  }
  return stt
}

function failingStt(): SttAdapter {
  return { name: 'broken', async transcribe() { throw new Error('boom') } }
}

function fakeTts(fail = false): TtsAdapter & { texts: string[] } {
  const texts: string[] = []
  return {
    name: 'fake-tts',
    texts,
    async synthesize(text) {
      if (fail) throw new Error('tts down')
      texts.push(text)
      return { buffer: Buffer.from(`audio:${text}`), mimetype: 'audio/ogg; codecs=opus', format: 'opus', provider: 'fake-tts' }
    },
  }
}

async function setup(config: Parameters<typeof voicePlugin>[0], audio = makeOgg(2)) {
  const { logger, logs } = recordingLogger()
  const t = await createTestBot({ logger })
  let downloads = 0
  t.provider.downloadMedia = async () => { downloads++; return audio }
  t.bot.plug(voicePlugin(config))
  const voiceNote = () => t.chat.send('', { type: 'voice' })
  return { ...t, logs, voiceNote, downloads: () => downloads }
}

describe('voicePlugin — autoTranscribe', () => {
  it('writes the transcript into ctx.body so text triggers match voice notes', async () => {
    const { bot, chat, voiceNote } = await setup({ stt: fakeStt('¡Hola!') })
    bot.when('hola', (ctx) => ctx.reply(`texto:${ctx.body}|${ctx.transcript}|${ctx.type}`))

    await voiceNote()
    await chat.expectReply('texto:Hola|¡Hola!|voice')
    await bot.stop()
  })

  it('keeps VOICE_NOTE triggers working and populates ctx.media', async () => {
    const audio = makeOgg(1.5)
    const { bot, chat, voiceNote, downloads } = await setup({ stt: fakeStt('algo largo que no matchea') }, audio)
    bot.when(VOICE_NOTE, (ctx) => ctx.reply(`nota:${ctx.transcript}:${ctx.media?.buffer.length}`))

    await voiceNote()
    await chat.expectReply(`nota:algo largo que no matchea:${audio.length}`)
    // ctx.media was loaded once and reused.
    expect(downloads()).toBe(1)
    await bot.stop()
  })

  it('does not touch text messages or non-configured types', async () => {
    const stt = fakeStt()
    const { bot, chat, provider } = await setup({ stt })
    bot.onMessage((ctx) => ctx.reply(`${ctx.type}:${ctx.body}:${ctx.transcript ?? '-'}`))

    await chat.send('texto normal')
    await chat.expectReply('text:texto normal:-')
    provider.incoming('', { from: chat.jid, type: 'audio' })
    await chat.expectReply('audio::-')
    expect(stt.calls).toBe(0)
    await bot.stop()
  })

  it('types: ["voice", "audio"] also transcribes audio files; setBody:false keeps the body', async () => {
    const { bot, chat, provider } = await setup({ stt: fakeStt('hola'), autoTranscribe: { types: ['voice', 'audio'], setBody: false } })
    bot.onMessage((ctx) => ctx.reply(`${ctx.type}:[${ctx.body}]:${ctx.transcript}`))

    provider.incoming('', { from: chat.jid, type: 'audio' })
    await chat.expectReply('audio:[]:hola')
    await bot.stop()
  })

  it('asText:true rewrites ctx.type so text-only handlers answer audio', async () => {
    const { bot, chat, voiceNote } = await setup({ stt: fakeStt('pregunta'), autoTranscribe: { asText: true } })
    bot.onMessage((ctx) => { if (ctx.type === 'text') return ctx.reply(`ai:${ctx.body}`) })

    await voiceNote()
    await chat.expectReply('ai:pregunta')
    await bot.stop()
  })

  it('feeds c.ask() answers from voice notes inside flows', async () => {
    const { bot, chat, voiceNote } = await setup({ stt: fakeStt((n) => (n === 1 ? 'pedido' : 'Bogotá')) })
    bot.use(
      flow('pedido')
        .ask('¿Ciudad?', 'ciudad')
        .say((_ctx, c) => `Envío a ${String(c.state.ciudad)}`),
    )

    await voiceNote()
    await chat.expectReply('¿Ciudad?')
    await voiceNote()
    await chat.expectReply('Envío a Bogotá')
    await bot.stop()
  })

  it('asText:false keeps ctx.type even inside a conversation (c.ask rejects the voice note)', async () => {
    const { bot, chat, voiceNote } = await setup({ stt: fakeStt((n) => (n === 1 ? 'pedido' : 'Bogotá')), autoTranscribe: { asText: false } })
    bot.use(flow('pedido').ask('¿Ciudad?', 'ciudad', { otherwise: 'solo texto' }))

    await voiceNote()
    await chat.expectReply('¿Ciudad?')
    await voiceNote()
    await chat.expectReply('solo texto')
    await bot.stop()
  })

  it('trimPunctuation:false keeps the raw transcript as body', async () => {
    const { bot, chat, voiceNote } = await setup({ stt: fakeStt('¿Sí?'), autoTranscribe: { trimPunctuation: false } })
    bot.when(VOICE_NOTE, (ctx) => ctx.reply(`body:${ctx.body}`))

    await voiceNote()
    await chat.expectReply('body:¿Sí?')
    await bot.stop()
  })

  it('a failed transcription still routes the message and exposes transcriptError', async () => {
    const { bot, chat, voiceNote, logs } = await setup({ stt: failingStt() })
    bot.when(VOICE_NOTE, (ctx) => ctx.reply(`sin texto:${ctx.transcript === undefined}:${(ctx.transcriptError as Error).message}`))

    await voiceNote()
    await chat.expectReply('sin texto:true:boom')
    expect(logs.some((l) => l.level === 'warn' && l.args.includes('voice transcription failed'))).toBe(true)
    await bot.stop()
  })

  it('limits apply: an over-long voice note is not sent to the STT service', async () => {
    const stt = fakeStt()
    const errors: unknown[] = []
    const { bot, chat, voiceNote } = await setup(
      { stt, limits: { maxDurationSec: 60 }, autoTranscribe: { onError: (e) => { errors.push(e) } } },
      makeOgg(61),
    )
    bot.when(VOICE_NOTE, (ctx) => ctx.reply('demasiado largo'))

    await voiceNote()
    await chat.expectReply('demasiado largo')
    expect(stt.calls).toBe(0)
    expect(errors[0]).toMatchObject({ code: 'AUDIO_TOO_LONG' })
    await bot.stop()
  })

  it('filter can skip messages (e.g. groups)', async () => {
    const stt = fakeStt()
    const { bot, chat, provider } = await setup({ stt, autoTranscribe: { filter: (ctx) => !ctx.isGroup } })
    bot.onMessage((ctx) => ctx.reply(`${ctx.isGroup}:${ctx.transcript ?? '-'}`))

    provider.incoming('', { from: chat.jid, type: 'voice', isGroup: true })
    await chat.expectReply('true:-')
    expect(stt.calls).toBe(0)
    await bot.stop()
  })

  it('autoTranscribe:false disables the hook; the tool still works on demand', async () => {
    const stt = fakeStt('manual')
    const { bot, chat, voiceNote } = await setup({ stt, autoTranscribe: false })
    bot.when(VOICE_NOTE, async (ctx) => {
      const before = ctx.transcript
      const text = await ctx.tools.voice.transcribe(ctx)
      await ctx.reply(`${String(before)}->${text}`)
    })

    await voiceNote()
    await chat.expectReply('undefined->manual')
    expect(stt.calls).toBe(1)
    await bot.stop()
  })
})

describe('voicePlugin — ctx.tools.voice', () => {
  it('injects a VoiceClient and removes it on unplug', async () => {
    const { bot } = await createTestBot()
    const unplug = bot.plug(voicePlugin({ tts: fakeTts() }))
    expect(bot.injectTools.voice).toBeInstanceOf(VoiceClient)
    unplug()
    expect('voice' in bot.injectTools).toBe(false)
    await bot.stop()
  })

  it('synthesize + ctx.voice sends a voice note (manual path from FEATURES #16)', async () => {
    const { bot, chat, provider } = await createTestBot()
    bot.plug(voicePlugin({ stt: fakeStt('hola'), tts: fakeTts() }))
    provider.downloadMedia = async () => makeOgg(1)
    bot.when(VOICE_NOTE, async (ctx: MessageContext) => {
      await ctx.reply(`Dijiste: ${ctx.transcript}`)
      await ctx.voice(await ctx.tools.voice.synthesize('¡Entendido!'))
      await ctx.tools.voice.speak(ctx, 'Chao')
    })

    await chat.send('', { type: 'voice' })
    await chat.expectReply('Dijiste: hola')
    await waitFor(() => provider.outbox.length === 3)
    expect(provider.outbox.map((m) => m.content)).toEqual([
      { kind: 'text', text: 'Dijiste: hola' },
      { kind: 'voice', media: Buffer.from('audio:¡Entendido!') },
      { kind: 'voice', media: Buffer.from('audio:Chao') },
    ])
    await bot.stop()
  })

  it('also works with the plug(factory, config) form', async () => {
    const { bot } = await createTestBot()
    bot.plug(voicePlugin as never, { tts: fakeTts() })
    expect(bot.injectTools.voice).toBeInstanceOf(VoiceClient)
    await bot.stop()
  })
})

describe('voicePlugin — autoReplyWithVoice', () => {
  it('answers a voice note with a voice note; a text message switches the chat back to text', async () => {
    const tts = fakeTts()
    const { bot, chat, provider, voiceNote } = await setup({ stt: fakeStt('hola'), tts, autoReplyWithVoice: true })
    bot.onMessage((ctx) => ctx.reply(`eco:${ctx.body}`))

    await voiceNote()
    await waitFor(() => provider.outbox.length === 1)
    expect(provider.outbox[0]!.content).toEqual({ kind: 'voice', media: Buffer.from('audio:eco:hola') })

    await chat.send('ahora escribo')
    await chat.expectReply('eco:ahora escribo')
    expect(provider.outbox[1]!.content).toEqual({ kind: 'text', text: 'eco:ahora escribo' })
    expect(tts.texts).toEqual(['eco:hola'])
    await bot.stop()
  })

  it('only converts text, honours maxChars and leaves other chats alone', async () => {
    const { bot, chat, provider, voiceNote } = await setup({ stt: fakeStt('hola'), tts: fakeTts(), autoReplyWithVoice: { maxChars: 10 } })
    bot.onMessage(async (ctx) => {
      await ctx.reply('corto')
      await ctx.reply('un texto demasiado largo para voz')
      await ctx.photo('https://example.com/x.png', 'foto')
    })

    await voiceNote()
    await waitFor(() => provider.outbox.length === 3)
    expect(provider.outbox.map((m) => m.content.kind)).toEqual(['voice', 'text', 'image'])

    await bot.send('otro-chat', { kind: 'text', text: 'hola' })
    expect(provider.outbox[3]!.content).toEqual({ kind: 'text', text: 'hola' })
    await bot.stop()
  })

  it('alsoText sends the voice note followed by the text', async () => {
    const { bot, provider, voiceNote } = await setup({ stt: fakeStt('hola'), tts: fakeTts(), autoReplyWithVoice: { alsoText: true } })
    bot.onMessage((ctx) => ctx.reply('respuesta'))

    await voiceNote()
    await waitFor(() => provider.outbox.length === 2)
    expect(provider.outbox.map((m) => m.content)).toEqual([
      { kind: 'voice', media: Buffer.from('audio:respuesta') },
      { kind: 'text', text: 'respuesta' },
    ])
    await bot.stop()
  })

  it('falls back to text when synthesis fails', async () => {
    const { bot, chat, voiceNote, logs } = await setup({ stt: fakeStt('hola'), tts: fakeTts(true), autoReplyWithVoice: true })
    bot.onMessage((ctx) => ctx.reply('en texto'))

    await voiceNote()
    await chat.expectReply('en texto')
    expect(logs.some((l) => l.level === 'warn' && l.args.includes('voice reply synthesis failed; sending text'))).toBe(true)
    await bot.stop()
  })

  it('keeps text when the provider cannot send voice notes', async () => {
    class NoVoiceProvider extends MockProvider {
      override readonly capabilities = { ...new MockProvider().capabilities, contentKinds: ['text'] as const }
    }
    const provider = new NoVoiceProvider()
    provider.downloadMedia = async () => makeOgg(1)
    const bot = new Bot({ provider, logger: recordingLogger().logger })
    await bot.start()
    const tts = fakeTts()
    bot.plug(voicePlugin({ stt: fakeStt('hola'), tts, autoReplyWithVoice: true }))
    bot.onMessage((ctx) => ctx.reply('solo texto'))

    provider.incoming('', { from: 'u', type: 'voice' })
    await waitFor(() => provider.outbox.length === 1)
    expect(provider.outbox[0]!.content).toEqual({ kind: 'text', text: 'solo texto' })
    expect(tts.texts).toEqual([])
    await bot.stop()
  })
})

describe('voicePlugin — install', () => {
  it('rejects contradictory config synchronously', async () => {
    const { bot } = await createTestBot()
    expect(() => bot.plug(voicePlugin({ autoTranscribe: true }))).toThrow(VoiceConfigError)
    expect(() => bot.plug(voicePlugin({ stt: fakeStt(), autoReplyWithVoice: true }))).toThrow(VoiceConfigError)
    await bot.stop()
  })

  it('never throws on a bad provider spec: it logs at warmup and fails per call', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const { bot, chat, logs, voiceNote } = await setup({ stt: { provider: 'openai' } })
      bot.when(VOICE_NOTE, (ctx) => ctx.reply(`error:${(ctx.transcriptError as Error).name}`))

      await waitFor(() => logs.some((l) => l.level === 'error' && l.args.includes('voice adapters failed to resolve')))
      await voiceNote()
      await chat.expectReply('error:VoiceConfigError')
      await bot.stop()
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved
    }
  })
})
