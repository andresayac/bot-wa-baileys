/**
 * Runtime of a `flow().form()` step: native (one form message + its submission)
 * when the provider declares `capabilities.forms === 'native'`, otherwise
 * degraded into one question per field. Both paths validate with the same rules
 * and store the same {@link FormValues} in `c.state`.
 */

import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'
import type { ConversationControls } from '../conversations/controls.js'
import { RetriesExceeded } from '../conversations/errors.js'
import { DEFAULT_RETRIES } from '../conversations/retry.js'
import { UnsupportedContentError, type ProviderCapabilities } from '../core/provider.js'
import { parseDuration } from '../utils/duration.js'
import { newFormToken, parseFormReply } from './reply.js'
import type { FormDefinition, FormField, FormStepOptions, FormValue, FormValues } from './types.js'
import { formOptionEntries, isFieldRequired, parseFieldAnswer, selectionBounds, validateFormValues } from './validate.js'

/** The bits of a Bot-built `MessageContext` a form step uses (absent on bare runtime messages). */
interface FormCapableContext {
  capabilities?: ProviderCapabilities
  form?(definition: FormDefinition, opts?: { token?: string; nativeId?: string }): Promise<unknown>
}

const DEFAULT_PENDING = '👆 Completa el formulario de arriba para continuar.'

/** Whether a step with `opts` renders natively for `ctx`. */
export function resolveFormMode(ctx: RuntimeMessage, opts: FormStepOptions = {}): 'native' | 'degraded' {
  const mode = opts.mode ?? 'auto'
  if (mode !== 'auto') return mode
  const fc = ctx as RuntimeMessage & FormCapableContext
  return fc.capabilities?.forms === 'native' && typeof fc.form === 'function' ? 'native' : 'degraded'
}

/**
 * Run a form step and store its answers (`c.state[opts.stateKey ?? def.id]`,
 * plus each field with `flatten`). Resolves with the answers.
 */
export async function runFormStep(
  def: FormDefinition,
  ctx: RuntimeMessage,
  c: ConversationControls,
  opts: FormStepOptions = {},
  flowTimeoutMs?: number,
): Promise<FormValues> {
  const timeout = opts.timeout ?? flowTimeoutMs
  const mode = resolveFormMode(ctx, opts)
  let values: FormValues
  if (mode === 'native') {
    const native = await runNative(def, ctx, c, opts, timeout)
    values = native ?? await runDegraded(def, c, opts, timeout)
  } else {
    values = await runDegraded(def, c, opts, timeout)
  }
  c.state[opts.stateKey ?? def.id] = values
  if (opts.flatten) Object.assign(c.state, values)
  return values
}

/** `undefined` → the provider could not render it (auto mode falls back to degraded). */
async function runNative(
  def: FormDefinition,
  ctx: RuntimeMessage,
  c: ConversationControls,
  opts: FormStepOptions,
  timeout: number | string | undefined,
): Promise<FormValues | undefined> {
  const fc = ctx as RuntimeMessage & FormCapableContext
  if (typeof fc.form !== 'function') {
    throw new UnsupportedContentError('form', `form "${def.id}": native mode needs a Bot context whose provider renders forms`)
  }
  const retries = opts.retries ?? DEFAULT_RETRIES
  const timeoutMs = timeout === undefined ? undefined : parseDuration(timeout)
  let invalid = 0
  const strike = (): void => { if (++invalid >= retries) throw new RetriesExceeded() }

  for (;;) {
    const token = newFormToken(def.id)
    try {
      await fc.form(def, { token, nativeId: opts.nativeId })
    } catch (error) {
      if ((opts.mode ?? 'auto') === 'auto' && error instanceof UnsupportedContentError) return undefined
      throw error
    }
    for (;;) {
      const m = await c.waitAny({ timeoutMs })
      if (m.type === 'form') {
        const reply = parseFormReply(m.body)
        // A reply to an older form message (or garbage): ignore it, keep waiting.
        if (!reply || (reply.token !== undefined && reply.token !== token)) continue
        const result = validateFormValues(def, reply.values)
        if (result.ok) return result.values
        strike()
        await c.say(result.errors.map((e) => e.message).join('\n'))
        break   // re-send a fresh form
      }
      strike()
      await c.say(opts.pendingMessage ?? DEFAULT_PENDING)
    }
  }
}

function questionFor(field: FormField, skipWord: string): string {
  const lines = [field.prompt ?? field.label]
  if (!field.prompt && field.helper) lines.push(`_${field.helper}_`)
  switch (field.type) {
    case 'select':
      lines.push('', ...formOptionEntries(field.options).map(([, label], i) => `${i + 1}) ${label}`))
      break
    case 'multiselect': {
      const { min, max } = selectionBounds(field)
      lines.push('', ...formOptionEntries(field.options).map(([, label], i) => `${i + 1}) ${label}`))
      lines.push('', max > 1 ? `Puedes elegir ${min > 1 ? `entre ${min} y ${max}` : `hasta ${max}`}, separadas por coma (ej. 1, 3).` : 'Elige una.')
      break
    }
    case 'optin':
      lines.push('', '1) Sí', '2) No')
      break
    case 'date':
      if (!field.prompt) lines.push('(AAAA-MM-DD o DD/MM/AAAA)')
      break
    default:
      break
  }
  if (!isFieldRequired(field) && field.type !== 'optin') lines.push(`(escribe "${skipWord}" para saltar)`)
  return lines.join('\n')
}

async function runDegraded(
  def: FormDefinition,
  c: ConversationControls,
  opts: FormStepOptions,
  timeout: number | string | undefined,
): Promise<FormValues> {
  const skipWord = opts.skipWord ?? 'omitir'
  const intro = [def.title ? `*${def.title}*` : undefined, def.intro].filter(Boolean).join('\n')
  if (intro) await c.say(intro)
  const values: FormValues = {}
  for (const field of def.fields) {
    let parsed: FormValue | undefined
    await c.ask(questionFor(field, skipWord), {
      timeout,
      retries: opts.retries,
      validate: (body) => {
        const r = parseFieldAnswer(field, body, skipWord)
        if (!r.ok) return r.message
        parsed = r.value
        return true
      },
    })
    if (parsed !== undefined) values[field.name] = parsed
  }
  return values
}
