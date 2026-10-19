/**
 * Human-readable rendering of tool calls for the end user (confirmation
 * prompts): titles instead of raw names/descriptions, short `• ` lines instead
 * of JSON.
 */
import { AI_MESSAGES, aiText, type AITranslatable } from '../i18n.js'
import type { AITool, AIToolLabels } from './types.js'

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

/** False for summaries with nothing to read (empty, or only `…` placeholders and separators). */
function informative(text: string): boolean {
  return /[^\s…,]/.test(text)
}

/** The human label of a scalar value under `key`, when the tool declares one. */
function labelOf(v: string | number, key: string | undefined, labels: AIToolLabels | undefined): string | undefined {
  if (key === undefined || !labels || !Object.hasOwn(labels, key)) return undefined
  const map = labels[key]!
  const k = String(v)
  return Object.hasOwn(map, k) ? map[k] : undefined
}

function summarize(v: unknown, ctx: AITranslatable | undefined, depth: number, labels: AIToolLabels | undefined, key: string | undefined): string {
  if (typeof v === 'string') return clip(labelOf(v, key, labels) ?? v)
  if (typeof v === 'number') return clip(labelOf(v, key, labels) ?? String(v))
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return aiText(ctx, v ? AI_MESSAGES.yes : AI_MESSAGES.no)
  if (Array.isArray(v)) {
    if (depth > 1) return `[${v.length}]`
    return clip(v.filter(present).map((x) => summarize(x, ctx, depth + 1, labels, key)).join(', '))
  }
  if (isPlainObject(v)) {
    if (depth > 1) return '…'
    const entries = Object.entries(v).filter(([, x]) => present(x))
    const qty = entries.find(([k, x]) => QUANTITY_KEY.test(k) && (typeof x === 'number' || (typeof x === 'string' && /^\d+([.,]\d+)?$/.test(x))))
    if (qty) {
      const rest = entries.filter((e) => e !== qty)
      const what = rest.length === 1
        ? summarize(rest[0]![1], ctx, depth + 1, labels, rest[0]![0])
        : rest.map(([k, x]) => `${humanizeName(k)}: ${summarize(x, ctx, depth + 1, labels, k)}`).join(', ')
      return clip(what ? `${String(qty[1])} × ${what}` : String(qty[1]))
    }
    // Fields too nested to show (a list of objects at this depth renders as `…, …`) are left out.
    return clip(entries
      .map(([k, x]) => [k, summarize(x, ctx, depth + 1, labels, k)] as const)
      .filter(([, text]) => informative(text))
      .map(([k, text]) => `${humanizeName(k)}: ${text}`)
      .join(', '))
  }
  if (v === undefined || v === null) return ''
  return clip(String(v))
}

/**
 * One value as short inline text (nested structures summarized). With `labels`
 * (a tool's {@link AITool.labels}) values under a labelled key show their label.
 */
export function summarizeValue(v: unknown, ctx?: AITranslatable, depth = 0, labels?: AIToolLabels): string {
  return summarize(v, ctx, depth, labels, undefined)
}

/**
 * Tool arguments as short readable lines (`• Cliente: Ana`, `• 5 × torta_chocolate`).
 * A single list argument is shown as one line per item. Empty values are skipped;
 * long outputs are truncated with a localized "… and N more" line. With `labels`
 * (a tool's {@link AITool.labels}) values show their human label (`• 5 × Torta de chocolate`).
 */
export function argLines(args: unknown, ctx?: AITranslatable, labels?: AIToolLabels): string[] {
  if (!isPlainObject(args)) return present(args) && typeof args !== 'object' ? [`• ${summarizeValue(args, ctx)}`] : []
  const entries = Object.entries(args).filter(([, v]) => present(v) && !(Array.isArray(v) && v.length === 0))
  const lines: string[] = []
  if (entries.length === 1 && Array.isArray(entries[0]![1])) {
    const [key, list] = entries[0]!
    for (const item of list as unknown[]) if (present(item)) lines.push(`• ${summarize(item, ctx, 1, labels, key)}`)
  } else {
    for (const [key, value] of entries) {
      const label = humanizeName(key)
      if (Array.isArray(value) && value.some((x) => isPlainObject(x) || Array.isArray(x))) {
        lines.push(`• ${label}:`)
        for (const item of value) if (present(item)) lines.push(`   ◦ ${summarize(item, ctx, 1, labels, key)}`)
      } else {
        lines.push(`• ${label}: ${summarize(value, ctx, 0, labels, key)}`)
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
