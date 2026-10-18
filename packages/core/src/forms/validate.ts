/**
 * Form definition checks and answer validation, shared by the native and the
 * degraded rendering of `flow().form()`. Native submissions are re-validated
 * here too: a client-side form is never trusted.
 */

import { normalizeText } from '../core/matching.js'
import type {
  FormDefinition, FormField, FormOptions, FormValue, FormValues, MultiSelectFormField,
} from './types.js'

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TYPES = new Set(['text', 'number', 'email', 'date', 'select', 'multiselect', 'optin'])

/** `[key, label]` pairs of a select/multiselect, in display order. */
export function formOptionEntries(options: FormOptions): Array<[string, string]> {
  return Array.isArray(options)
    ? (options as readonly string[]).map((label) => [label, label])
    : Object.entries(options as Record<string, string>)
}

/** Whether an answer is mandatory (`required` defaults to `true`, except for `optin`). */
export function isFieldRequired(field: FormField): boolean {
  return field.required ?? field.type !== 'optin'
}

function isValidIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

function patternOf(pattern: RegExp | string): RegExp {
  return typeof pattern === 'string' ? new RegExp(`^(?:${pattern})$`) : pattern
}

/**
 * Throw a `TypeError` describing the first structural problem of `def` (bad id or
 * field name, duplicate names, empty options, inconsistent bounds, invalid
 * dates or patterns). Called by `flow().form()` at build time.
 */
export function assertFormDefinition(def: FormDefinition): void {
  const where = `form ${JSON.stringify(def?.id)}`
  if (!def || typeof def !== 'object') throw new TypeError('form(): the definition must be an object')
  if (typeof def.id !== 'string' || !NAME.test(def.id)) {
    throw new TypeError(`${where}: id must match /^[A-Za-z_][A-Za-z0-9_]*$/`)
  }
  if (!Array.isArray(def.fields) || def.fields.length === 0) throw new TypeError(`${where}: needs at least one field`)
  const seen = new Set<string>()
  for (const field of def.fields) {
    const f = `${where}, field ${JSON.stringify(field?.name)}`
    if (!field || typeof field.name !== 'string' || !NAME.test(field.name)) {
      throw new TypeError(`${f}: name must match /^[A-Za-z_][A-Za-z0-9_]*$/`)
    }
    if (seen.has(field.name)) throw new TypeError(`${f}: duplicate field name`)
    seen.add(field.name)
    if (!TYPES.has(field.type)) throw new TypeError(`${f}: unknown type ${JSON.stringify(field.type)}`)
    if (typeof field.label !== 'string' || field.label.trim() === '') throw new TypeError(`${f}: label is required`)
    switch (field.type) {
      case 'text':
        if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
          throw new TypeError(`${f}: minLength > maxLength`)
        }
        if (field.pattern !== undefined) {
          try { patternOf(field.pattern) } catch { throw new TypeError(`${f}: invalid pattern`) }
        }
        break
      case 'number':
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new TypeError(`${f}: min > max`)
        break
      case 'date':
        for (const bound of [field.min, field.max]) {
          if (bound !== undefined && !isValidIsoDate(bound)) throw new TypeError(`${f}: min/max must be 'YYYY-MM-DD' dates`)
        }
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new TypeError(`${f}: min > max`)
        break
      case 'select':
      case 'multiselect': {
        const entries = formOptionEntries(field.options ?? [])
        if (entries.length === 0) throw new TypeError(`${f}: needs at least one option`)
        const keys = new Set<string>()
        for (const [key, label] of entries) {
          if (typeof key !== 'string' || key === '' || typeof label !== 'string' || label.trim() === '') {
            throw new TypeError(`${f}: option keys and labels must be non-empty strings`)
          }
          if (keys.has(key)) throw new TypeError(`${f}: duplicate option ${JSON.stringify(key)}`)
          keys.add(key)
        }
        if (field.type === 'multiselect') {
          const { min, max } = selectionBounds(field)
          if (min > max) throw new TypeError(`${f}: minSelected > maxSelected`)
        }
        break
      }
      case 'optin':
        break
    }
  }
}

/** Effective `[min, max]` picks of a multiselect. */
export function selectionBounds(field: MultiSelectFormField): { min: number; max: number } {
  const count = formOptionEntries(field.options).length
  return {
    min: field.minSelected ?? (isFieldRequired(field) ? 1 : 0),
    max: Math.min(field.maxSelected ?? count, count),
  }
}

/** Result of checking one answer. */
export type FieldCheck = { ok: true; value: FormValue | undefined } | { ok: false; message: string }

const fail = (field: FormField, message: string): FieldCheck => ({ ok: false, message: field.error ?? message })

/** Validate an already-typed value against the field's constraints. */
function checkTyped(field: FormField, value: FormValue): FieldCheck {
  switch (field.type) {
    case 'text': {
      const s = value as string
      if (field.minLength !== undefined && s.length < field.minLength) return fail(field, `❌ ${field.label}: mínimo ${field.minLength} caracteres.`)
      if (field.maxLength !== undefined && s.length > field.maxLength) return fail(field, `❌ ${field.label}: máximo ${field.maxLength} caracteres.`)
      if (field.pattern !== undefined) {
        const re = patternOf(field.pattern)
        re.lastIndex = 0
        if (!re.test(s)) return fail(field, `❌ ${field.label}: formato no válido.`)
      }
      return { ok: true, value: s }
    }
    case 'number': {
      const n = value as number
      if (field.integer && !Number.isInteger(n)) return fail(field, `❌ ${field.label}: debe ser un número entero.`)
      if (field.min !== undefined && n < field.min) return fail(field, `❌ ${field.label}: el mínimo es ${field.min}.`)
      if (field.max !== undefined && n > field.max) return fail(field, `❌ ${field.label}: el máximo es ${field.max}.`)
      return { ok: true, value: n }
    }
    case 'date': {
      const d = value as string
      if (field.min !== undefined && d < field.min) return fail(field, `❌ ${field.label}: la fecha mínima es ${field.min}.`)
      if (field.max !== undefined && d > field.max) return fail(field, `❌ ${field.label}: la fecha máxima es ${field.max}.`)
      return { ok: true, value: d }
    }
    case 'multiselect': {
      const picks = value as string[]
      const { min, max } = selectionBounds(field)
      if (picks.length < min) return fail(field, `❌ ${field.label}: elige al menos ${min}.`)
      if (picks.length > max) return fail(field, `❌ ${field.label}: elige como máximo ${max}.`)
      return { ok: true, value: picks }
    }
    case 'optin':
      if (isFieldRequired(field) && value !== true) return fail(field, `❌ Debes aceptar: ${field.label}.`)
      return { ok: true, value }
    default:
      return { ok: true, value }
  }
}

/** Parse a date answer: `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY` or `DD.MM.YYYY` → `YYYY-MM-DD`. */
export function parseFormDate(input: string): string | undefined {
  const s = input.trim()
  if (isValidIsoDate(s)) return s
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (!m) return undefined
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return isValidIsoDate(iso) ? iso : undefined
}

/**
 * `1.500` / `1,500` / `12.345.678`: the separator may be a thousands one
 * (es/LatAm '.', en ',') or a decimal one; too ambiguous to guess, so it is
 * rejected and the user is asked to retype it.
 */
const GROUPED = /^[-+]?\d{1,3}([.,]\d{3})+$/

/** `'ambiguous'` = grouped digits (see {@link GROUPED}); `undefined` = not a number. */
function parseNumber(input: string): number | 'ambiguous' | undefined {
  const compact = input.trim().replace(/\s/g, '')
  if (GROUPED.test(compact)) return 'ambiguous'
  const s = compact.replace(',', '.')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

const AMBIGUOUS_NUMBER = (label: string): string =>
  `❌ ${label}: escribe el número sin separador de miles (ej. 1500 o 1,5).`

const YES = new Set(['si', 'yes', 'y', 's', 'acepto', 'ok', 'true', '1'])
const NO = new Set(['no', 'n', 'false', '0', '2'])

/** Resolve one select token (menu number, key or label) to an option key. */
function resolveOption(entries: Array<[string, string]>, token: string): string | undefined {
  const t = normalizeText(token)
  if (!t) return undefined
  if (/^\d+$/.test(t)) {
    const byIndex = entries[parseInt(t, 10) - 1]
    if (byIndex) return byIndex[0]
  }
  return entries.find(([k]) => normalizeText(k) === t)?.[0] ?? entries.find(([, l]) => normalizeText(l) === t)?.[0]
}

/**
 * Degraded mode: parse a typed answer for `field`. `{ ok: true, value: undefined }`
 * means an optional field was skipped (`skipWord`).
 */
export function parseFieldAnswer(field: FormField, input: string, skipWord = 'omitir'): FieldCheck {
  const raw = input.trim()
  if (!isFieldRequired(field) && normalizeText(raw) === normalizeText(skipWord) && field.type !== 'optin') {
    return { ok: true, value: undefined }
  }
  switch (field.type) {
    case 'text':
      if (raw === '') return fail(field, `✍️ ${field.label}: escribe una respuesta.`)
      return checkTyped(field, raw)
    case 'email':
      return EMAIL.test(raw) ? { ok: true, value: raw } : fail(field, '❌ Escribe un correo válido (ej. nombre@dominio.com).')
    case 'number': {
      const n = parseNumber(raw)
      if (n === 'ambiguous') return fail(field, AMBIGUOUS_NUMBER(field.label))
      return n === undefined ? fail(field, `❌ ${field.label}: escribe un número.`) : checkTyped(field, n)
    }
    case 'date': {
      const d = parseFormDate(raw)
      return d === undefined ? fail(field, '❌ Escribe una fecha válida (AAAA-MM-DD o DD/MM/AAAA).') : checkTyped(field, d)
    }
    case 'select': {
      const key = resolveOption(formOptionEntries(field.options), raw)
      return key === undefined ? fail(field, '❌ Elige una opción de la lista (número u opción).') : { ok: true, value: key }
    }
    case 'multiselect': {
      const entries = formOptionEntries(field.options)
      const tokens = raw.split(/[,;\n]+|\s+y\s+/).map((t) => t.trim()).filter(Boolean)
      // "1 3" (space-separated numbers) is also accepted.
      const parts = tokens.length === 1 && /^\d+(\s+\d+)+$/.test(tokens[0]) ? tokens[0].split(/\s+/) : tokens
      const picked = new Set<string>()
      for (const part of parts) {
        const key = resolveOption(entries, part)
        if (key === undefined) return fail(field, `❌ No reconozco "${part}". Escribe los números separados por coma (ej. 1, 3).`)
        picked.add(key)
      }
      return checkTyped(field, entries.map(([k]) => k).filter((k) => picked.has(k)))
    }
    case 'optin': {
      const t = normalizeText(raw)
      if (YES.has(t)) return { ok: true, value: true }
      if (NO.has(t)) return checkTyped(field, false)
      return fail(field, '❌ Responde 1 (Sí) o 2 (No).')
    }
  }
}

const isMissing = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

/** Coerce one native (provider-submitted) value to the field's type, then validate it. */
function checkNative(field: FormField, v: unknown): FieldCheck {
  switch (field.type) {
    case 'text':
    case 'email':
    case 'date':
    case 'select': {
      if (typeof v !== 'string' && typeof v !== 'number') return fail(field, `❌ ${field.label}: valor no válido.`)
      const s = String(v).trim()
      if (field.type === 'select') {
        const key = formOptionEntries(field.options).find(([k]) => k === s)?.[0]
        return key === undefined ? fail(field, `❌ ${field.label}: opción no válida.`) : { ok: true, value: key }
      }
      if (field.type === 'date') {
        // Flow JSON < 5.0 DatePickers submit an epoch-ms timestamp.
        const d = /^\d{11,}$/.test(s) ? new Date(Number(s)).toISOString().slice(0, 10) : parseFormDate(s)
        return d === undefined ? fail(field, `❌ ${field.label}: fecha no válida.`) : checkTyped(field, d)
      }
      return parseFieldAnswer({ ...field, required: true }, s)
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v) : undefined
      if (n === 'ambiguous') return fail(field, AMBIGUOUS_NUMBER(field.label))
      return n === undefined || !Number.isFinite(n) ? fail(field, `❌ ${field.label}: escribe un número.`) : checkTyped(field, n)
    }
    case 'multiselect': {
      let list: unknown = v
      if (typeof v === 'string') {
        try { list = v.trim().startsWith('[') ? JSON.parse(v) : v.split(',') } catch { list = undefined }
      }
      if (!Array.isArray(list)) return fail(field, `❌ ${field.label}: valor no válido.`)
      const entries = formOptionEntries(field.options)
      const keys = new Set(entries.map(([k]) => k))
      const picked = new Set<string>()
      for (const item of list) {
        const key = String(item).trim()
        if (!keys.has(key)) return fail(field, `❌ ${field.label}: opción no válida.`)
        picked.add(key)
      }
      return checkTyped(field, entries.map(([k]) => k).filter((k) => picked.has(k)))
    }
    case 'optin': {
      const b = v === true || v === 'true' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 0 || v === '0' ? false : undefined
      return b === undefined ? fail(field, `❌ ${field.label}: valor no válido.`) : checkTyped(field, b)
    }
  }
}

/** One invalid field of a submission. */
export interface FormFieldError {
  field: string
  message: string
}

/** Result of {@link validateFormValues}. */
export type FormValidation = { ok: true; values: FormValues } | { ok: false; errors: FormFieldError[] }

/**
 * Validate and normalize a whole submission (e.g. a native form reply): unknown
 * keys are dropped, missing optional fields are omitted, values are coerced to
 * the {@link FormValues} types.
 */
export function validateFormValues(def: FormDefinition, raw: Record<string, unknown>): FormValidation {
  const values: FormValues = {}
  const errors: FormFieldError[] = []
  for (const field of def.fields) {
    const v = raw[field.name]
    if (isMissing(v) && field.type !== 'optin') {
      if (isFieldRequired(field)) errors.push({ field: field.name, message: field.error ?? `❌ ${field.label}: es obligatorio.` })
      continue
    }
    // An unticked opt-in may be submitted as absent: it means `false`.
    const r = field.type === 'optin' && isMissing(v) ? checkTyped(field, false) : checkNative(field, v)
    if (r.ok) { if (r.value !== undefined) values[field.name] = r.value } else errors.push({ field: field.name, message: r.message })
  }
  return errors.length ? { ok: false, errors } : { ok: true, values }
}
