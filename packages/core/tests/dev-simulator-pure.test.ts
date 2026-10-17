import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { renderOutbound, describeMedia, formatMessage } from '../src/dev/render.js'
import { parseDevInput, DEV_HELP } from '../src/dev/commands.js'
import { propagateVersion, RELOAD_PARAM } from '../src/dev/reloadHooks.js'
import { checkTypeScriptSupport, resolveBotFactory, createEntryLoader, explainLoadError, DevEntryError } from '../src/dev/loader.js'
import { isReloadRelevant, watchForChanges } from '../src/dev/watch.js'
import { defineBot } from '../src/dev/defineBot.js'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'

describe('dev simulator · renderOutbound', () => {
  it('renders plain text as-is with no choices', () => {
    expect(renderOutbound({ kind: 'text', text: 'hola\nmundo' })).toEqual({ text: 'hola\nmundo', choices: [] })
  })

  it('renders media as placeholders with the caption on the next line', () => {
    expect(renderOutbound({ kind: 'image', media: 'https://x.test/cat.png', caption: 'gato' }).text)
      .toBe('[image: https://x.test/cat.png]\ngato')
    expect(renderOutbound({ kind: 'video', media: { path: './clip.mp4' } }).text).toBe('[video: ./clip.mp4]')
    expect(renderOutbound({ kind: 'audio', media: { url: 'https://x.test/a.mp3' } }).text).toBe('[audio: https://x.test/a.mp3]')
    expect(renderOutbound({ kind: 'voice', media: Buffer.alloc(2048) }).text).toBe('[voice note: <2.0 KB buffer>]')
    expect(renderOutbound({ kind: 'document', media: './f.pdf', filename: 'factura.pdf', caption: 'tu factura' }).text)
      .toBe('[document: factura.pdf · ./f.pdf]\ntu factura')
    expect(renderOutbound({ kind: 'sticker', media: { buffer: Buffer.alloc(10) } }).text).toBe('[sticker: <10 B buffer>]')
  })

  it('renders location, contact, reaction, template and native kinds', () => {
    expect(renderOutbound({ kind: 'location', lat: 4.71, lng: -74.07, name: 'Bogotá', address: 'Cra 7' }).text)
      .toBe('[location: 4.71, -74.07 · Bogotá]\nCra 7')
    expect(renderOutbound({ kind: 'contact', phone: '+573001112233', displayName: 'Ana' }).text).toBe('[contact: Ana · +573001112233]')
    expect(renderOutbound({ kind: 'reaction', emoji: '👍', target: { id: 'm1', chatId: 'c' } }).text).toBe('[reaction: 👍]')
    expect(renderOutbound({ kind: 'template', name: 'promo', language: 'es' }).text).toBe('[template: promo · es]')
    expect(renderOutbound({ kind: 'native', provider: 'discord', payload: {} }).text).toBe('[native payload for discord]')
  })

  it('renders buttons as numbered choices that :click can resolve', () => {
    const r = renderOutbound({
      kind: 'buttons',
      text: 'Elige',
      footer: 'pie',
      buttons: [{ id: 'info', title: 'Info' }, { id: 'web', title: 'Web', url: 'https://x.test' }],
    })
    expect(r.text).toBe('Elige\n  [1] Info\n  [2] Web → https://x.test\npie\n(:click <n> to choose)')
    expect(r.choices).toEqual([
      { n: 1, label: 'Info', value: 'info' },
      { n: 2, label: 'Web', value: 'web', url: 'https://x.test' },
    ])
    expect(r.interactive).toBe('buttons')
  })

  it('renders lists with sections and continuous numbering', () => {
    const r = renderOutbound({
      kind: 'list',
      text: 'Menú',
      buttonText: 'Ver opciones',
      sections: [
        { title: 'Bebidas', rows: [{ id: 'cafe', title: 'Café', description: 'caliente' }] },
        { rows: [{ id: 'te', title: 'Té' }] },
      ],
    })
    expect(r.text).toBe('Menú\n  ≡ Ver opciones\n  Bebidas\n  [1] Café — caliente\n  [2] Té\n(:click <n> to choose)')
    expect(r.choices.map((c) => c.value)).toEqual(['cafe', 'te'])
    expect(r.interactive).toBe('list')
  })

  it('renders polls as numbered options and cards with their buttons', () => {
    const poll = renderOutbound({ kind: 'poll', question: '¿Color?', options: ['Rojo', 'Azul'], multiSelect: true })
    expect(poll.text).toBe('[poll · multiple choice] ¿Color?\n  [1] Rojo\n  [2] Azul\n(:click <n> to vote)')
    expect(poll.choices).toEqual([{ n: 1, label: 'Rojo', value: 'Rojo' }, { n: 2, label: 'Azul', value: 'Azul' }])
    expect(poll.interactive).toBe('poll')

    const card = renderOutbound({ kind: 'card', title: 'Plan', body: 'Pro', imageUrl: 'https://x.test/p.png', buttons: [{ id: 'buy', title: 'Comprar' }] })
    expect(card.text).toBe('[card] Plan\nPro\n[image: https://x.test/p.png]\n  [1] Comprar\n(:click <n> to choose)')
    expect(card.interactive).toBe('card')
  })

  it('describes every media source shape without dumping bytes', () => {
    expect(describeMedia('data:image/png;base64,AAAA')).toBe('<data URI, 26 chars>')
    expect(describeMedia({ stream: new EventEmitter() as unknown as NodeJS.ReadableStream })).toBe('<stream>')
    expect(describeMedia({ native: { file_id: 'x' } })).toBe('<native media>')
    expect(describeMedia(Buffer.alloc(3 * 1024 * 1024))).toBe('<3.0 MB buffer>')
    expect(describeMedia('x'.repeat(200))).toMatch(/^x{80}…$/)
  })

  it('formatMessage aligns continuation lines under the label', () => {
    expect(formatMessage('bot › ', 'uno\ndos')).toBe('bot › uno\n      dos\n')
    expect(formatMessage('bot › ', '')).toBe('bot › \n')
  })
})

describe('dev simulator · parseDevInput', () => {
  it('treats plain lines as messages (trimmed) and blank lines as empty', () => {
    expect(parseDevInput('  hola  ')).toEqual({ kind: 'message', text: 'hola' })
    expect(parseDevInput('   ')).toEqual({ kind: 'empty' })
    expect(parseDevInput('/reset')).toEqual({ kind: 'message', text: '/reset' })
  })

  it('does not mistake emoticons or escaped colons for commands', () => {
    expect(parseDevInput(':)')).toEqual({ kind: 'message', text: ':)' })
    expect(parseDevInput('::hola')).toEqual({ kind: 'message', text: ':hola' })
  })

  it('parses identity commands', () => {
    expect(parseDevInput(':as alice')).toEqual({ kind: 'as', user: 'alice' })
    expect(parseDevInput(':AS alice Alice Smith')).toEqual({ kind: 'as', user: 'alice', name: 'Alice Smith' })
    expect(parseDevInput(':group team')).toEqual({ kind: 'group', id: 'team' })
    expect(parseDevInput(':dm')).toEqual({ kind: 'dm' })
    expect(parseDevInput(':as')).toMatchObject({ kind: 'invalid', message: expect.stringContaining(':as <user>') })
    expect(parseDevInput(':group')).toMatchObject({ kind: 'invalid', message: expect.stringContaining(':group <id>') })
  })

  it('parses :media with kind aliases, quoted paths and a caption', () => {
    expect(parseDevInput(':media image ./cat.png hola  gato')).toEqual({ kind: 'media', mediaKind: 'image', path: './cat.png', caption: 'hola  gato' })
    expect(parseDevInput(':media photo "my cat.png"')).toEqual({ kind: 'media', mediaKind: 'image', path: 'my cat.png' })
    expect(parseDevInput(":media doc 'a b.pdf' factura")).toEqual({ kind: 'media', mediaKind: 'document', path: 'a b.pdf', caption: 'factura' })
    expect(parseDevInput(':media gif x.gif')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('image, video, audio, voice, document, sticker') })
    expect(parseDevInput(':media image')).toMatchObject({ kind: 'invalid' })
  })

  it('parses the remaining commands and their aliases', () => {
    expect(parseDevInput(':click 2')).toEqual({ kind: 'click', target: '2' })
    expect(parseDevInput(':click')).toMatchObject({ kind: 'invalid' })
    expect(parseDevInput(':reset')).toEqual({ kind: 'reset' })
    expect(parseDevInput(':reload')).toEqual({ kind: 'reload' })
    expect(parseDevInput(':state')).toEqual({ kind: 'state' })
    for (const h of [':help', ':h', ':?']) expect(parseDevInput(h)).toEqual({ kind: 'help' })
    for (const q of [':quit', ':q', ':exit']) expect(parseDevInput(q)).toEqual({ kind: 'quit' })
    expect(parseDevInput(':foo bar')).toEqual({ kind: 'invalid', message: 'Unknown command :foo — type :help' })
  })

  it('documents every command in the help text', () => {
    for (const cmd of [':as', ':group', ':dm', ':media', ':click', ':reset', ':reload', ':state', ':help', ':quit']) {
      expect(DEV_HELP).toContain(cmd)
    }
  })
})

describe('dev simulator · reload hooks (propagateVersion)', () => {
  const parent = `file:///proj/src/bot.js?${RELOAD_PARAM}=3`

  it('copies the parent version onto relative imports', () => {
    expect(propagateVersion('./flows/menu.js', 'file:///proj/src/flows/menu.js', parent))
      .toBe(`file:///proj/src/flows/menu.js?${RELOAD_PARAM}=3`)
    expect(propagateVersion('../shared/x.ts', 'file:///proj/shared/x.ts', parent))
      .toBe(`file:///proj/shared/x.ts?${RELOAD_PARAM}=3`)
  })

  it('leaves packages, node_modules, non-file URLs and unversioned parents alone', () => {
    expect(propagateVersion('@bot-wa/core', 'file:///proj/packages/core/lib/index.js', parent)).toBe('file:///proj/packages/core/lib/index.js')
    expect(propagateVersion('./x.js', 'file:///proj/node_modules/x/x.js', parent)).toBe('file:///proj/node_modules/x/x.js')
    expect(propagateVersion('node:fs', 'node:fs', parent)).toBe('node:fs')
    expect(propagateVersion('./x.js', 'file:///proj/src/x.js', 'file:///proj/src/bot.js')).toBe('file:///proj/src/x.js')
    expect(propagateVersion('./x.js', 'file:///proj/src/x.js', undefined)).toBe('file:///proj/src/x.js')
  })

  it('replaces a stale version on an already-versioned URL', () => {
    expect(propagateVersion('./x.js', `file:///proj/src/x.js?${RELOAD_PARAM}=1`, parent)).toBe(`file:///proj/src/x.js?${RELOAD_PARAM}=3`)
  })
})

describe('dev simulator · loader helpers', () => {
  it('checkTypeScriptSupport is silent for JS and for Node with type stripping', () => {
    expect(checkTypeScriptSupport('src/bot.js', { typescript: false, nodeVersion: '22.0.0' })).toBeUndefined()
    expect(checkTypeScriptSupport('src/bot.ts', { typescript: 'strip', nodeVersion: '22.18.0' })).toBeUndefined()
    expect(checkTypeScriptSupport('src/bot.mts', { typescript: 'transform', nodeVersion: '24.0.0' })).toBeUndefined()
  })

  it('checkTypeScriptSupport explains how to enable type stripping', () => {
    const hint = checkTypeScriptSupport('src/bot.ts', { typescript: false, nodeVersion: '22.11.0' })
    expect(hint).toContain('TypeScript')
    expect(hint).toContain('22.18')
    expect(hint).toContain('NODE_OPTIONS=--experimental-strip-types')

    const old = checkTypeScriptSupport('src/bot.cts', { typescript: undefined, nodeVersion: '22.3.0' })
    expect(old).toContain('Upgrade')
    expect(old).not.toContain('NODE_OPTIONS')

    expect(checkTypeScriptSupport('src/bot.tsx', { typescript: 'strip', nodeVersion: '24.0.0' })).toContain('TSX')
  })

  it('resolveBotFactory accepts a factory or a module whose default export is one', () => {
    const factory = defineBot((provider) => new Bot({ provider }))
    expect(resolveBotFactory(factory)).toBe(factory)
    expect(resolveBotFactory({ default: factory })).toBe(factory)
    const plain = (provider: MockProvider) => new Bot({ provider })
    expect(resolveBotFactory({ default: plain })).toBe(plain)
  })

  it('resolveBotFactory rejects other shapes with actionable DevEntryErrors', () => {
    expect(() => resolveBotFactory({})).toThrow(DevEntryError)
    expect(() => resolveBotFactory({})).toThrow(/defineBot/)
    const bot = new Bot({ provider: new MockProvider() })
    expect(() => resolveBotFactory({ default: bot })).toThrow(/Bot instance/)
    expect(() => resolveBotFactory(undefined)).toThrow(DevEntryError)
  })

  it('createEntryLoader re-imports the entry with an increasing cache-busting query', async () => {
    const urls: string[] = []
    const load = createEntryLoader('/proj/src/bot.js', { importModule: async (url) => { urls.push(url); return { default: urls.length } } })
    expect(await load()).toEqual({ default: 1 })
    expect(await load()).toEqual({ default: 2 })
    expect(urls[0]).toMatch(new RegExp(`^file:///.*bot\\.js\\?${RELOAD_PARAM}=1$`))
    expect(urls[1]).toMatch(new RegExp(`\\?${RELOAD_PARAM}=2$`))
  })

  it('explainLoadError adds a hint for TypeScript resolution failures only', () => {
    const notFound = Object.assign(new Error("Cannot find module '/p/src/flows.js'"), { code: 'ERR_MODULE_NOT_FOUND' })
    const explained = explainLoadError(notFound, '/p/src/bot.ts')
    expect(explained).toBeInstanceOf(DevEntryError)
    expect((explained as Error).message).toContain('.ts extension')
    expect((explained as Error).cause).toBe(notFound)
    expect(explainLoadError(notFound, '/p/src/bot.js')).toBe(notFound)
    const other = new SyntaxError('Unexpected token')
    expect(explainLoadError(other, '/p/src/bot.ts')).toBe(other)
  })
})

describe('dev simulator · watcher', () => {
  it('isReloadRelevant only reacts to source files outside ignored folders', () => {
    expect(isReloadRelevant('bot.js')).toBe(true)
    expect(isReloadRelevant('flows\\menu.ts')).toBe(true)
    expect(isReloadRelevant('a/b.mjs')).toBe(true)
    expect(isReloadRelevant(null)).toBe(true)
    expect(isReloadRelevant('node_modules/x/index.js')).toBe(false)
    expect(isReloadRelevant('.git/index')).toBe(false)
    expect(isReloadRelevant('.cache/x.js')).toBe(false)
    expect(isReloadRelevant('sessions/creds.js')).toBe(false)
    expect(isReloadRelevant('store.json')).toBe(false)
    expect(isReloadRelevant('README.md')).toBe(false)
    expect(isReloadRelevant('.env')).toBe(false)
  })

  it('watchForChanges debounces bursts of relevant events into one callback', async () => {
    vi.useFakeTimers()
    try {
      const fake = new EventEmitter() as EventEmitter & { close(): void }
      let listener: ((event: string, file: string | null) => void) | undefined
      let closed = false
      fake.close = () => { closed = true }
      const calls: string[][] = []
      const watcher = watchForChanges('/proj/src', (files) => calls.push(files), {
        debounceMs: 50,
        watch: (_dir, _opts, l) => { listener = l; return fake },
      })
      listener!('change', 'bot.js')
      listener!('change', 'bot.js')
      listener!('rename', 'flows\\menu.js')
      listener!('change', 'store.json')
      await vi.advanceTimersByTimeAsync(49)
      expect(calls).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toEqual([['bot.js', 'flows/menu.js']])
      fake.emit('error', new Error('EPERM')) // must not throw
      watcher.close()
      expect(closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
