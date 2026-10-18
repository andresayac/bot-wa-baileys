/**
 * WhatsApp Flows — compile a transport-agnostic {@link FormDefinition} (from
 * `flow().form()`) into a static Flow JSON (single screen, `navigate` only, no
 * data endpoint) and into the interactive `flow` message that opens it.
 *
 * Static flows need no endpoint and no encryption: the submission arrives on the
 * regular messages webhook as an `nfm_reply` (see `parseInbound`). Endpoint
 * ("data_exchange") flows — dynamic screens fed by an encrypted HTTPS endpoint —
 * are NOT implemented yet.
 *
 * A Flow must exist on Meta's side before it can be sent: publish
 * `toFlowJson(definition)` once (Flows API / WhatsApp Manager, or
 * `CloudAPIProvider.publishForm()`), then map the form id to the Flow id
 * (`CloudAPIProviderConfig.flows`) or pass `{ nativeId }` to `.form()`.
 */

import {
  CORE_MESSAGES, I18n, UnsupportedContentError, formOptionEntries, isFieldRequired, selectionBounds,
  type FormContent, type FormDefinition, type FormField,
} from '@bot-wa/core'

/** Flow JSON version emitted by default (`'YYYY-MM-DD'` dates need >= 5.0). */
export const DEFAULT_FLOW_JSON_VERSION = '6.2'
/** `flow_message_version` of the interactive flow message. */
export const FLOW_MESSAGE_VERSION = '3'

/** Character limits of the Flows components this compiler emits. */
export const FLOW_LIMITS = {
  textInputLabel: 20,
  textAreaLabel: 20,
  dropdownLabel: 20,
  datePickerLabel: 40,
  choiceGroupLabel: 30,
  optInLabel: 120,
  optionTitle: 30,
  helperText: 80,
  footerLabel: 35,
  heading: 80,
  cta: 30,
  /** RadioButtonsGroup / CheckboxGroup max options (a `select` with more becomes a Dropdown). */
  groupOptions: 20,
  dropdownOptions: 200,
} as const

/** A Flow JSON document (the subset this compiler emits). */
export interface WhatsAppFlowJson {
  version: string
  screens: Array<{
    id: string
    title: string
    terminal: true
    success: true
    data: Record<string, unknown>
    layout: { type: 'SingleColumnLayout'; children: Array<Record<string, unknown>> }
  }>
}

/** Where to find the published Flow of a form. */
export interface FlowRef {
  /** Numeric Flow id (from the Flows API / WhatsApp Manager). */
  flowId?: string
  /** Flow name, as an alternative to `flowId`. */
  flowName?: string
  /** `'draft'` sends the unpublished draft (testing only). Default `'published'`. */
  mode?: 'draft' | 'published'
}

/** Options of {@link toFlowJson}. */
export interface FlowJsonOptions {
  /** Flow JSON `version`. Default {@link DEFAULT_FLOW_JSON_VERSION}. */
  version?: string
  /**
   * Language of the default submit label (`core.form.submit` of the built-in
   * catalog) when the definition has no `submitLabel`. The label is part of the
   * published Flow, so it cannot follow each user's `ctx.lang`: publish one Flow
   * per language or set `submitLabel`. Default `'es'` (`'Enviar'`).
   */
  lang?: string
}

/** Built-in catalog (es/en) for the defaults used without a bot context. */
const catalog = new I18n()
const builtin = (key: string, lang?: string): string => catalog.translate(lang ?? 'es', key)

/** Screen id of a form: upper-case letters and `_` only (`SUCCESS` is reserved by Meta). */
export function flowScreenId(def: FormDefinition): string {
  const id = def.id.toUpperCase().replace(/[^A-Z_]/g, '_').replace(/^_+|_+$/g, '') || 'FORM'
  return id === 'SUCCESS' ? 'SUCCESS_FORM' : id
}

function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

function labelLimit(field: FormField): number {
  switch (field.type) {
    case 'date': return FLOW_LIMITS.datePickerLabel
    case 'multiselect': return FLOW_LIMITS.choiceGroupLabel
    case 'select': return formOptionEntries(field.options).length > FLOW_LIMITS.groupOptions ? FLOW_LIMITS.dropdownLabel : FLOW_LIMITS.choiceGroupLabel
    case 'optin': return FLOW_LIMITS.optInLabel
    default: return FLOW_LIMITS.textInputLabel
  }
}

function dataSource(field: Extract<FormField, { options: unknown }>): Array<{ id: string; title: string }> {
  return formOptionEntries(field.options).map(([id, title]) => ({ id, title: cut(title, FLOW_LIMITS.optionTitle) }))
}

function component(field: FormField): Record<string, unknown> {
  const common: Record<string, unknown> = {
    name: field.name,
    label: cut(field.label, labelLimit(field)),
    required: isFieldRequired(field),
  }
  if (field.helper && field.type !== 'optin' && field.type !== 'select' && field.type !== 'multiselect') {
    common['helper-text'] = cut(field.helper, FLOW_LIMITS.helperText)
  }
  switch (field.type) {
    case 'text':
      if (field.multiline) {
        return { type: 'TextArea', ...common, ...(field.maxLength !== undefined ? { 'max-length': field.maxLength } : {}) }
      }
      return {
        type: 'TextInput', ...common, 'input-type': 'text',
        ...(field.minLength !== undefined ? { 'min-chars': field.minLength } : {}),
        ...(field.maxLength !== undefined ? { 'max-chars': field.maxLength } : {}),
      }
    case 'number':
      return { type: 'TextInput', ...common, 'input-type': 'number' }
    case 'email':
      return { type: 'TextInput', ...common, 'input-type': 'email' }
    case 'date':
      return {
        type: 'DatePicker', ...common,
        ...(field.min !== undefined ? { 'min-date': field.min } : {}),
        ...(field.max !== undefined ? { 'max-date': field.max } : {}),
      }
    case 'select': {
      const source = dataSource(field)
      return { type: source.length > FLOW_LIMITS.groupOptions ? 'Dropdown' : 'RadioButtonsGroup', ...common, 'data-source': source }
    }
    case 'multiselect': {
      const { min, max } = selectionBounds(field)
      return {
        type: 'CheckboxGroup', ...common, 'data-source': dataSource(field),
        ...(min > 0 ? { 'min-selected-items': min } : {}),
        'max-selected-items': max,
      }
    }
    case 'optin':
      return { type: 'OptIn', ...common }
  }
}

/**
 * Compile a form into a static, single-screen Flow JSON. The terminal Footer's
 * `complete` action returns every field as `${form.<name>}`; the server re-validates
 * the submission (`validateFormValues`) so client-side limits are only a convenience.
 */
export function toFlowJson(def: FormDefinition, opts: FlowJsonOptions = {}): WhatsAppFlowJson {
  const payload = Object.fromEntries(def.fields.map((f) => [f.name, `\${form.${f.name}}`]))
  const children: Array<Record<string, unknown>> = []
  if (def.intro) children.push({ type: 'TextBody', text: def.intro })
  children.push({
    type: 'Form',
    name: 'form',
    children: [
      ...def.fields.map(component),
      {
        type: 'Footer',
        label: cut(def.submitLabel ?? builtin(CORE_MESSAGES.formSubmit, opts.lang), FLOW_LIMITS.footerLabel),
        'on-click-action': { name: 'complete', payload },
      },
    ],
  })
  return {
    version: opts.version ?? DEFAULT_FLOW_JSON_VERSION,
    screens: [{
      id: flowScreenId(def),
      title: cut(def.title ?? def.id, FLOW_LIMITS.heading),
      terminal: true,
      success: true,
      data: {},
      layout: { type: 'SingleColumnLayout', children },
    }],
  }
}

/**
 * Human-readable notes about what {@link toFlowJson} had to adapt for WhatsApp
 * (truncated labels/options, too many options, a CTA with emoji…). Empty when
 * the form maps 1:1. Handy as a CI check before publishing.
 */
export function flowJsonWarnings(def: FormDefinition): string[] {
  const out: string[] = []
  const long = (what: string, text: string | undefined, max: number) => {
    if (text !== undefined && Array.from(text).length > max) out.push(`${what} is longer than ${max} characters and will be truncated: ${JSON.stringify(text)}`)
  }
  long('cta', def.cta, FLOW_LIMITS.cta)
  if (def.cta && /\p{Extended_Pictographic}/u.test(def.cta)) out.push('cta must not contain emoji (Meta rejects it)')
  long('submitLabel', def.submitLabel, FLOW_LIMITS.footerLabel)
  long('title', def.title, FLOW_LIMITS.heading)
  for (const f of def.fields) {
    long(`field "${f.name}" label`, f.label, labelLimit(f))
    long(`field "${f.name}" helper`, f.helper, FLOW_LIMITS.helperText)
    if (f.type === 'select' || f.type === 'multiselect') {
      const entries = formOptionEntries(f.options)
      const max = f.type === 'select' ? FLOW_LIMITS.dropdownOptions : FLOW_LIMITS.groupOptions
      if (entries.length > max) out.push(`field "${f.name}" has ${entries.length} options; WhatsApp allows ${max}`)
      for (const [, title] of entries) long(`field "${f.name}" option`, title, FLOW_LIMITS.optionTitle)
    }
    if (f.type === 'text' && f.pattern !== undefined) out.push(`field "${f.name}" pattern is only checked by the bot after submission, not inside WhatsApp`)
  }
  if (def.fields.filter((f) => f.type === 'optin').length > 5) out.push('WhatsApp allows at most 5 opt-ins per screen')
  return out
}

/** `nativeId` → FlowRef: an all-digits id is a Flow id, anything else a Flow name. */
export function flowRefOf(nativeId: string): FlowRef {
  return /^\d+$/.test(nativeId) ? { flowId: nativeId } : { flowName: nativeId }
}

/** Build the interactive `flow` message that opens a published static Flow. */
export function toFlowMessage(content: FormContent, ref?: FlowRef): Record<string, unknown> {
  const flow = ref ?? (content.nativeId !== undefined ? flowRefOf(content.nativeId) : undefined)
  if (!flow?.flowId && !flow?.flowName) {
    throw new UnsupportedContentError(
      'form',
      `No WhatsApp Flow is mapped to form "${content.form.id}". Publish toFlowJson(definition) (or provider.publishForm()) ` +
        'and set CloudAPIProviderConfig.flows or .form(def, { nativeId }).',
    )
  }
  const def = content.form
  // Bot-sent forms arrive with cta/body already localized (ctx.form → withFormDefaults);
  // these fallbacks only cover direct sends of a bare definition.
  const fallbackCta = builtin(CORE_MESSAGES.formCta)
  const cta = cut((def.cta ?? fallbackCta).replace(/\p{Extended_Pictographic}/gu, '').trim() || fallbackCta, FLOW_LIMITS.cta)
  return {
    type: 'interactive',
    interactive: {
      type: 'flow',
      ...(def.title ? { header: { type: 'text', text: cut(def.title, 60) } } : {}),
      body: { text: def.intro ?? def.title ?? builtin(CORE_MESSAGES.formBody) },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: FLOW_MESSAGE_VERSION,
          flow_token: content.token,
          ...(flow.flowId ? { flow_id: flow.flowId } : { flow_name: flow.flowName }),
          flow_cta: cta,
          flow_action: 'navigate',
          flow_action_payload: { screen: flowScreenId(def) },
          ...(flow.mode === 'draft' ? { mode: 'draft' } : {}),
        },
      },
    },
  }
}
