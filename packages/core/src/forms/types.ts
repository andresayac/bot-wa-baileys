/**
 * Native forms — transport-agnostic form definitions for `flow().form()`.
 *
 * A {@link FormDefinition} describes WHAT to collect (typed fields + validation),
 * never HOW a transport renders it. A provider that declares
 * `capabilities.forms === 'native'` receives the definition as an
 * `OutboundContent` of kind `'form'` and renders it natively (WhatsApp Flows on
 * the Cloud API); every other provider gets the same form as sequential
 * `ask()`/`choose()`-style questions ("degraded" mode). Either way the answers
 * land in `c.state` with the same normalized types (see {@link FormValues}).
 */

/** Field types a form can contain. */
export type FormFieldType = 'text' | 'number' | 'email' | 'date' | 'select' | 'multiselect' | 'optin'

/**
 * Options of a `select`/`multiselect` field: either `{ key: label }` (the KEY is
 * stored in `c.state`) or a list of labels (each label is its own key).
 */
export type FormOptions = Record<string, string> | readonly string[]

interface FormFieldBase {
  /**
   * Key of the answer in the form's values (and in `c.state` with `flatten`).
   * Letters, digits and `_`, starting with a letter or `_` (`/^[A-Za-z_][A-Za-z0-9_]*$/`).
   */
  name: string
  /** Short label shown next to the input (native) or used as the question (degraded). */
  label: string
  /** Whether an answer is mandatory. Default `true` (`false` for `optin`). */
  required?: boolean
  /** Extra hint under the input (native) / appended to the question (degraded). */
  helper?: string
  /** Degraded mode only: full question text instead of `label` (+ `helper`). */
  prompt?: string
  /** Error message used when an answer for this field is invalid (overrides the built-in ones). */
  error?: string
}

/** Free text. */
export interface TextFormField extends FormFieldBase {
  type: 'text'
  minLength?: number
  maxLength?: number
  /** Server-side pattern the whole answer must match (checked in both modes). */
  pattern?: RegExp | string
  /** Render as a multi-line text area where the transport supports it. */
  multiline?: boolean
}

/** A number (`c.state` gets a `number`). */
export interface NumberFormField extends FormFieldBase {
  type: 'number'
  min?: number
  max?: number
  /** Reject decimals. */
  integer?: boolean
}

/** An email address (stored as typed, trimmed). */
export interface EmailFormField extends FormFieldBase {
  type: 'email'
}

/**
 * A calendar date, stored as `'YYYY-MM-DD'`. Degraded mode also accepts
 * `DD/MM/YYYY` and `DD-MM-YYYY`.
 */
export interface DateFormField extends FormFieldBase {
  type: 'date'
  /** Earliest allowed date, `'YYYY-MM-DD'`. */
  min?: string
  /** Latest allowed date, `'YYYY-MM-DD'`. */
  max?: string
}

/** Pick exactly one option (`c.state` gets the option KEY). */
export interface SelectFormField extends FormFieldBase {
  type: 'select'
  options: FormOptions
}

/** Pick several options (`c.state` gets an array of option KEYS, in option order). */
export interface MultiSelectFormField extends FormFieldBase {
  type: 'multiselect'
  options: FormOptions
  /** Minimum number of picks (default 1 when required, else 0). */
  minSelected?: number
  /** Maximum number of picks (default: all). */
  maxSelected?: number
}

/**
 * A consent checkbox (`c.state` gets a `boolean`). When `required`, the user must
 * accept it to submit the form.
 */
export interface OptInFormField extends FormFieldBase {
  type: 'optin'
}

/** Any form field. */
export type FormField =
  | TextFormField
  | NumberFormField
  | EmailFormField
  | DateFormField
  | SelectFormField
  | MultiSelectFormField
  | OptInFormField

/** A transport-agnostic form. */
export interface FormDefinition {
  /**
   * Stable form id: default `c.state` key of the answers, the key a native
   * provider uses to find the published form (e.g. a WhatsApp Flow id mapping),
   * and the node label in `describe()`. Same charset as field names.
   */
  id: string
  /** Title shown on the native form screen. */
  title?: string
  /** Text sent with the form (native message body) or before the first question (degraded). */
  intro?: string
  /** Label of the button that opens a native form. Default: `core.form.cta` in `ctx.lang` (`'Abrir formulario'` / `'Open form'`). */
  cta?: string
  /** Label of the submit button of a native form. Default: `core.form.submit` in `ctx.lang` (`'Enviar'` / `'Submit'`). */
  submitLabel?: string
  /** Fields, in order. At least one; names must be unique. */
  fields: readonly FormField[]
}

/** Normalized answer of one field. */
export type FormValue = string | number | boolean | string[]

/**
 * Answers of a completed form, keyed by field name. Optional fields the user
 * skipped are absent. Types: `text`/`email`/`date`/`select` → `string`,
 * `number` → `number`, `multiselect` → `string[]`, `optin` → `boolean`.
 */
export type FormValues = Record<string, FormValue>

/**
 * Normalized native form submission carried by an inbound message of type
 * `'form'` (its `body` is `JSON.stringify(reply)`; see `formReplyBody()` /
 * `parseFormReply()`). `token` echoes the `token` of the `'form'` content that
 * opened the form, so the runtime can match the reply to the pending step.
 */
export interface FormReply {
  token?: string
  /** Raw submitted values, keyed by field name (validated and coerced by the core). */
  values: Record<string, unknown>
}

/** How `.form()` renders. `'auto'` (default) follows `capabilities.forms`. */
export type FormMode = 'auto' | 'native' | 'degraded'

/** Options of `flow().form(definition, opts)`. */
export interface FormStepOptions {
  /** `c.state` key the answers object is stored under. Default: the form `id`. */
  stateKey?: string
  /** Also copy every answer to `c.state[field.name]`. Default `false`. */
  flatten?: boolean
  /** Force a rendering mode. Default `'auto'`. */
  mode?: FormMode
  /**
   * Provider-side id of the published native form (on the Cloud API: a WhatsApp
   * Flow id, or its name). Providers may also map `definition.id` to it in their config.
   */
  nativeId?: string
  /** Wait timeout per answer (degraded) / for the whole submission (native). Default: the flow's. */
  timeout?: number | string
  /** Invalid answers tolerated per field (degraded) or per submission (native). Default 3. */
  retries?: number
  /** Degraded mode: word that skips an optional field. Default `'omitir'`. */
  skipWord?: string
  /** Native mode: reply sent when the user writes instead of submitting the form. */
  pendingMessage?: string
}

/** Outbound descriptor a native provider receives (OutboundContent kind `'form'`). */
export interface FormContent {
  kind: 'form'
  form: FormDefinition
  /** Opaque correlation token; the provider must echo it in the {@link FormReply}. */
  token: string
  /** See {@link FormStepOptions.nativeId}. */
  nativeId?: string
}
