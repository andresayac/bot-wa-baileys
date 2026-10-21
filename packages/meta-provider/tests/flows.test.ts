import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { Bot, flow, parseFormReply, type FormDefinition, type FormContent } from '@botmesh/core'
import { CloudAPIProvider } from '../src/CloudAPIProvider.js'
import { parseInbound, type GraphWebhookBody } from '../src/parseInbound.js'
import { flowJsonWarnings, flowScreenId, toFlowJson, toFlowMessage } from '../src/flows.js'
import { toOutbound } from '../src/toOutbound.js'

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T

const signup: FormDefinition = {
  id: 'signup',
  title: 'Registro',
  intro: 'Completa tus datos',
  submitLabel: 'Registrarme',
  cta: 'Registrarme',
  fields: [
    { type: 'text', name: 'name', label: 'Nombre', minLength: 2 },
    { type: 'number', name: 'age', label: 'Edad', min: 18, integer: true },
    { type: 'email', name: 'email', label: 'Correo', helper: 'Te enviaremos la confirmación' },
    { type: 'date', name: 'birthday', label: 'Cumpleaños', required: false, max: '2010-12-31' },
    { type: 'select', name: 'plan', label: 'Plan', options: { basic: 'Básico', pro: 'Pro' } },
    { type: 'multiselect', name: 'topics', label: 'Temas', options: ['Ventas', 'Soporte', 'Noticias'], maxSelected: 2 },
    { type: 'optin', name: 'terms', label: 'Acepto los términos', required: true },
  ],
}

interface Call { url: string; init?: RequestInit }
function mockFetch(responder: (call: Call) => unknown) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    const body = responder(call)
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
  }))
  return calls
}

const baseCfg = { accessToken: 'TOK', phoneNumberId: 'PNID', verifyToken: 'vt', allowUnsignedWebhooks: true }

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('toFlowJson', () => {
  it('compiles a form into a static single-screen Flow JSON (fixture)', () => {
    expect(toFlowJson(signup)).toEqual(fixture('signup.flow.json'))
  })

  it('uses a Dropdown past 20 options, TextArea for multiline, and a custom version', () => {
    const many = Array.from({ length: 25 }, (_, i) => `Opción ${i + 1}`)
    const json = toFlowJson({
      id: 'big-form',
      fields: [
        { type: 'select', name: 'city', label: 'Ciudad', options: many },
        { type: 'text', name: 'notes', label: 'Notas', multiline: true, maxLength: 300, required: false },
      ],
    }, { version: '7.0' })
    expect(json.version).toBe('7.0')
    expect(json.screens[0].id).toBe('BIG_FORM')
    const form = json.screens[0].layout.children[0] as { children: Array<Record<string, unknown>> }
    expect(form.children[0]).toMatchObject({ type: 'Dropdown', name: 'city' })
    expect(form.children[1]).toEqual({ type: 'TextArea', name: 'notes', label: 'Notas', required: false, 'max-length': 300 })
  })

  it('localizes the default submit label with the lang option (Spanish by default)', () => {
    const def: FormDefinition = { id: 'mini', fields: [{ type: 'text', name: 'x', label: 'X' }] }
    const footer = (json: ReturnType<typeof toFlowJson>) =>
      (json.screens[0].layout.children.at(-1) as { children: Array<{ type: string; label?: string }> }).children.find((c) => c.type === 'Footer')!.label
    expect(footer(toFlowJson(def))).toBe('Enviar')
    expect(footer(toFlowJson(def, { lang: 'en' }))).toBe('Submit')
    expect(footer(toFlowJson(def, { lang: 'en-GB' }))).toBe('Submit')
    expect(footer(toFlowJson({ ...def, submitLabel: 'Go' }, { lang: 'en' }))).toBe('Go')
  })

  it('never emits the reserved SUCCESS screen id and truncates long labels', () => {
    expect(flowScreenId({ id: 'success', fields: [] })).toBe('SUCCESS_FORM')
    const json = toFlowJson({ id: 'f', fields: [{ type: 'text', name: 'a', label: 'Una etiqueta demasiado larga' }] })
    const form = json.screens[0].layout.children[0] as { children: Array<{ label?: string }> }
    expect(Array.from(form.children[0].label!)).toHaveLength(20)
    expect(flowJsonWarnings({ id: 'f', cta: 'Abrir 🚀', fields: [{ type: 'text', name: 'a', label: 'Una etiqueta demasiado larga' }] }))
      .toEqual([
        'cta must not contain emoji (Meta rejects it)',
        'field "a" label is longer than 20 characters and will be truncated: "Una etiqueta demasiado larga"',
      ])
    expect(flowJsonWarnings(signup)).toEqual([])
  })
})

describe('toFlowMessage / toOutbound', () => {
  const content: FormContent = { kind: 'form', form: signup, token: 'signup.T1', nativeId: '1234567890' }

  it('builds the interactive flow message (navigate, flow_id)', () => {
    expect(toOutbound(content)).toEqual({
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: { type: 'text', text: 'Registro' },
        body: { text: 'Completa tus datos' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: 'signup.T1',
            flow_id: '1234567890',
            flow_cta: 'Registrarme',
            flow_action: 'navigate',
            flow_action_payload: { screen: 'SIGNUP' },
          },
        },
      },
    })
  })

  it('accepts a flow name and draft mode', () => {
    const msg = toFlowMessage({ ...content, nativeId: undefined }, { flowName: 'signup_v2', mode: 'draft' }) as {
      interactive: { action: { parameters: Record<string, unknown> } }
    }
    expect(msg.interactive.action.parameters).toMatchObject({ flow_name: 'signup_v2', mode: 'draft' })
    expect(msg.interactive.action.parameters.flow_id).toBeUndefined()
  })

  it('falls back to the Spanish core.form.* labels for a bare definition', () => {
    const bare: FormContent = { kind: 'form', form: { id: 'mini', fields: [{ type: 'text', name: 'x', label: 'X' }] }, token: 't', nativeId: '1' }
    const msg = toFlowMessage(bare) as { interactive: { body: { text: string }; action: { parameters: Record<string, unknown> } } }
    expect(msg.interactive.body.text).toBe('Completa el formulario.')
    expect(msg.interactive.action.parameters.flow_cta).toBe('Abrir formulario')
  })

  it('throws UnsupportedContentError when no Flow is mapped', () => {
    expect(() => toOutbound({ ...content, nativeId: undefined })).toThrow(/No WhatsApp Flow is mapped/)
  })
})

describe('nfm_reply webhook', () => {
  it('becomes a form message with the normalized reply (fixture)', () => {
    const events = parseInbound(fixture<GraphWebhookBody>('nfm_reply.webhook.json'))
    expect(events).toHaveLength(1)
    const e = events[0]
    if (e.kind !== 'message') throw new Error('expected a message')
    expect(e.message.type).toBe('form')
    expect(e.message.chatId).toBe('573001234567')
    expect(e.message.ref.id).toBe('wamid.NFM_REPLY')
    expect(parseFormReply(e.message.body)).toEqual({
      token: 'signup.TOKEN123',
      values: { name: 'Ana', age: '30', email: 'ana@example.com', birthday: '', plan: 'pro', topics: ['Ventas', 'Noticias'], terms: true },
    })
  })

  it('drops an nfm_reply whose response_json is not an object', () => {
    const body = fixture<GraphWebhookBody>('nfm_reply.webhook.json')
    const msg = (body.entry![0].changes![0].value as { messages: Array<{ interactive: { nfm_reply: { response_json: string } } }> }).messages[0]
    msg.interactive.nfm_reply.response_json = 'not json'
    expect(parseInbound(body)).toEqual([])
  })
})

describe('CloudAPIProvider + flow().form()', () => {
  const nfmWebhook = (token: string, values: Record<string, unknown>) => {
    const body = fixture<GraphWebhookBody>('nfm_reply.webhook.json')
    const msg = (body.entry![0].changes![0].value as { messages: Array<{ id: string; interactive: { nfm_reply: { response_json: string } } }> }).messages[0]
    msg.id = `wamid.${token}`
    msg.interactive.nfm_reply.response_json = JSON.stringify({ flow_token: token, ...values })
    return JSON.stringify(body)
  }
  const textWebhook = (text: string, id: string) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'x', changes: [{ field: 'messages', value: { messages: [{ from: '573001234567', id, timestamp: '1', type: 'text', text: { body: text } }] } }] }],
  })
  const sentBodies = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/messages')).map((c) => JSON.parse(c.init!.body as string))

  it('declares native forms', () => {
    const p = new CloudAPIProvider(baseCfg)
    expect(p.capabilities.forms).toBe('native')
    expect(p.capabilities.contentKinds).toContain('form')
  })

  it('sends the mapped Flow and stores the submission in c.state', async () => {
    const calls = mockFetch(() => ({ messages: [{ id: 'wamid.OUT' }] }))
    const provider = new CloudAPIProvider({ ...baseCfg, flows: { signup: '998877' } })
    const bot = new Bot({ provider })
    const seen: Record<string, unknown>[] = []
    bot.use(flow('registro').form(signup).do((_ctx, c) => { seen.push({ ...c.state }) }).say('¡Listo!'))
    await bot.start()

    provider.ingest(textWebhook('registro', 'wamid.IN1'))
    await vi.waitFor(() => expect(sentBodies(calls).some((b) => b.interactive?.type === 'flow')).toBe(true))
    const sent = sentBodies(calls).find((b) => b.interactive?.type === 'flow')
    expect(sent.to).toBe('573001234567')
    const params = sent.interactive.action.parameters
    expect(params.flow_id).toBe('998877')
    expect(params.flow_token).toMatch(/^signup\./)

    provider.ingest(nfmWebhook(params.flow_token, { name: 'Ana', age: '30', email: 'ana@example.com', plan: 'pro', topics: ['Ventas'], terms: true }))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].signup).toEqual({ name: 'Ana', age: 30, email: 'ana@example.com', plan: 'pro', topics: ['Ventas'], terms: true })
    await vi.waitFor(() => expect(sentBodies(calls).some((b) => b.text?.body === '¡Listo!')).toBe(true))
    await bot.stop()
  })

  it('sends the flow CTA and body in the user language (i18n en)', async () => {
    const calls = mockFetch(() => ({ messages: [{ id: 'wamid.OUT' }] }))
    const provider = new CloudAPIProvider({ ...baseCfg, flows: { mini: '55' } })
    const bot = new Bot({ provider, i18n: { defaultLocale: 'en' } })
    bot.use(flow('mini').form({ id: 'mini', fields: [{ type: 'text', name: 'city', label: 'City' }] }))
    await bot.start()
    provider.ingest(textWebhook('mini', 'wamid.IN9'))
    await vi.waitFor(() => expect(sentBodies(calls).some((b) => b.interactive?.type === 'flow')).toBe(true))
    const sent = sentBodies(calls).find((b) => b.interactive?.type === 'flow')
    expect(sent.interactive.action.parameters.flow_cta).toBe('Open form')
    expect(sent.interactive.body.text).toBe('Fill in the form.')
    await bot.stop()
  })

  it('falls back to field-by-field questions when the form has no Flow mapped', async () => {
    const calls = mockFetch(() => ({ messages: [{ id: 'wamid.OUT' }] }))
    const provider = new CloudAPIProvider(baseCfg)
    const bot = new Bot({ provider })
    bot.use(flow('mini').form({ id: 'mini', fields: [{ type: 'text', name: 'city', label: 'Ciudad' }] }))
    await bot.start()
    const sendSpy = vi.spyOn(provider, 'send')
    provider.ingest(textWebhook('mini', 'wamid.IN2'))
    await vi.waitFor(() => expect(sentBodies(calls).some((b) => b.text?.body === 'Ciudad')).toBe(true))
    expect(sentBodies(calls).some((b) => b.interactive?.type === 'flow')).toBe(false)
    // Degrades before the send pipeline: no doomed form send (no 'failed' outbound in the store).
    expect(sendSpy.mock.calls.some(([, content]) => content.kind === 'form')).toBe(false)
    await bot.stop()
  })

  it('canRenderForm() is true only for forms with a Flow mapped (config, publishForm or nativeId)', async () => {
    mockFetch(() => ({ id: '42', validation_errors: [] }))
    const provider = new CloudAPIProvider({ ...baseCfg, wabaId: 'W', flows: { signup: '998877' } })
    const mini: FormDefinition = { id: 'mini', fields: [{ type: 'text', name: 'city', label: 'Ciudad' }] }
    expect(provider.canRenderForm(signup)).toBe(true)
    expect(provider.canRenderForm(mini)).toBe(false)
    expect(provider.canRenderForm(mini, { nativeId: '123' })).toBe(true)
    await provider.publishForm(mini)
    expect(provider.canRenderForm(mini)).toBe(true)
  })

  it('publishForm() creates the Flow via the Flows API and maps it', async () => {
    const calls = mockFetch((call) => (call.url.endsWith('/flows') ? { id: '5551234', success: true, validation_errors: [] } : { messages: [{ id: 'wamid.OUT' }] }))
    const provider = new CloudAPIProvider({ ...baseCfg, wabaId: 'WABA1' })
    const res = await provider.publishForm(signup, { categories: ['SIGN_UP'] })
    expect(res).toEqual({ flowId: '5551234', validationErrors: [] })
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/WABA1/flows')
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body).toMatchObject({ name: 'Registro', categories: ['SIGN_UP'], publish: true })
    expect(JSON.parse(body.flow_json)).toEqual(toFlowJson(signup))

    await provider.send('573001', { kind: 'form', form: signup, token: 'signup.X' })
    expect(JSON.parse(calls[1].init!.body as string).interactive.action.parameters.flow_id).toBe('5551234')
  })

  it('publishForm() requires a WABA id', async () => {
    const provider = new CloudAPIProvider(baseCfg)
    await expect(provider.publishForm(signup)).rejects.toThrow(/wabaId/)
  })
})
