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
import { CORE_MESSAGES as M } from '../i18n/builtins.js'
import type { Translate } from '../i18n/types.js'
import { parseTimerDuration } from '../utils/timers.js'
import { newFormToken, parseFormReply } from './reply.js'
import { withFormDefaults } from './defaults.js'
import type { FormDefinition, FormField, FormStepOptions, FormValue, FormValues } from './types.js'
import { formOptionEntries, isFieldRequired, parseFieldAnswer, selectionBounds, validateFormValues } from './validate.js'

/** The bits of a Bot-built `MessageContext` a form step uses (absent on bare runtime messages). */
interface FormCapableContext {
  capabilities?: ProviderCapabilities
  form?(definition: FormDefinition, opts?: { token?: string; nativeId?: string }): Promise<unknown>
  canRenderForm?(definition: FormDefinition, opts?: { nativeId?: string }): boolean
}

/**
 * Whether a step with `opts` renders natively for `ctx`. In auto mode, with
 * `def`, a provider that says it cannot render that form right now
 * (`canRenderForm() === false`, e.g. no WhatsApp Flow mapped to it) degrades
 * up front instead of sending a form message that is bound to fail.
 */
export function resolveFormMode(ctx: RuntimeMessage, opts: FormStepOptions = {}, def?: FormDefinition): 'native' | 'degraded' {
  const mode = opts.mode ?? 'auto'
  if (mode !== 'auto') return mode
  const fc = ctx as RuntimeMessage & FormCapableContext
  if (fc.capabilities?.forms !== 'native' || typeof fc.form !== 'function') return 'degraded'
  if (def && typeof fc.canRenderForm === 'function'
    && !fc.canRenderForm(def, opts.nativeId !== undefined ? { nativeId: opts.nativeId } : undefined)) return 'degraded'
  return 'native'
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
  const mode = resolveFormMode(ctx, opts, def)
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
  const timeoutMs = timeout === undefined ? undefined : parseTimerDuration(timeout, 'form timeout')
  let invalid = 0
  const strike = (): void => { if (++invalid >= retries) throw new RetriesExceeded() }

  for (;;) {
    const token = newFormToken(def.id)
    try {
      // Defaults in the language of the latest message (c.t), not the one that entered the flow.
      await fc.form(withFormDefaults(def, c.t), { token, nativeId: opts.nativeId })
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
        const result = validateFormValues(def, reply.values, c.t)
        if (result.ok) return result.values
        strike()
        await c.say(result.errors.map((e) => e.message).join('\n'))
        break   // re-send a fresh form
      }
      strike()
      await c.say(opts.pendingMessage ?? c.t(M.formPending))
    }
  }
}

function questionFor(field: FormField, skipWord: string, t: Translate): string {
  const lines = [field.prompt ?? field.label]
  if (!field.prompt && field.helper) lines.push(`_${field.helper}_`)
  switch (field.type) {
    case 'select':
      lines.push('', ...formOptionEntries(field.options).map(([, label], i) => `${i + 1}) ${label}`))
      break
    case 'multiselect': {
      const { min, max } = selectionBounds(field)
      lines.push('', ...formOptionEntries(field.options).map(([, label], i) => `${i + 1}) ${label}`))
      lines.push('', max > 1 ? (min > 1 ? t(M.formPickBetween, { min, max }) : t(M.formPickUpTo, { max })) : t(M.formPickOne))
      break
    }
    case 'optin':
      lines.push('', t(M.formYesNo))
      break
    case 'date':
      if (!field.prompt) lines.push(t(M.formDateHint))
      break
    default:
      break
  }
  if (!isFieldRequired(field) && field.type !== 'optin') lines.push(t(M.formSkipHint, { word: skipWord }))
  return lines.join('\n')
}

async function runDegraded(
  def: FormDefinition,
  c: ConversationControls,
  opts: FormStepOptions,
  timeout: number | string | undefined,
): Promise<FormValues> {
  const skipWord = opts.skipWord ?? c.t(M.formSkipWord)
  const intro = [def.title ? `*${def.title}*` : undefined, def.intro].filter(Boolean).join('\n')
  if (intro) await c.say(intro)
  const values: FormValues = {}
  for (const field of def.fields) {
    let parsed: FormValue | undefined
    await c.ask(questionFor(field, skipWord, c.t), {
      timeout,
      retries: opts.retries,
      validate: (body) => {
        const r = parseFieldAnswer(field, body, skipWord, c.t)
        if (!r.ok) return r.message
        parsed = r.value
        return true
      },
    })
    if (parsed !== undefined) values[field.name] = parsed
  }
  return values
}
