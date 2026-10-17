/**
 * Pure parser for what the developer types into `bot-wa dev`.
 *
 * A line that starts with `:` followed by a letter is a simulator command
 * (`:as alice`, `:media image ./cat.png`); anything else is a chat message sent
 * to the bot. `::text` escapes a message that must start with a colon, and
 * emoticons like `:)` are plain messages. Slash commands (`/reset`) are bot
 * commands, so they are sent as messages too.
 */

import type { DevMediaKind } from './DevProvider.js'

/** One parsed input line. */
export type DevCommand =
  | { kind: 'empty' }
  | { kind: 'message'; text: string }
  | { kind: 'as'; user: string; name?: string }
  | { kind: 'group'; id: string }
  | { kind: 'dm' }
  | { kind: 'media'; mediaKind: DevMediaKind; path: string; caption?: string }
  | { kind: 'click'; target: string }
  | { kind: 'reset' }
  | { kind: 'reload' }
  | { kind: 'state' }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'invalid'; message: string }

/** Accepted `:media` kinds, plus friendly aliases. */
const MEDIA_KINDS: Record<string, DevMediaKind> = {
  image: 'image', photo: 'image', img: 'image',
  video: 'video',
  audio: 'audio',
  voice: 'voice', ptt: 'voice',
  document: 'document', doc: 'document', file: 'document',
  sticker: 'sticker',
}

const MEDIA_KIND_LIST = 'image, video, audio, voice, document, sticker'

/** Help text printed by `:help`. */
export const DEV_HELP = [
  'Type a message and press Enter to send it to your bot. Commands:',
  '  :as <user> [name]             switch the simulated sender (keeps the current chat)',
  '  :group <id>                   move into group chat <id> (mention the bot as @bot)',
  '  :dm                           back to a direct chat with the bot',
  `  :media <kind> <path> [caption] send a file from disk (${MEDIA_KIND_LIST})`,
  '  :click <n|id|label>           tap a button / list row, or vote on the last poll',
  '  :reset                        restart the bot fresh (drops conversations + in-memory state)',
  '  :reload                       re-import your code from disk (also happens on save)',
  '  :state                        show who you are, the bot status and the live conversation',
  '  :help                         this help',
  '  :quit                         exit (also Ctrl+C / Ctrl+D)',
  'Start a message with "::" to send text that begins with ":".',
].join('\n')

interface Token { value: string; end: number }

/** Split on whitespace, honouring "double" and 'single' quotes. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++
    if (i >= input.length) break
    let value = ''
    const quote = input[i] === '"' || input[i] === "'" ? input[i] : undefined
    if (quote) {
      i++
      while (i < input.length && input[i] !== quote) value += input[i++]
      i++ // closing quote (or end of input)
    } else {
      while (i < input.length && !/\s/.test(input[i]!)) value += input[i++]
    }
    tokens.push({ value, end: Math.min(i, input.length) })
  }
  return tokens
}

/** Parse one line typed into the simulator. Pure. */
export function parseDevInput(line: string): DevCommand {
  const text = line.trim()
  if (!text) return { kind: 'empty' }
  if (text.startsWith('::')) return { kind: 'message', text: text.slice(1) }
  if (!/^:[a-z?]/i.test(text)) return { kind: 'message', text }

  const tokens = tokenize(text.slice(1))
  const name = (tokens[0]?.value ?? '').toLowerCase()
  const rest = (index: number) => text.slice(1).slice(tokens[index]?.end ?? text.length).trim()

  switch (name) {
    case 'as': {
      const user = tokens[1]?.value
      if (!user) return invalid('Usage: :as <user> [display name]')
      const display = rest(1)
      return display ? { kind: 'as', user, name: display } : { kind: 'as', user }
    }
    case 'group': {
      const id = tokens[1]?.value
      return id ? { kind: 'group', id } : invalid('Usage: :group <id>   (:dm to leave the group)')
    }
    case 'dm':
      return { kind: 'dm' }
    case 'media': {
      const rawKind = tokens[1]?.value.toLowerCase()
      const path = tokens[2]?.value
      if (!rawKind || !path) return invalid(`Usage: :media <kind> <path> [caption] — kinds: ${MEDIA_KIND_LIST}`)
      const mediaKind = MEDIA_KINDS[rawKind]
      if (!mediaKind) return invalid(`Unknown media kind "${rawKind}" — use one of: ${MEDIA_KIND_LIST}`)
      const caption = rest(2)
      return caption ? { kind: 'media', mediaKind, path, caption } : { kind: 'media', mediaKind, path }
    }
    case 'click':
    case 'tap': {
      const target = rest(0)
      return target ? { kind: 'click', target } : invalid('Usage: :click <n|id|label>')
    }
    case 'reset':
      return { kind: 'reset' }
    case 'reload':
      return { kind: 'reload' }
    case 'state':
      return { kind: 'state' }
    case 'help':
    case 'h':
    case '?':
      return { kind: 'help' }
    case 'quit':
    case 'q':
    case 'exit':
      return { kind: 'quit' }
    default:
      return invalid(`Unknown command :${name} — type :help`)
  }
}

function invalid(message: string): DevCommand {
  return { kind: 'invalid', message }
}
