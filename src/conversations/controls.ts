import type { ConversationRuntime, ConversationHandle, RuntimeMessage, ConversationControlsBase } from './ConversationRuntime.js'
import { ConversationEnded, ConversationGoto, RetriesExceeded } from './errors.js'
import { parseDuration } from '../utils/duration.js'
import { normalizeText } from '../core/matching.js'
import type { WaitOptions } from '../core/types.js'

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const
type MediaType = (typeof MEDIA_TYPES)[number]

export interface ConversationControls extends ConversationControlsBase {
  ask(text: string, opts?: WaitOptions): Promise<string>
  waitText(opts?: WaitOptions): Promise<string>
  waitMedia(types?: MediaType[], opts?: WaitOptions): Promise<RuntimeMessage>
  choose(prompt: string, options: Record<string, string>, opts?: WaitOptions): Promise<string>
  goto(name: string, args?: unknown): never
}

export function createControls(rt: ConversationRuntime, handle: ConversationHandle, ctx: RuntimeMessage): ConversationControls {
  const timeoutOf = (o?: WaitOptions) => (o?.timeout !== undefined ? parseDuration(o.timeout) : undefined)

  const rawWait = (o?: WaitOptions) => rt.wait(handle, { timeoutMs: timeoutOf(o), filter: o?.filter })

  async function loopWait<T>(
    opts: WaitOptions | undefined,
    accept: (m: RuntimeMessage) => Promise<{ ok: true; value: T } | { ok: false; message: string }>,
  ): Promise<T> {
    const retries = opts?.retries ?? 3
    let attempts = 0
    for (;;) {
      const m = await rawWait(opts)
      const r = await accept(m)
      if (r.ok) return r.value
      attempts++
      if (attempts >= retries) throw new RetriesExceeded()
      await ctx.reply(r.message)
    }
  }

  const controls: ConversationControls = {
    say: async (text) => { rt.assertAlive(handle); await ctx.reply(text) },
    state: rt.getState(handle),
    end: (farewell) => { throw new ConversationEnded(farewell) },
    goto: (name, args) => { throw new ConversationGoto(name, args) },
    waitAny: (o) => rawWait(o as WaitOptions),

    waitText: (opts) => loopWait<string>(opts, async (m) => {
      if (m.type !== 'text') return { ok: false, message: opts?.otherwise ?? '✍️ Escribe tu respuesta como texto.' }
      const v = opts?.validate ? await opts.validate(m.body, m) : true
      return v === true
        ? { ok: true, value: m.body }
        : { ok: false, message: typeof v === 'string' ? v : '❌ Entrada inválida, intenta de nuevo.' }
    }),

    ask: async (text, opts) => { rt.assertAlive(handle); await ctx.reply(text); return controls.waitText(opts) },

    waitMedia: (types = [...MEDIA_TYPES], opts) => loopWait<RuntimeMessage>(opts, async (m) => {
      return (types as string[]).includes(m.type)
        ? { ok: true, value: m }
        : { ok: false, message: opts?.otherwise ?? '📎 Envía un archivo válido.' }
    }),

    choose: async (prompt, options, opts) => {
      const keys = Object.keys(options)
      const menu = `${prompt}\n\n${keys.map((k, i) => `${i + 1}) ${options[k]}`).join('\n')}`
      rt.assertAlive(handle)
      await ctx.reply(menu)
      return loopWait<string>(opts, async (m) => {
        const body = normalizeText(m.body)
        const byIndex = /^\d+$/.test(body) ? keys[parseInt(body, 10) - 1] : undefined
        const byKey = keys.find((k) => normalizeText(k) === body)
        const byLabel = keys.find((k) => normalizeText(options[k]) === body)
        const picked = byIndex ?? byKey ?? byLabel
        return picked
          ? { ok: true, value: picked }
          : { ok: false, message: opts?.otherwise ?? menu }
      })
    },
  }
  return controls
}
