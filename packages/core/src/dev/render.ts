/**
 * Pure rendering helpers for `bot-wa dev`: turn an {@link OutboundContent}
 * into terminal text. Media becomes a `[kind: source]` placeholder; buttons,
 * lists, cards and polls become numbered choices the user can pick with
 * `:click <n>`. No I/O, no colours — the session decides how to print.
 */

import type { MediaSource, OutboundContent } from '../core/provider.js'

/** One numbered option of an interactive message. */
export interface DevChoice {
  /** 1-based number shown in the terminal. */
  n: number
  /** Visible label. */
  label: string
  /** What a tap sends: the button/row id, or the option text for polls. */
  value: string
  /** Link target for URL buttons. */
  url?: string
}

/** Kinds of interactive outbound messages `:click` can act on. */
export type DevInteractiveKind = 'buttons' | 'list' | 'card' | 'poll'

/** Terminal rendering of one outbound message. */
export interface RenderedOutbound {
  /** Multi-line text, without the `bot ›` label. */
  text: string
  /** Numbered choices (empty for non-interactive content). */
  choices: DevChoice[]
  /** Set when the message offers choices `:click` can pick. */
  interactive?: DevInteractiveKind
}

const CLICK_HINT = '(:click <n> to choose)'
const VOTE_HINT = '(:click <n> to vote)'
const MAX_SOURCE_CHARS = 80

/** Human-readable byte size: `512 B`, `2.0 KB`, `3.0 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Describe a media source without dumping its bytes (URL/path, or a size for buffers). */
export function describeMedia(source: MediaSource): string {
  if (typeof source === 'string') {
    if (source.startsWith('data:')) return `<data URI, ${source.length} chars>`
    return source.length > MAX_SOURCE_CHARS ? `${source.slice(0, MAX_SOURCE_CHARS)}…` : source
  }
  if (source instanceof Uint8Array) return `<${formatBytes(source.byteLength)} buffer>`
  if ('url' in source) return describeMedia(source.url)
  if ('path' in source) return describeMedia(source.path)
  if ('buffer' in source) return `<${formatBytes(source.buffer.byteLength)} buffer>`
  if ('stream' in source) return '<stream>'
  return '<native media>'
}

function numbered(choices: DevChoice[]): string[] {
  return choices.map((c) => `  [${c.n}] ${c.label}${c.url ? ` → ${c.url}` : ''}`)
}

function withCaption(head: string, caption?: string): string {
  return caption ? `${head}\n${caption}` : head
}

/** Render one outbound message for the terminal. Pure. */
export function renderOutbound(content: OutboundContent): RenderedOutbound {
  switch (content.kind) {
    case 'text':
      return { text: content.text, choices: [] }
    case 'image':
    case 'video':
    case 'sticker':
      return { text: withCaption(`[${content.kind}: ${describeMedia(content.media)}]`, 'caption' in content ? content.caption : undefined), choices: [] }
    case 'audio':
      return { text: `[audio: ${describeMedia(content.media)}]`, choices: [] }
    case 'voice':
      return { text: `[voice note: ${describeMedia(content.media)}]`, choices: [] }
    case 'document': {
      const name = content.filename ? `${content.filename} · ` : ''
      return { text: withCaption(`[document: ${name}${describeMedia(content.media)}]`, content.caption), choices: [] }
    }
    case 'location': {
      const name = content.name ? ` · ${content.name}` : ''
      return { text: withCaption(`[location: ${content.lat}, ${content.lng}${name}]`, content.address), choices: [] }
    }
    case 'contact':
      return { text: `[contact: ${content.displayName ? `${content.displayName} · ` : ''}${content.phone}]`, choices: [] }
    case 'reaction':
      return { text: `[reaction: ${content.emoji}]`, choices: [] }
    case 'poll': {
      const choices = content.options.map((option, i) => ({ n: i + 1, label: option, value: option }))
      const head = `[poll${content.multiSelect ? ' · multiple choice' : ''}] ${content.question}`
      return { text: [head, ...numbered(choices), VOTE_HINT].join('\n'), choices, interactive: 'poll' }
    }
    case 'buttons': {
      const choices = content.buttons.map((b, i) => toChoice(i + 1, b.title, b.id, b.url))
      const lines = [content.text, ...numbered(choices)]
      if (content.footer) lines.push(content.footer)
      lines.push(CLICK_HINT)
      return { text: lines.join('\n'), choices, interactive: 'buttons' }
    }
    case 'list': {
      const lines = [content.text, `  ≡ ${content.buttonText}`]
      const choices: DevChoice[] = []
      for (const section of content.sections) {
        if (section.title) lines.push(`  ${section.title}`)
        for (const row of section.rows) {
          const choice = toChoice(choices.length + 1, row.title, row.id)
          choices.push(choice)
          lines.push(`  [${choice.n}] ${row.title}${row.description ? ` — ${row.description}` : ''}`)
        }
      }
      if (content.footer) lines.push(content.footer)
      lines.push(CLICK_HINT)
      return { text: lines.join('\n'), choices, interactive: 'list' }
    }
    case 'card': {
      const choices = (content.buttons ?? []).map((b, i) => toChoice(i + 1, b.title, b.id, b.url))
      const lines = [`[card] ${content.title}`]
      if (content.body) lines.push(content.body)
      if (content.imageUrl) lines.push(`[image: ${describeMedia(content.imageUrl)}]`)
      if (choices.length) lines.push(...numbered(choices), CLICK_HINT)
      return choices.length ? { text: lines.join('\n'), choices, interactive: 'card' } : { text: lines.join('\n'), choices }
    }
    case 'template':
      return { text: `[template: ${content.name} · ${content.language}]`, choices: [] }
    case 'native':
      return { text: `[native payload for ${content.provider}]`, choices: [] }
    case 'form': {
      const head = `[form: ${content.form.title ?? content.form.id}]`
      const fields = content.form.fields.map((f) => `  · ${f.label} (${f.type}${f.required === false ? ', optional' : ''})`)
      return { text: [head, ...(content.form.intro ? [content.form.intro] : []), ...fields].join('\n'), choices: [] }
    }
  }
}

function toChoice(n: number, label: string, value: string, url?: string): DevChoice {
  return url ? { n, label, value, url } : { n, label, value }
}

/**
 * Prefix `body` with `label` and indent continuation lines under it, ending with
 * a newline: `formatMessage('bot › ', 'a\nb')` → `'bot › a\n      b\n'`.
 */
export function formatMessage(label: string, body: string): string {
  const pad = ' '.repeat(visibleLength(label))
  return `${label}${body.split('\n').join(`\n${pad}`)}\n`
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

function visibleLength(text: string): number {
  return [...text.replace(ANSI, '')].length
}
