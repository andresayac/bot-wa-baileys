/**
 * Model-family knowledge for the Anthropic provider: which Claude models take
 * adaptive thinking (`thinking: { type: 'adaptive' }`) and `output_config.effort`.
 *
 * - Adaptive thinking: Opus / Sonnet 4.6 and later, Haiku 5 and later, Fable and
 *   Mythos. Older models (Haiku 4.5, Sonnet 4.5, Opus 4.5, Claude 3.x...) reject it
 *   with a 400 and only think with `{ type: 'enabled', budget_tokens }`.
 * - Effort: every adaptive model plus Opus 4.5; Sonnet 4.5 / Haiku 4.5 and older reject it.
 *
 * Ids are matched loosely so dated snapshots (`claude-sonnet-4-5-20250929`),
 * Bedrock / Vertex ids (`anthropic.claude-haiku-4-5-...`, `claude-opus-4-5@2025...`)
 * and the legacy `claude-3-5-sonnet-...` naming are recognized. An id that matches
 * no known family (a newer model, a gateway alias) is assumed to be current: it
 * gets adaptive thinking, and the provider drops it once if the API answers with a
 * 400 that names thinking.
 */

import type { AIThinking } from '../types.js'

/**
 * Validate an {@link AIThinking} setting, throwing a `RangeError` for a
 * `{ budgetTokens }` that is not a positive integer (NaN, ±Infinity, fractions,
 * zero, negatives or a non-number). Budgets below the API minimum (1024) are
 * accepted and raised to it when sent. Called when the config is built
 * (`aiPlugin()`, `new AnthropicProvider()`), so a typo fails at startup instead
 * of on the first message.
 */
export function assertThinking(thinking: AIThinking | undefined): void {
  if (typeof thinking !== 'object' || thinking === null) return
  const n: unknown = thinking.budgetTokens
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`thinking.budgetTokens must be a positive integer (got ${typeof n === 'number' ? String(n) : typeof n})`)
  }
}

export interface AnthropicModelSupport {
  /** Accepts `thinking: { type: 'adaptive' }`. */
  adaptiveThinking: boolean
  /** Accepts `output_config.effort`. */
  effort: boolean
  /** The id matched a known Claude family (false → assumed current). */
  known: boolean
}

const ALWAYS_THINKING = /claude-(?:fable|mythos)\b/i
const FAMILY = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/i
const LEGACY = /claude-\d+(?:-\d+)?-(?:opus|sonnet|haiku)|claude-(?:instant|2)\b/i

const CURRENT: AnthropicModelSupport = { adaptiveThinking: true, effort: true, known: false }

/** What the Claude model `model` supports (see the module doc for the rules). */
export function anthropicModelSupport(model: string): AnthropicModelSupport {
  if (ALWAYS_THINKING.test(model)) return { adaptiveThinking: true, effort: true, known: true }
  const m = FAMILY.exec(model)
  if (m) {
    const family = m[1]!.toLowerCase()
    const major = Number(m[2])
    const minor = m[3] === undefined ? 0 : Number(m[3])
    const atLeast = (maj: number, min: number): boolean => major > maj || (major === maj && minor >= min)
    const adaptive = family === 'haiku' ? atLeast(5, 0) : atLeast(4, 6)
    const effort = adaptive || (family === 'opus' && major === 4 && minor === 5)
    return { adaptiveThinking: adaptive, effort, known: true }
  }
  if (LEGACY.test(model)) return { adaptiveThinking: false, effort: false, known: true }
  return CURRENT
}
