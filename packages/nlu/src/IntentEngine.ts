/**
 * IntentEngine — lightweight, fully-local intent matching.
 *
 * Register intents with training phrases (utterances), then score incoming
 * text against them. No network, no ML models, no dependencies: scoring is a
 * deterministic blend of token-overlap (Jaccard), utterance coverage and
 * whole-utterance containment over normalized text (lowercased, diacritics
 * and punctuation stripped).
 *
 * Utterances may contain `{slot}` placeholders to capture a single
 * whitespace-delimited token, e.g. `'mi pedido {id}'` matches
 * `'mi pedido 123'` and extracts `{ id: '123' }`.
 *
 * @example
 * ```ts
 * import { IntentEngine } from '@botmesh/nlu'
 *
 * const nlu = new IntentEngine() // default threshold 0.5
 * nlu.define('greeting', ['hola', 'buenas', 'buenos días'])
 * nlu.define('order.status', ['mi pedido {id}', 'estado de mi pedido'])
 *
 * nlu.match('¡Hola!')                 // → { intent: 'greeting', confidence: 1 }
 * nlu.match('mi pedido 12345')        // → { intent: 'order.status', confidence: 1, entities: { id: '12345' } }
 * nlu.match('zzz qqq')                // → null (below threshold)
 * ```
 */

/** Result of a successful match: the winning intent, its score and any captured slots. */
export interface IntentMatch {
  /** Name of the matched intent (as passed to {@link IntentEngine.define}). */
  intent: string
  /** Score in `[0, 1]`; `1` is an exact (normalized) or full slot-pattern match. */
  confidence: number
  /** Slot values captured from `{slot}` placeholders, when the utterance pattern matched. */
  entities?: Record<string, string>
}

export interface IntentEngineOptions {
  /** Minimum confidence for {@link IntentEngine.match} to return a result. Default `0.5`. */
  threshold?: number
}

/** Scoring weights (fixed, documented in the README). */
const W_JACCARD = 0.3
const W_COVERAGE = 0.5
const W_CONTAINS = 0.2

const SLOT_SEGMENT = /^\{([A-Za-z_]\w*)\}$/
const SLOT_SPLITTER = /(\{[A-Za-z_]\w*\})/

interface CompiledUtterance {
  /** Normalized literal text (slots removed). */
  normalized: string
  /** Normalized literal tokens (slots removed). */
  tokens: string[]
  /** Slot names in order of appearance. */
  slotNames: string[]
  /** Full-input regex when the utterance has slots, else null. */
  regex: RegExp | null
}

/**
 * Normalize text for matching: NFD-decompose and strip diacritics, lowercase,
 * replace every non-alphanumeric character with a space, collapse whitespace
 * and trim. Deterministic and locale-independent.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Loose normalize (no collapse/trim) — keeps spacing between segments intact. */
function loose(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileUtterance(raw: string): CompiledUtterance {
  const slotNames: string[] = []
  const withSlots: string[] = []
  const withoutSlots: string[] = []
  for (const seg of raw.split(SLOT_SPLITTER)) {
    const m = SLOT_SEGMENT.exec(seg)
    if (m) {
      slotNames.push(m[1])
      withSlots.push(seg)
      withoutSlots.push(' ')
    } else {
      withSlots.push(loose(seg))
      withoutSlots.push(loose(seg))
    }
  }
  const normalized = normalizeText(withoutSlots.join(''))
  const tokens = normalized ? normalized.split(' ') : []
  let regex: RegExp | null = null
  if (slotNames.length > 0) {
    // Build the pattern from the loose-normalized segments directly (a full
    // normalizeText pass would strip the `{` `}` markers that delimit slots).
    const body = withSlots
      .map((seg) => (SLOT_SEGMENT.test(seg) ? '(\\S+)' : escapeRegExp(seg)))
      .join('')
      .trim()
      .replace(/\s+/g, '\\s+')
    regex = new RegExp(`^${body}$`, 'u')
  }
  return { normalized, tokens, slotNames, regex }
}

/**
 * Deterministic local intent matcher. See the package README for the scoring
 * formula and its limits (it is NOT a full ML NLU).
 */
export class IntentEngine {
  private readonly registry = new Map<string, CompiledUtterance[]>()
  private readonly defaultThreshold: number

  constructor(options: IntentEngineOptions = {}) {
    const threshold = options.threshold ?? 0.5
    if (typeof threshold !== 'number' || Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      throw new Error(`IntentEngine: threshold must be a number in [0, 1], got ${String(threshold)}`)
    }
    this.defaultThreshold = threshold
  }

  /** Minimum confidence `match()` requires (constructor value). */
  get threshold(): number {
    return this.defaultThreshold
  }

  /**
   * Add training phrases to an intent. Calling `define` again for an existing
   * intent APPENDS utterances (it does not replace them). Returns `this` for
   * chaining.
   */
  define(intent: string, utterances: string[]): this {
    if (typeof intent !== 'string' || intent.trim() === '') {
      throw new Error('IntentEngine.define: intent must be a non-empty string')
    }
    if (!Array.isArray(utterances)) {
      throw new Error(`IntentEngine.define("${intent}"): utterances must be an array of strings`)
    }
    const clean = utterances.filter((u): u is string => typeof u === 'string' && u.trim() !== '')
    if (clean.length === 0) {
      throw new Error(`IntentEngine.define("${intent}"): provide at least one non-empty utterance`)
    }
    const existing = this.registry.get(intent) ?? []
    for (const u of clean) existing.push(compileUtterance(u))
    this.registry.set(intent, existing)
    return this
  }

  /** Names of every registered intent, in definition order. */
  intents(): string[] {
    return [...this.registry.keys()]
  }

  /**
   * Best match at or above `threshold` (default: the engine threshold), or
   * `null` when nothing qualifies. Ties resolve deterministically to the
   * earliest-defined intent.
   */
  match(text: string, threshold: number = this.defaultThreshold): IntentMatch | null {
    const best = this.rank(text)[0]
    return best && best.confidence >= threshold ? best : null
  }

  /**
   * Score every intent against `text` and return all positive scores sorted
   * by confidence (descending; ties keep definition order). Useful for
   * debugging and disambiguation UIs.
   */
  rank(text: string): IntentMatch[] {
    const input = normalizeText(text)
    if (!input) return []
    const inputTokens = input.split(' ')
    const inputSet = new Set(inputTokens)
    const out: IntentMatch[] = []
    for (const [intent, utterances] of this.registry) {
      let best: IntentMatch | undefined
      for (const u of utterances) {
        const scored = this.scoreUtterance(u, input, inputTokens, inputSet)
        if (scored.confidence > 0 && (!best || scored.confidence > best.confidence)) {
          best = { intent, confidence: scored.confidence, ...(scored.entities ? { entities: scored.entities } : {}) }
        }
      }
      if (best) out.push(best)
    }
    out.sort((a, b) => b.confidence - a.confidence) // stable: ties keep definition order
    return out
  }

  private scoreUtterance(
    u: CompiledUtterance,
    input: string,
    inputTokens: string[],
    inputSet: Set<string>,
  ): { confidence: number; entities?: Record<string, string> } {
    // Slot utterances: a full pattern match scores 1 and captures entities.
    if (u.regex) {
      const m = u.regex.exec(input)
      if (m) {
        const entities: Record<string, string> = {}
        u.slotNames.forEach((name, i) => {
          entities[name] = m[i + 1]
        })
        return { confidence: 1, entities }
      }
    } else if (u.normalized.length > 0 && input === u.normalized) {
      // Exact match on normalized text (case/diacritics/punctuation-insensitive).
      return { confidence: 1 }
    }
    if (u.tokens.length === 0) return { confidence: 0 }

    let intersection = 0
    for (const t of u.tokens) if (inputSet.has(t)) intersection++
    if (intersection === 0) return { confidence: 0 }

    const union = u.tokens.length + inputTokens.length - intersection
    const jaccard = intersection / union // token-overlap symmetry
    const coverage = intersection / u.tokens.length // how much of the utterance the input covers
    const contains = u.normalized.length > 0 && input.includes(u.normalized) ? 1 : 0
    return { confidence: W_JACCARD * jaccard + W_COVERAGE * coverage + W_CONTAINS * contains }
  }
}
