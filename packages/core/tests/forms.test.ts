import { describe, it, expect, vi } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { describeFlows, type FlowGraph } from '../src/flows/describe.js'
import { lintFlows } from '../src/flows/lint.js'
import type { FormDefinition, FormContent } from '../src/forms/types.js'
import {
  assertFormDefinition, parseFieldAnswer, parseFormDate, validateFormValues,
} from '../src/forms/validate.js'
import { formReplyBody, parseFormReply } from '../src/forms/reply.js'
import { UnsupportedContentError, type OutboundContent } from '../src/core/provider.js'
import * as core from '../src/index.js'

const signup: FormDefinition = {
  id: 'signup',
  title: 'Registro',
  intro: 'Completa tus datos',
  fields: [
    { type: 'text', name: 'name', label: 'Nombre', minLength: 2 },
    { type: 'number', name: 'age', label: 'Edad', min: 18, integer: true },
    { type: 'email', name: 'email', label: 'Correo' },
    { type: 'date', name: 'birthday', label: 'Cumpleaños', required: false },
    { type: 'select', name: 'plan', label: 'Plan', options: { basic: 'Básico', pro: 'Pro' } },
    { type: 'multiselect', name: 'topics', label: 'Temas', options: ['Ventas', 'Soporte', 'Noticias'], maxSelected: 2 },
    { type: 'optin', name: 'terms', label: 'Acepto los términos', required: true },
  ],
}

const lastForm = (outbox: Array<{ content: OutboundContent }>): FormContent | undefined =>
  [...outbox].reverse().map((m) => m.content).find((c): c is FormContent => c.kind === 'form')

describe('form definition checks', () => {
  it('accepts a well-formed definition', () => {
    expect(() => assertFormDefinition(signup)).not.toThrow()
  })

  it.each([
    [{ id: 'bad id', fields: [{ type: 'text', name: 'a', label: 'A' }] }, /id must match/],
    [{ id: 'f', fields: [] }, /at least one field/],
    [{ id: 'f', fields: [{ type: 'text', name: 'a', label: 'A' }, { type: 'email', name: 'a', label: 'B' }] }, /duplicate field name/],
    [{ id: 'f', fields: [{ type: 'select', name: 'a', label: 'A', options: [] }] }, /at least one option/],
    [{ id: 'f', fields: [{ type: 'select', name: 'a', label: 'A', options: ['x', 'x'] }] }, /duplicate option/],
    [{ id: 'f', fields: [{ type: 'date', name: 'a', label: 'A', min: '2024-02-30' }] }, /YYYY-MM-DD/],
    [{ id: 'f', fields: [{ type: 'number', name: 'a', label: 'A', min: 5, max: 1 }] }, /min > max/],
    [{ id: 'f', fields: [{ type: 'multiselect', name: 'a', label: 'A', options: ['x'], minSelected: 2 }] }, /minSelected > maxSelected/],
    [{ id: 'f', fields: [{ type: 'color', name: 'a', label: 'A' }] }, /unknown type/],
    [{ id: 'f', fields: [{ type: 'text', name: 'a', label: ' ' }] }, /label is required/],
  ])('rejects %j at build time', (def, message) => {
    expect(() => flow('x').form(def as unknown as FormDefinition)).toThrow(message)
  })
})

describe('answer parsing (degraded)', () => {
  const field = (name: string) => signup.fields.find((f) => f.name === name)!

  it('coerces each type', () => {
    expect(parseFieldAnswer(field('age'), ' 30 ')).toEqual({ ok: true, value: 30 })
    expect(parseFieldAnswer(field('birthday'), '05/03/1990')).toEqual({ ok: true, value: '1990-03-05' })
    expect(parseFieldAnswer(field('plan'), '2')).toEqual({ ok: true, value: 'pro' })
    expect(parseFieldAnswer(field('plan'), 'básico')).toEqual({ ok: true, value: 'basic' })
    expect(parseFieldAnswer(field('topics'), '3, 1')).toEqual({ ok: true, value: ['Ventas', 'Noticias'] })
    expect(parseFieldAnswer(field('topics'), '1 2')).toEqual({ ok: true, value: ['Ventas', 'Soporte'] })
    expect(parseFieldAnswer(field('terms'), 'sí')).toEqual({ ok: true, value: true })
  })

  it('rejects ambiguous grouped numbers instead of misreading them', () => {
    const n = { type: 'number', name: 'n', label: 'N' } as const
    expect(parseFieldAnswer(n, '1.500').ok).toBe(false)
    expect(parseFieldAnswer(n, '1,500').ok).toBe(false)
    expect(parseFieldAnswer(n, '12.345.678').ok).toBe(false)
    expect(parseFieldAnswer(n, '1.5')).toEqual({ ok: true, value: 1.5 })
    expect(parseFieldAnswer(n, '1,5')).toEqual({ ok: true, value: 1.5 })
    expect(parseFieldAnswer(n, '1500')).toEqual({ ok: true, value: 1500 })
    expect(parseFieldAnswer(n, '0,25')).toEqual({ ok: true, value: 0.25 })
    expect(parseFieldAnswer(n, '1.5000')).toEqual({ ok: true, value: 1.5 })
    expect(validateFormValues({ id: 'f', fields: [n] }, { n: '1.500' }).ok).toBe(false)
    expect(validateFormValues({ id: 'f', fields: [n] }, { n: 1500 })).toMatchObject({ ok: true, values: { n: 1500 } })
  })

  it('rejects invalid answers with a message', () => {
    expect(parseFieldAnswer(field('age'), '17').ok).toBe(false)
    expect(parseFieldAnswer(field('age'), '18.5').ok).toBe(false)
    expect(parseFieldAnswer(field('email'), 'no-es-correo').ok).toBe(false)
    expect(parseFieldAnswer(field('topics'), '1,2,3').ok).toBe(false)
    expect(parseFieldAnswer(field('terms'), 'no').ok).toBe(false)
    expect(parseFieldAnswer(field('name'), 'A').ok).toBe(false)
    expect(parseFieldAnswer({ ...field('name'), error: 'Mal' } as never, 'A')).toEqual({ ok: false, message: 'Mal' })
  })

  it('skips optional fields with the skip word only', () => {
    expect(parseFieldAnswer(field('birthday'), 'Omitir')).toEqual({ ok: true, value: undefined })
    expect(parseFieldAnswer(field('name'), 'omitir')).toEqual({ ok: true, value: 'omitir' })
  })

  it('parses dates strictly', () => {
    expect(parseFormDate('2024-02-29')).toBe('2024-02-29')
    expect(parseFormDate('2023-02-29')).toBeUndefined()
    expect(parseFormDate('1-1-2024')).toBe('2024-01-01')
    expect(parseFormDate('mañana')).toBeUndefined()
  })
})

describe('validateFormValues (native submissions)', () => {
  it('normalizes and drops unknown keys', () => {
    const r = validateFormValues(signup, {
      name: 'Ana', age: '30', email: 'ana@x.co', birthday: '', plan: 'pro', topics: ['Soporte'], terms: true, flow_token: 't', extra: 1,
    })
    expect(r).toEqual({ ok: true, values: { name: 'Ana', age: 30, email: 'ana@x.co', plan: 'pro', topics: ['Soporte'], terms: true } })
  })

  it('re-validates everything server side', () => {
    const r = validateFormValues(signup, { name: 'Ana', age: 12, email: 'x', plan: 'gold', topics: ['Nope'], terms: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.field)).toEqual(['age', 'email', 'plan', 'topics', 'terms'])
  })

  it('treats an absent optional opt-in as false and legacy epoch dates as ISO', () => {
    const def: FormDefinition = { id: 'f', fields: [{ type: 'optin', name: 'news', label: 'Novedades' }, { type: 'date', name: 'd', label: 'D' }] }
    expect(validateFormValues(def, { d: String(Date.UTC(2024, 4, 6)) })).toEqual({ ok: true, values: { news: false, d: '2024-05-06' } })
  })
})

describe('form reply wire format', () => {
  it('round-trips and rejects non-replies', () => {
    expect(parseFormReply(formReplyBody({ token: 't1', values: { a: 1 } }))).toEqual({ token: 't1', values: { a: 1 } })
    expect(parseFormReply(formReplyBody({ values: {} }))).toEqual({ values: {} })
    expect(parseFormReply('hola')).toBeUndefined()
    expect(parseFormReply('{"token":"x"}')).toBeUndefined()
    expect(parseFormReply('[1]')).toBeUndefined()
  })
})

describe('flow().form() — degraded (provider without native forms)', () => {
  it('asks field by field and stores normalized answers in c.state', async () => {
    const { bot, chat, provider } = await createTestBot()
    const seen: Record<string, unknown>[] = []
    bot.use(flow('registro').form(signup).do((_ctx, c) => { seen.push({ ...c.state }) }).say('listo'))
    await chat.send('registro')
    await chat.expectReply('Completa tus datos')
    await chat.expectReply('Nombre')
    await chat.send('Ana')
    await chat.expectReply('Edad')
    await chat.send('17')
    await chat.expectReply('mínimo es 18')
    await chat.send('30')
    await chat.expectReply('Correo')
    await chat.send('ana@example.com')
    await chat.expectReply('omitir')
    await chat.send('omitir')
    await chat.expectReply(/Plan\n\n1\) Básico\n2\) Pro/)
    await chat.send('2')
    await chat.expectReply('Temas')
    await chat.send('1, 3')
    await chat.expectReply(/Acepto los términos[\s\S]*1\) Sí/)
    await chat.send('si')
    await chat.expectReply('listo')
    expect(seen[0].signup).toEqual({ name: 'Ana', age: 30, email: 'ana@example.com', plan: 'pro', topics: ['Ventas', 'Noticias'], terms: true })
    expect(provider.outbox.some((m) => m.content.kind === 'form')).toBe(false)
    await bot.stop()
  })

  it('honours stateKey + flatten and mode: degraded on a native provider', async () => {
    const { bot, chat, provider } = await createTestBot()
    provider.capabilities.forms = 'native'
    const seen: Record<string, unknown>[] = []
    const def: FormDefinition = { id: 'mini', fields: [{ type: 'text', name: 'city', label: 'Ciudad' }] }
    bot.use(flow('mini').form(def, { stateKey: 'answers', flatten: true, mode: 'degraded' }).do((_ctx, c) => { seen.push({ ...c.state }) }))
    await chat.send('mini')
    await chat.expectReply('Ciudad')
    await chat.send('Bogotá')
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ answers: { city: 'Bogotá' }, city: 'Bogotá' })
    expect(provider.outbox.some((m) => m.content.kind === 'form')).toBe(false)
    await bot.stop()
  })
})

describe('flow().form() — native (capabilities.forms = native)', () => {
  const contact: FormDefinition = {
    id: 'contact',
    fields: [
      { type: 'text', name: 'name', label: 'Nombre' },
      { type: 'number', name: 'qty', label: 'Cantidad', min: 1 },
    ],
  }

  it('sends one form message and stores the matching submission', async () => {
    const { bot, chat, provider } = await createTestBot()
    provider.capabilities.forms = 'native'
    const seen: Record<string, unknown>[] = []
    bot.use(flow('pedido').form(contact, { nativeId: '123' }).do((_ctx, c) => { seen.push({ ...c.state }) }).say('ok'))
    await chat.send('pedido')
    await vi.waitFor(() => expect(lastForm(provider.outbox)).toBeDefined())
    const sent = lastForm(provider.outbox)!
    expect(sent.form).toBe(contact)
    expect(sent.nativeId).toBe('123')
    expect(sent.token).toMatch(/^contact\./)

    // A reply to some older form is ignored; plain text gets a reminder.
    await chat.send(formReplyBody({ token: 'contact.old', values: { name: 'X', qty: 1 } }), { type: 'form' })
    await chat.send('hola?')
    await chat.expectReply('Completa el formulario')
    await chat.send(formReplyBody({ token: sent.token, values: { name: 'Ana', qty: '3' } }), { type: 'form' })
    await chat.expectReply('ok')
    expect(seen[0].contact).toEqual({ name: 'Ana', qty: 3 })
    await bot.stop()
  })

  it('re-sends a fresh form when the submission fails server-side validation', async () => {
    const { bot, chat, provider } = await createTestBot()
    provider.capabilities.forms = 'native'
    bot.use(flow('pedido').form(contact).say((_ctx, c) => `qty=${(c.state.contact as { qty: number }).qty}`))
    await chat.send('pedido')
    await vi.waitFor(() => expect(lastForm(provider.outbox)).toBeDefined())
    const first = lastForm(provider.outbox)!
    await chat.send(formReplyBody({ token: first.token, values: { name: 'Ana', qty: 0 } }), { type: 'form' })
    await chat.expectReply('el mínimo es 1')
    await vi.waitFor(() => expect(lastForm(provider.outbox)?.token).not.toBe(first.token))
    const second = lastForm(provider.outbox)!
    await chat.send(formReplyBody({ token: second.token, values: { name: 'Ana', qty: 2 } }), { type: 'form' })
    await chat.expectReply('qty=2')
    await bot.stop()
  })

  it('ends with the retries message after too many non-submissions', async () => {
    const { bot, chat, provider } = await createTestBot({ conversation: { retriesMessage: 'demasiados intentos' } })
    provider.capabilities.forms = 'native'
    bot.use(flow('pedido').form(contact, { retries: 2, pendingMessage: 'usa el formulario' }).say('nunca'))
    await chat.send('pedido')
    await vi.waitFor(() => expect(lastForm(provider.outbox)).toBeDefined())
    await chat.send('a')
    await chat.expectReply('usa el formulario')
    await chat.send('b')
    await chat.expectReply('demasiados intentos')
    expect(chat.replies()).not.toContain('nunca')
    await bot.stop()
  })

  it('asks field by field without sending when the provider has no native form for it (auto mode)', async () => {
    const { bot, chat, provider } = await createTestBot()
    provider.capabilities.forms = 'native'
    const asked: Array<[string, string | undefined]> = []
    ;(provider as { canRenderForm?: (d: FormDefinition, o?: { nativeId?: string }) => boolean }).canRenderForm =
      (d, o) => { asked.push([d.id, o?.nativeId]); return false }
    const sendSpy = vi.spyOn(provider, 'send')
    bot.use(flow('pedido').form(contact, { nativeId: '9' }).say((_ctx, c) => `hola ${(c.state.contact as { name: string }).name}`))
    await chat.send('pedido')
    await chat.expectReply('Nombre')
    await chat.send('Ana')
    await chat.expectReply('Cantidad')
    await chat.send('2')
    await chat.expectReply('hola Ana')
    expect(asked).toEqual([['contact', '9']])
    expect(sendSpy.mock.calls.some(([, content]) => content.kind === 'form')).toBe(false)
    expect(lastForm(provider.outbox)).toBeUndefined()
    await bot.stop()
  })

  it('sends natively when the provider confirms it can render the form', async () => {
    const { bot, chat, provider } = await createTestBot()
    provider.capabilities.forms = 'native'
    ;(provider as { canRenderForm?: () => boolean }).canRenderForm = () => true
    bot.use(flow('pedido').form(contact).say('ok'))
    await chat.send('pedido')
    await vi.waitFor(() => expect(lastForm(provider.outbox)).toBeDefined())
    await bot.stop()
  })

  it('falls back to degraded questions when the provider rejects the form (auto mode)', async () => {
    const { bot, chat, provider } = await createTestBot()
    provider.capabilities.forms = 'native'
    const send = provider.send.bind(provider)
    provider.send = async (chatId, content, opts) => {
      if (content.kind === 'form') throw new UnsupportedContentError('form', 'no flow published')
      return send(chatId, content, opts)
    }
    bot.use(flow('pedido').form(contact).say((_ctx, c) => `hola ${(c.state.contact as { name: string }).name}`))
    await chat.send('pedido')
    await chat.expectReply('Nombre')
    await chat.send('Ana')
    await chat.expectReply('Cantidad')
    await chat.send('2')
    await chat.expectReply('hola Ana')
    await bot.stop()
  })
})

describe('describe() / lint() support', () => {
  it('draws a form node with its fields', () => {
    const f = flow('registro').timeout('2m').form(signup, { stateKey: 'datos' }).say('fin')
    const graph = describeFlows([f], { format: 'json' }) as FlowGraph
    const node = graph.nodes.find((n) => n.kind === 'form')!
    expect(node).toMatchObject({ text: 'Registro', stateKey: 'datos', timeoutMs: 120_000, timeoutSource: 'flow' })
    expect(node.form?.mode).toBe('auto')
    expect(node.form?.fields.map((x) => `${x.name}:${x.type}:${x.required}`)).toEqual([
      'name:text:true', 'age:number:true', 'email:email:true', 'birthday:date:false', 'plan:select:true', 'topics:multiselect:true', 'terms:optin:true',
    ])
    expect(node.form?.fields.find((x) => x.name === 'plan')?.options).toEqual(['basic', 'pro'])
    const mermaid = describeFlows([f])
    expect(mermaid).toContain('[/"form: Registro → datos')
    expect(mermaid).toContain('birthday?:date')
  })

  it('checks form timeouts and state-key collisions', () => {
    const d = lintFlows([flow('a').ask('¿?', 'signup', { timeout: '1m' }).form(signup, { timeout: '2 minutos' })])
    expect(d.map((x) => x.code).sort()).toEqual(['form-state-collision', 'invalid-timeout'])
    expect(lintFlows([flow('b').timeout('1m').form(signup)])).toEqual([])
    expect(lintFlows([flow('c').form(signup)]).map((x) => x.code)).toEqual(['missing-timeout'])
  })

  it('exports the forms API from the package root', () => {
    expect(typeof core.runFormStep).toBe('function')
    expect(typeof core.parseFormReply).toBe('function')
    expect(typeof core.validateFormValues).toBe('function')
    expect(typeof core.assertFormDefinition).toBe('function')
  })
})
