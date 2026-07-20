import type { Trigger, TriggerObject, MatchStrategy } from './types.js'

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

interface MatchInput { body: string; isGroup: boolean }

function isTriggerObject(t: Trigger): t is TriggerObject {
  return typeof t === 'object' && t !== null && !(t instanceof RegExp) && !Array.isArray(t) && 'pattern' in t
}

export function matchTrigger(trigger: Trigger, ctx: MatchInput): boolean {
  if (typeof trigger === 'function') return trigger(ctx)

  const obj: TriggerObject = isTriggerObject(trigger) ? trigger : { pattern: trigger as TriggerObject['pattern'] }
  const scope = obj.scope ?? 'all'
  if (scope === 'dm' && ctx.isGroup) return false
  if (scope === 'group' && !ctx.isGroup) return false

  const patterns = Array.isArray(obj.pattern) ? obj.pattern : [obj.pattern]
  const strategy: MatchStrategy = obj.match ?? 'equals'
  const body = normalizeText(ctx.body ?? '')

  return patterns.some((p) => {
    // Intentional: RegExp patterns run against the RAW body (no normalization) —
    // regex authors control their own flags and diacritics handling.
    if (p instanceof RegExp) return p.test(ctx.body ?? '')
    const text = normalizeText(String(p))
    switch (strategy) {
      case 'contains': return body.includes(text)
      case 'startsWith': return body.startsWith(text)
      case 'endsWith': return body.endsWith(text)
      case 'equals':
      default: return body === text
    }
  })
}

const STRATEGY_SPECIFICITY: Record<MatchStrategy, number> = {
  equals: 40,
  startsWith: 30,
  endsWith: 25,
  contains: 10,
}

export function triggerSpecificity(trigger: Trigger): number {
  if (typeof trigger === 'function') return 5
  if (trigger instanceof RegExp) return 20
  if (Array.isArray(trigger)) {
    if (trigger.length === 0) return 0 // never matches → lowest priority
    return Math.max(...trigger.map((p) => triggerSpecificity(p)))
  }
  if (isTriggerObject(trigger)) {
    const patterns = Array.isArray(trigger.pattern) ? trigger.pattern : [trigger.pattern]
    if (patterns.length === 0) return 0 // never matches → lowest priority
    const tier = STRATEGY_SPECIFICITY[trigger.match ?? 'equals']
    // Per-element, combined with max — same rule as top-level arrays:
    // RegExp element → 20; string element → tier of the match strategy.
    return Math.max(...patterns.map((p) => (p instanceof RegExp ? 20 : tier)))
  }
  return 40 // string plano = equals
}
