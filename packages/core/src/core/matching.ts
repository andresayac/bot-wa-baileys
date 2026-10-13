import type { Trigger, TriggerObject, MatchStrategy, TriggerScope } from './types.js'
import type { MessageType } from './provider.js'
import { isTypeTrigger, isWelcomeTrigger, typeTriggerSpecificity, WELCOME_SPECIFICITY } from './triggers.js'

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** `type` is only read by type triggers (the dispatcher always passes the full context). */
interface MatchInput { body: string; isGroup: boolean; type?: string }

function isTriggerObject(t: Trigger): t is TriggerObject {
  return typeof t === 'object' && t !== null && !(t instanceof RegExp) && !Array.isArray(t) && 'pattern' in t
}

function inScope(scope: TriggerScope | undefined, isGroup: boolean): boolean {
  if (scope === 'dm') return !isGroup
  if (scope === 'group') return isGroup
  return true
}

/**
 * Synchronous match. For `WELCOME` this only checks the scope — the first-contact
 * decision is asynchronous and made by the Dispatcher (see `core/welcome.ts`).
 */
export function matchTrigger(trigger: Trigger, ctx: MatchInput): boolean {
  if (typeof trigger === 'function') return trigger(ctx)
  if (isTypeTrigger(trigger)) {
    return inScope(trigger.scope, ctx.isGroup) && trigger.types.includes(ctx.type as MessageType)
  }
  if (isWelcomeTrigger(trigger)) return inScope(trigger.scope, ctx.isGroup)

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
    if (p instanceof RegExp) {
      p.lastIndex = 0
      const matched = p.test(ctx.body ?? '')
      p.lastIndex = 0
      return matched
    }
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
  if (isWelcomeTrigger(trigger)) return WELCOME_SPECIFICITY
  if (isTypeTrigger(trigger)) return typeTriggerSpecificity(trigger)
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
