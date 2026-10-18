/**
 * Localized defaults of a native form message. Applied by `ctx.form()` (and so by
 * `flow().form()`) right before the form is sent, so a provider only renders what
 * it receives and never falls back to a hard-coded language.
 */

import { CORE_MESSAGES as M } from '../i18n/builtins.js'
import type { Translate } from '../i18n/types.js'
import type { FormDefinition } from './types.js'

/**
 * A copy of `def` with `cta` / `submitLabel` defaulted from `core.form.cta` /
 * `core.form.submit` and, when it has neither `intro` nor `title`, `intro` from
 * `core.form.body`. Explicit values are kept; `def` is never mutated.
 */
export function withFormDefaults(def: FormDefinition, t: Translate): FormDefinition {
  if (def.cta !== undefined && def.submitLabel !== undefined && (def.intro !== undefined || def.title !== undefined)) return def
  return {
    ...def,
    cta: def.cta ?? t(M.formCta),
    submitLabel: def.submitLabel ?? t(M.formSubmit),
    ...(def.intro === undefined && def.title === undefined ? { intro: t(M.formBody) } : {}),
  }
}
