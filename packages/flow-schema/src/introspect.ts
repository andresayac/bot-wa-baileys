/**
 * Reverse export: an introspectable `CompiledFlow` → JSON flow document.
 *
 * Steps compiled from a document carry their original JSON (`FLOW_STEP_SOURCE`), so a
 * round trip is exact. Flows written with the DSL are introspected where the compiled
 * step is declarative (`say`, `ask`, `choose`, `goto`, `delay`, `media`, `form`, `use`);
 * anything opaque (`do`, a guard function, a `validate` callback) is reported as an
 * issue instead of being silently dropped.
 */

import type { CompiledFlow, CompiledStep, FormDefinition, FormField, Trigger } from '@bot-wa/core'
import { flowDocumentSource, flowStepSource } from './compile.js'
import type { FlowDocument, FlowDocumentIssue, FlowFormDocument, FlowFormFieldDocument, FlowMediaDocumentSource, FlowStepDocument } from './schema.js'

/** Thrown when a compiled flow cannot be represented as a JSON document. */
export class FlowExportError extends Error {
  constructor(readonly issues: FlowDocumentIssue[]) {
    super(`flow cannot be exported: ${issues.slice(0, 3).map((i) => `${i.path || '/'} ${i.message}`).join('; ')}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ''}`)
    this.name = 'FlowExportError'
  }
}

/**
 * Export a compiled flow as a v1 JSON document. Throws {@link FlowExportError} listing
 * every step that cannot be represented.
 */
export function exportFlowDocument(flow: CompiledFlow): FlowDocument {
  const issues: FlowDocumentIssue[] = []
  const steps: FlowStepDocument[] = []
  flow.steps.forEach((step, index) => {
    const path = `/steps/${index}`
    const source = flowStepSource(step)
    if (source) {
      steps.push(source)
      return
    }
    const exported = exportStep(step, path, issues)
    if (exported) steps.push(exported)
  })
  if (issues.length) throw new FlowExportError(issues)
  // A flow compiled from a document keeps its top-level metadata verbatim (`'5m'` does
  // not come back as `300000`); the steps are the ones above, so a mutated step is still
  // exported as it is.
  const source = flowDocumentSource(flow)
  return {
    version: 1,
    id: flow.id,
    trigger: source?.trigger ?? exportTrigger(flow.trigger),
    ...(source?.name !== undefined ? { name: source.name } : {}),
    ...(source?.description !== undefined ? { description: source.description } : {}),
    ...(source?.timeout !== undefined
      ? { timeout: source.timeout }
      : flow.opts?.timeoutMs !== undefined ? { timeout: flow.opts.timeoutMs } : {}),
    ...(source?.persistent === true || flow.opts?.persistent === true ? { persistent: true } : {}),
    steps,
  }
}

function exportTrigger(trigger: Trigger): FlowDocument['trigger'] {
  if (typeof trigger === 'string') return trigger
  if (Array.isArray(trigger)) {
    if (!trigger.every((value): value is string => typeof value === 'string')) {
      throw new FlowExportError([{ path: '/trigger', message: 'the trigger keywords are not all strings' }])
    }
    return [...trigger]
  }
  if (typeof trigger === 'function' || trigger === undefined || trigger === null) {
    throw new FlowExportError([{ path: '/trigger', message: 'the trigger is a function or a non-keyword trigger' }])
  }
  const value = trigger as { pattern?: unknown; keywords?: unknown; match?: unknown; scope?: unknown }
  const keywords = Array.isArray(value.pattern) ? value.pattern : Array.isArray(value.keywords) ? value.keywords : undefined
  if (!keywords || !keywords.every((k): k is string => typeof k === 'string')) {
    throw new FlowExportError([{ path: '/trigger', message: 'the trigger is not a keyword list' }])
  }
  return {
    keywords,
    ...(typeof value.match === 'string' ? { match: value.match as 'equals' | 'contains' | 'startsWith' | 'endsWith' } : {}),
    ...(typeof value.scope === 'string' ? { scope: value.scope as 'dm' | 'group' | 'all' } : {}),
  }
}

function exportStep(step: CompiledStep, path: string, issues: FlowDocumentIssue[]): FlowStepDocument | undefined {
  const fail = (message: string): undefined => { issues.push({ path, message }); return undefined }
  switch (step.kind) {
    case 'say':
      return typeof step.text === 'string' ? { kind: 'say', text: step.text } : fail('say text is a function (no JSON source)')
    case 'ask':
      if (typeof step.text !== 'string') return fail('ask text is a function (no JSON source)')
      if (step.opts?.validate) return fail('ask has a validate callback (no JSON source)')
      return {
        kind: 'ask', text: step.text, stateKey: step.stateKey,
        ...(step.opts?.timeout !== undefined ? { timeout: step.opts.timeout as string | number } : {}),
        ...(step.opts?.retries !== undefined ? { retries: step.opts.retries } : {}),
      }
    case 'choose': {
      if (typeof step.prompt !== 'string') return fail('choose prompt is a function (no JSON source)')
      const options: Array<{ key: string; label: string }> = []
      for (const [key, option] of Object.entries(step.options)) {
        if (option.then) return fail(`choose option "${key}" has a then action (no JSON source)`)
        options.push({ key, label: option.label })
      }
      return { kind: 'choose', text: step.prompt, options, ...(step.stateKey !== undefined ? { stateKey: step.stateKey } : {}), ...(step.opts?.timeout !== undefined ? { timeout: step.opts.timeout as string | number } : {}) }
    }
    case 'goto':
      return { kind: 'goto', target: step.target }
    case 'delay':
      return { kind: 'delay', duration: step.ms }
    case 'media': {
      const source = exportMediaSource(step.source, step.type === 'location')
      if (!source) return fail('media source is a function (no JSON source)')
      return {
        kind: 'media', type: step.type, source,
        ...(typeof step.caption === 'string' ? { caption: step.caption } : {}),
        ...(step.opts?.filename !== undefined ? { filename: step.opts.filename } : {}),
      }
    }
    case 'form':
      return { kind: 'form', form: exportForm(step.form), ...(step.opts?.stateKey !== undefined ? { stateKey: step.opts.stateKey } : {}), ...(step.opts?.flatten !== undefined ? { flatten: step.opts.flatten } : {}), ...(step.opts?.mode !== undefined ? { mode: step.opts.mode } : {}), ...(step.opts?.nativeId !== undefined ? { nativeId: step.opts.nativeId } : {}), ...(step.opts?.timeout !== undefined ? { timeout: step.opts.timeout as string | number } : {}), ...(step.opts?.retries !== undefined ? { retries: step.opts.retries } : {}) }
    case 'use':
      return { kind: 'subflow', flowId: step.flow.id }
    case 'guard':
      return fail('guard check is a function (no JSON source)')
    case 'do':
      return fail('do action is opaque (no JSON source)')
  }
}

function exportMediaSource(source: unknown, location: boolean): FlowMediaDocumentSource | undefined {
  if (typeof source === 'string') return { url: source }
  if (typeof source !== 'object' || source === null) return undefined
  const value = source as Record<string, unknown>
  if (location && typeof value.latitude === 'number' && typeof value.longitude === 'number') {
    return { latitude: value.latitude, longitude: value.longitude, ...(typeof value.name === 'string' ? { name: value.name } : {}), ...(typeof value.address === 'string' ? { address: value.address } : {}) }
  }
  if (typeof value.url === 'string') return { url: value.url }
  return undefined
}

function exportForm(form: FormDefinition): FlowFormDocument {
  return {
    id: form.id,
    ...(form.title !== undefined ? { title: form.title } : {}),
    ...(form.intro !== undefined ? { intro: form.intro } : {}),
    ...(form.cta !== undefined ? { cta: form.cta } : {}),
    ...(form.submitLabel !== undefined ? { submitLabel: form.submitLabel } : {}),
    fields: form.fields.map(exportField),
  }
}

function exportField(field: FormField): FlowFormFieldDocument {
  const base = {
    name: field.name,
    label: field.label,
    type: field.type,
    ...(field.required !== undefined ? { required: field.required } : {}),
    ...(field.helper !== undefined ? { helper: field.helper } : {}),
    ...(field.prompt !== undefined ? { prompt: field.prompt } : {}),
    ...(field.error !== undefined ? { error: field.error } : {}),
  }
  switch (field.type) {
    case 'text':
      return {
        ...base,
        ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        ...(field.pattern !== undefined ? { pattern: typeof field.pattern === 'string' ? field.pattern : field.pattern.source } : {}),
        ...(field.multiline !== undefined ? { multiline: field.multiline } : {}),
      }
    case 'number':
      return { ...base, ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}), ...(field.integer !== undefined ? { integer: field.integer } : {}) }
    case 'email':
      return base
    case 'date':
      return { ...base, ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}) }
    case 'select':
      return { ...base, options: Array.isArray(field.options) ? [...(field.options as readonly string[])] : { ...(field.options as Record<string, string>) } }
    case 'multiselect':
      return {
        ...base,
        options: Array.isArray(field.options) ? [...(field.options as readonly string[])] : { ...(field.options as Record<string, string>) },
        ...(field.minSelected !== undefined ? { minSelected: field.minSelected } : {}),
        ...(field.maxSelected !== undefined ? { maxSelected: field.maxSelected } : {}),
      }
    case 'optin':
      return base
  }
}
