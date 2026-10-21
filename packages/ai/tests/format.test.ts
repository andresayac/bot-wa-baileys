import { describe, it, expect } from 'vitest'
import { createTestBot } from '@botmesh/core/testing'
import { formatMarkdown, formatMarkdownStream } from '../src/format.js'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin, type AIPluginConfig } from '../src/plugin.js'

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const piece of it) out.push(piece)
  return out
}

async function* pieces(...xs: string[]): AsyncGenerator<string> {
  for (const x of xs) yield x
}

describe('formatMarkdown', () => {
  it('whatsapp: bold, italic, strike, headings, links, bullets', () => {
    const md = [
      '# Menú del día',
      'La **torta de chocolate** es *deliciosa* y ~~cara~~ __barata__.',
      '- Pan',
      '* Café',
      '+ Té',
      '1. Uno',
      'Mira [la carta](https://x.co/carta) o https://x.co',
      '---',
      '> cita',
    ].join('\n')
    expect(formatMarkdown(md, 'whatsapp')).toBe([
      '*Menú del día*',
      'La *torta de chocolate* es _deliciosa_ y ~cara~ *barata*.',
      '• Pan',
      '• Café',
      '• Té',
      '1. Uno',
      'Mira la carta (https://x.co/carta) o https://x.co',
      '',
      '> cita',
    ].join('\n'))
  })

  it('whatsapp: keeps snake_case words, code spans and fenced blocks untouched', () => {
    const md = 'Producto `torta_chocolate` y torta_chocolate. **Ojo**\n```\n**no** _tocar_\n```'
    expect(formatMarkdown(md, 'whatsapp')).toBe('Producto `torta_chocolate` y torta_chocolate. *Ojo*\n```\n**no** _tocar_\n```')
  })

  it('whatsapp: a link whose text is the url is shown once; images show their url', () => {
    expect(formatMarkdown('[https://a.co](https://a.co) ![logo](https://a.co/l.png)', 'whatsapp')).toBe('https://a.co https://a.co/l.png')
  })

  it('plain: strips every marker', () => {
    const md = '## Hola\n**negrita** *cursiva* ~~tachado~~ `code`\n- item\n[web](https://a.co)\n```js\nconst a = 1\n```'
    expect(formatMarkdown(md, 'plain')).toBe('Hola\nnegrita cursiva tachado code\n• item\nweb (https://a.co)\nconst a = 1')
  })

  it('html: escapes and maps a small subset', () => {
    const md = '# T\n**b** *i* ~~s~~ `c` <x> & [l](https://a.co?a=1&b=2)'
    expect(formatMarkdown(md, 'html')).toBe('<b>T</b>\n<b>b</b> <i>i</i> <s>s</s> <code>c</code> &lt;x&gt; &amp; <a href="https://a.co?a=1&amp;b=2">l</a>')
  })

  it('markdown: passes through', () => {
    const md = '**a** _b_ # c'
    expect(formatMarkdown(md, 'markdown')).toBe(md)
  })

  it('leaves text without markup unchanged', () => {
    expect(formatMarkdown('Hola, ¿qué tal? 2 * 3 = 6', 'whatsapp')).toBe('Hola, ¿qué tal? 2 * 3 = 6')
    expect(formatMarkdown('a_b_c y 5*3*2', 'plain')).toBe('a_b_c y 5*3*2')
  })
})

describe('formatMarkdownStream', () => {
  it('converts markers split across chunks and keeps everything', async () => {
    const out = await collect(formatMarkdownStream(pieces('Hola **to', 'rta** rica.\n- uno', '\n- dos'), 'whatsapp'))
    expect(out.join('')).toBe('Hola *torta* rica.\n• uno\n• dos')
  })

  it('emits complete lines early (does not wait for the end)', async () => {
    let releaseSecond!: () => void
    const gate = new Promise<void>((r) => { releaseSecond = r })
    async function* src(): AsyncGenerator<string> {
      yield '**Uno**\n'
      await gate
      yield 'dos'
    }
    const it = formatMarkdownStream(src(), 'whatsapp')[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.value).toBe('*Uno*\n')
    releaseSecond()
    const rest: string[] = []
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value)
    expect(rest.join('')).toBe('dos')
  })

  it('cuts a long line at a balanced space', async () => {
    const long = 'palabra '.repeat(40)
    const it = formatMarkdownStream(pieces(long + '**x'), 'whatsapp')[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.done).toBe(false)
    expect((first.value as string).length).toBeGreaterThan(100)
  })

  it('return() stops the source right away', async () => {
    let returned = false
    const source: AsyncIterableIterator<string> = {
      next: () => new Promise(() => { /* never resolves */ }),
      return: async () => { returned = true; return { done: true, value: undefined } },
      [Symbol.asyncIterator]() { return this },
    }
    const it = formatMarkdownStream(source, 'whatsapp')[Symbol.asyncIterator]()
    void it.next()
    await it.return?.()
    expect(returned).toBe(true)
  })
})

describe('aiPlugin formats replies for the channel (capabilities.textFormat)', () => {
  const md = '**Torta** de _chocolate_\n- uno\n[menú](https://x.co/m)'

  async function botWith(textFormat: 'whatsapp' | 'plain' | undefined, cfg: Partial<AIPluginConfig> = {}) {
    const { bot, chat } = await createTestBot({}, textFormat ? { provider: { textFormat } } : {})
    const mock = new MockAIProvider({ reply: md })
    bot.plug(aiPlugin({ __provider: mock, humanizeTyping: false, ...cfg }))
    return { bot, chat, mock }
  }

  it('WhatsApp gets *bold* and • bullets; the history keeps the original Markdown', async () => {
    const { chat, mock } = await botWith('whatsapp')
    await chat.send('hola')
    await chat.expectReply('*Torta* de _chocolate_\n• uno\nmenú (https://x.co/m)')
    await chat.send('otra')
    await chat.expectReply(/Torta/)
    expect(mock.calls[1]?.messages[1]).toEqual({ role: 'assistant', content: md })
  })

  it('plain channels get the markers stripped', async () => {
    const { chat } = await botWith('plain')
    await chat.send('hola')
    await chat.expectReply('Torta de chocolate\n• uno\nmenú (https://x.co/m)')
  })

  it('no textFormat declared, or format: false → sent as is; a forced format wins', async () => {
    const unknown = await botWith(undefined)
    await unknown.chat.send('hola')
    await unknown.chat.expectReply(md)
    const off = await botWith('whatsapp', { format: false })
    await off.chat.send('hola')
    await off.chat.expectReply(md)
    const forced = await botWith(undefined, { format: 'whatsapp' })
    await forced.chat.send('hola')
    await forced.chat.expectReply('*Torta* de _chocolate_\n• uno\nmenú (https://x.co/m)')
  })

  it('a per-chat format (provider textFormatFor) wins over capabilities.textFormat', async () => {
    // Twilio-like: WhatsApp chats get WhatsApp markup, SMS chats are plain.
    const textFormatFor = (chatId: string) => (chatId.startsWith('whatsapp:') ? 'whatsapp' as const : 'plain' as const)
    const { bot, provider } = await createTestBot({}, { provider: { textFormat: 'markdown', textFormatFor } })
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: md }), humanizeTyping: false }))
    const replyTo = async (from: string): Promise<string> => {
      provider.incoming('hola', { from })
      for (let i = 0; i < 100; i++) {
        const out = provider.outbox.find((m) => m.chatId === from)
        if (out?.content.kind === 'text') return out.content.text
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`no reply to ${from}`)
    }
    expect(await replyTo('whatsapp:+15550001')).toBe('*Torta* de _chocolate_\n• uno\nmenú (https://x.co/m)')
    expect(await replyTo('+15550002')).toBe('Torta de chocolate\n• uno\nmenú (https://x.co/m)')
  })

  it('streamed replies use the per-chat format too', async () => {
    const { bot, provider } = await createTestBot({}, { provider: { textFormatFor: () => 'whatsapp' } })
    bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: md }), humanizeTyping: false, stream: true }))
    provider.incoming('hola', { from: 'whatsapp:+15550001' })
    await new Promise((r) => setTimeout(r, 50))
    const sent = provider.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : '')).join('\n')
    expect(sent).toContain('*Torta* de _chocolate_')
    expect(sent).not.toContain('**')
  })

  it('streamed replies are formatted too', async () => {
    const { chat } = await botWith('whatsapp', { stream: true })
    await chat.send('hola')
    await new Promise((r) => setTimeout(r, 50))
    expect(chat.replies().join('\n')).toContain('*Torta* de _chocolate_')
    expect(chat.replies().join('\n')).not.toContain('**')
  })
})
