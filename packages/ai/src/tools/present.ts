/**
 * Human-readable rendering of tool calls for the end user (confirmation
 * prompts): titles instead of raw names/descriptions, short `• ` lines instead
 * of JSON.
 */
import { AI_MESSAGES, aiText, type AITranslatable } from '../i18n.js'
import type { AITool } from './types.js'

const MAX_LINES = 12
const MAX_VALUE = 120
/** Keys read as a quantity: an item `{ producto, cantidad }` is shown as `cantidad × producto`. */
const QUANTITY_KEY = /^(cantidad|cant|qty|quantity|unidades|units|count|amount|cuantos|cuantas|n)$/i

/** `crear_pedido` / `crearPedido` / `crear-pedido` → `Crear pedido`. */
export function humanizeName(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

/** The label shown to the user for a tool: its `title`, else the humanized name. */
export function toolTitle(name: string, tool: Pick<AITool<unknown>, 'title'>): string {
  return tool.title?.trim() || humanizeName(name)
}

function clip(s: string, max = MAX_VALUE): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== ''
}

/** One value as short inline text (nested structures summarized). */
export function summarizeValue(v: unknown, ctx?: AITranslatable, depth = 0): string {
  if (typeof v === 'string') return clip(v)
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return aiText(ctx, v ? AI_MESSAGES.yes : AI_MESSAGES.no)
  if (Array.isArray(v)) {
    if (depth > 1) return `[${v.length}]`
    return clip(v.filter(present).map((x) => summarizeValue(x, ctx, depth + 1)).join(', '))
  }
  if (isPlainObject(v)) {
    if (depth > 1) return '…'
    const entries = Object.entries(v).filter(([, x]) => present(x))
    const qty = entries.find(([k, x]) => QUANTITY_KEY.test(k) && (typeof x === 'number' || (typeof x === 'string' && /^\d+([.,]\d+)?$/.test(x))))
    if (qty) {
      const rest = entries.filter((e) => e !== qty)
      const what = rest.length === 1
        ? summarizeValue(rest[0]![1], ctx, depth + 1)
        : rest.map(([k, x]) => `${humanizeName(k)}: ${summarizeValue(x, ctx, depth + 1)}`).join(', ')
      return clip(what ? `${String(qty[1])} × ${what}` : String(qty[1]))
    }
    return clip(entries.map(([k, x]) => `${humanizeName(k)}: ${summarizeValue(x, ctx, depth + 1)}`).join(', '))
  }
  if (v === undefined || v === null) return ''
  return clip(String(v))
}

/**
 * Tool arguments as short readable lines (`• Cliente: Ana`, `• 5 × torta_chocolate`).
 * A single list argument is shown as one line per item. Empty values are skipped;
 * long outputs are truncated with a localized "… and N more" line.
 */
export function argLines(args: unknown, ctx?: AITranslatable): string[] {
  if (!isPlainObject(args)) return present(args) && typeof args !== 'object' ? [`• ${summarizeValue(args, ctx)}`] : []
  const entries = Object.entries(args).filter(([, v]) => present(v) && !(Array.isArray(v) && v.length === 0))
  const lines: string[] = []
  if (entries.length === 1 && Array.isArray(entries[0]![1])) {
    for (const item of entries[0]![1] as unknown[]) if (present(item)) lines.push(`• ${summarizeValue(item, ctx, 1)}`)
  } else {
    for (const [key, value] of entries) {
      const label = humanizeName(key)
      if (Array.isArray(value) && value.some((x) => isPlainObject(x) || Array.isArray(x))) {
        lines.push(`• ${label}:`)
        for (const item of value) if (present(item)) lines.push(`   ◦ ${summarizeValue(item, ctx, 1)}`)
      } else {
        lines.push(`• ${label}: ${summarizeValue(value, ctx)}`)
      }
    }
  }
  if (lines.length <= MAX_LINES) return lines
  return [...lines.slice(0, MAX_LINES - 1), aiText(ctx, AI_MESSAGES.more, { n: lines.length - (MAX_LINES - 1) })]
}

/** "a moment ago" / "5 min ago", localized. */
export function agoText(ms: number, ctx?: AITranslatable): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  return minutes < 1 ? aiText(ctx, AI_MESSAGES.agoNow) : aiText(ctx, AI_MESSAGES.agoMinutes, { n: minutes })
}
