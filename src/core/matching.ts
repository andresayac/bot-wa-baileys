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

export function triggerSpecificity(trigger: Trigger): number {
  if (typeof trigger === 'function') return 5
  if (trigger instanceof RegExp) return 20
  if (Array.isArray(trigger)) return Math.max(...trigger.map((p) => triggerSpecificity(p)))
  if (isTriggerObject(trigger)) {
    const hasRegex = (Array.isArray(trigger.pattern) ? trigger.pattern : [trigger.pattern]).some((p) => p instanceof RegExp)
    if (hasRegex) return 20
    switch (trigger.match ?? 'equals') {
      case 'equals': return 40
      case 'startsWith': return 30
      case 'endsWith': return 25
      case 'contains': return 10
    }
  }
  return 40 // string plano = equals
}
