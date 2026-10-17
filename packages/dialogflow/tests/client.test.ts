import { createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DialogflowClient,
  DialogflowError,
  ServiceAccountTokenSource,
  createServiceAccountJwt,
  normalizeCxResult,
  normalizeEsResult,
  parseCredentials,
  toSessionId,
} from '../src/index.js'
import { FakeGoogle, credentials, esResponse, publicKey } from './fakes.js'

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

describe('service-account JWT', () => {
  it('is an RS256 JWT with the jwt-bearer claims, verifiable with the public key', () => {
    const { key } = parseCredentials(credentials)
    const jwt = createServiceAccountJwt(credentials, key, { now: 1_700_000_000 })
    const [h, c, s] = jwt.split('.')
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-1' })
    expect(decode(c)).toEqual({
      iss: credentials.client_email,
      sub: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    })
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))
    expect(ok).toBe(true)
  })

  it('accepts keys with literal \\n sequences (env vars) and rejects broken credentials synchronously', () => {
    const escaped = { ...credentials, private_key: credentials.private_key.replace(/\n/g, '\\n') }
    expect(() => parseCredentials(escaped)).not.toThrow()
    expect(() => parseCredentials({ ...credentials, private_key: 'nope' })).toThrow(DialogflowError)
    expect(() => parseCredentials({ ...credentials, client_email: '' })).toThrow(/client_email/)
  })
})

describe('ServiceAccountTokenSource', () => {
  it('exchanges the JWT for an access token and caches it until shortly before expiry', async () => {
    const google = new FakeGoogle()
    let now = 1_700_000_000_000
    const source = new ServiceAccountTokenSource(credentials, google.http, () => now)

    const [a, b] = await Promise.all([source.getAccessToken(), source.getAccessToken()])
    expect([a, b]).toEqual(['tok-1', 'tok-1'])
    expect(google.tokenCalls).toBe(1)
    const form = new URLSearchParams(google.requests[0].body)
    expect(google.requests[0].method).toBe('POST')
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('assertion')?.split('.')).toHaveLength(3)

    now += 3_000_000 // 50 min: still fresh
    expect(await source.getAccessToken()).toBe('tok-1')
    now += 560_000 // within 60 s of expiry → refresh
    expect(await source.getAccessToken()).toBe('tok-2')
  })

  it('throws a DialogflowError when the exchange fails', async () => {
    const google = new FakeGoogle()
    google.tokenStatus = 400
    const source = new ServiceAccountTokenSource(credentials, google.http)
    await expect(source.getAccessToken()).rejects.toMatchObject({
      name: 'DialogflowError',
      status: 400,
      code: 'TOKEN_EXCHANGE_FAILED',
      message: expect.stringContaining('Invalid JWT Signature'),
    })
  })
})

describe('toSessionId', () => {
  it('is deterministic, short, URL-safe and hides the raw key', () => {
    const id = toSessionId('+57 300 000 0000@chat')
    expect(id).toBe(toSessionId('+57 300 000 0000@chat'))
    expect(id).not.toBe(toSessionId('other'))
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,36}$/)
    expect(id).not.toContain('300')
  })
})

describe('DialogflowClient — URLs', () => {
  it('ES: global, regional and environment session paths', () => {
    const base = { credentials, http: new FakeGoogle().http }
    expect(new DialogflowClient(base).sessionUrl('s1')).toBe(
      'https://dialogflow.googleapis.com/v2/projects/demo-project/agent/sessions/s1:detectIntent',
    )
    expect(new DialogflowClient({ ...base, location: 'europe-west1' }).sessionUrl('s1')).toBe(
      'https://europe-west1-dialogflow.googleapis.com/v2/projects/demo-project/locations/europe-west1/agent/sessions/s1:detectIntent',
    )
    expect(new DialogflowClient({ ...base, projectId: 'p2', environment: 'prod' }).sessionUrl('s1')).toBe(
      'https://dialogflow.googleapis.com/v2/projects/p2/agent/environments/prod/users/-/sessions/s1:detectIntent',
    )
  })

  it('CX: regional and global agent session paths', () => {
    const base = { credentials, http: new FakeGoogle().http }
    expect(new DialogflowClient({ ...base, cx: { agentId: 'ag-1', location: 'us-central1' } }).sessionUrl('s1')).toBe(
      'https://us-central1-dialogflow.googleapis.com/v3/projects/demo-project/locations/us-central1/agents/ag-1/sessions/s1:detectIntent',
    )
    expect(new DialogflowClient({ ...base, cx: { agentId: 'ag-1', location: 'global', environment: 'env-9' } }).sessionUrl('s1')).toBe(
      'https://dialogflow.googleapis.com/v3/projects/demo-project/locations/global/agents/ag-1/environments/env-9/sessions/s1:detectIntent',
    )
  })

  it('requires a project id and complete CX coordinates', () => {
    const { project_id: _p, ...noProject } = credentials
    expect(() => new DialogflowClient({ credentials: noProject })).toThrow(/projectId/)
    expect(() => new DialogflowClient({ credentials, cx: { agentId: '', location: 'global' } })).toThrow(/cx\.agentId/)
    expect(() => new DialogflowClient({})).toThrow(/credentials or tokenSource/)
  })
})

describe('DialogflowClient — detectIntent', () => {
  it('ES: posts queryInput.text with the bearer token and normalizes the result', async () => {
    const google = new FakeGoogle()
    google.detect = () => ({ json: esResponse('order.status', { order: '123' }, { text: 'Buscando tu pedido…', confidence: 0.87 }) })
    const client = new DialogflowClient({ credentials, http: google.http, languageCode: 'es-CO' })
    const r = await client.detectIntent('sess', 'mi pedido 123', { queryParams: { timeZone: 'America/Bogota' } })

    const req = google.detectRequests()[0]
    expect(req.headers.authorization).toBe('Bearer tok-1')
    expect(JSON.parse(req.body)).toEqual({
      queryInput: { text: { text: 'mi pedido 123', languageCode: 'es-CO' } },
      queryParams: { timeZone: 'America/Bogota' },
    })
    expect(r).toMatchObject({
      intent: 'order.status',
      confidence: 0.87,
      isFallback: false,
      parameters: { order: '123' },
      messages: ['Buscando tu pedido…'],
      fulfillmentText: 'Buscando tu pedido…',
      action: 'order.status.action',
    })
  })

  it('CX: posts queryInput.languageCode at the top level and normalizes match/responseMessages', async () => {
    const google = new FakeGoogle()
    google.detect = () => ({
      json: {
        queryResult: {
          text: 'reservar',
          languageCode: 'es',
          parameters: { people: 4 },
          responseMessages: [{ text: { text: ['¿Para qué día?'] } }, { payload: {} }],
          currentPage: { displayName: 'Booking' },
          match: { intent: { name: 'projects/p/locations/l/agents/a/intents/i1', displayName: 'book.table' }, confidence: 0.95, matchType: 'INTENT' },
        },
      },
    })
    const client = new DialogflowClient({ credentials, http: google.http, cx: { agentId: 'a', location: 'us-central1' } })
    const r = await client.detectIntent('sess', 'reservar')
    expect(JSON.parse(google.detectRequests()[0].body)).toEqual({ queryInput: { text: { text: 'reservar' }, languageCode: 'es' } })
    expect(r).toMatchObject({ intent: 'book.table', confidence: 0.95, parameters: { people: 4 }, messages: ['¿Para qué día?'], page: 'Booking', isFallback: false })
  })

  it('maps Google API errors to DialogflowError', async () => {
    const google = new FakeGoogle()
    google.detect = () => ({ status: 403, json: { error: { code: 403, message: 'Permission denied on agent', status: 'PERMISSION_DENIED' } } })
    const client = new DialogflowClient({ credentials, http: google.http })
    await expect(client.detectIntent('s', 'hola')).rejects.toMatchObject({ name: 'DialogflowError', status: 403, code: 'PERMISSION_DENIED' })
  })

  it('accepts a custom tokenSource instead of credentials', async () => {
    const google = new FakeGoogle()
    const client = new DialogflowClient({ projectId: 'p', tokenSource: { getAccessToken: async () => 'custom' }, http: google.http })
    await client.detectIntent('s', 'hola')
    expect(google.tokenCalls).toBe(0)
    expect(google.detectRequests()[0].headers.authorization).toBe('Bearer custom')
  })
})

describe('normalizers', () => {
  it('ES: no intent / fallback intent', () => {
    expect(normalizeEsResult({})).toMatchObject({ intent: null, isFallback: true, parameters: {}, messages: [] })
    const fb = normalizeEsResult(esResponse('Default Fallback Intent', {}, { fallback: true, text: '¿Cómo?' }).queryResult)
    expect(fb).toMatchObject({ intent: 'Default Fallback Intent', isFallback: true, messages: ['¿Cómo?'] })
  })
  it('CX: NO_MATCH yields a null intent', () => {
    const r = normalizeCxResult({ match: { matchType: 'NO_MATCH', confidence: 0 }, responseMessages: [{ text: { text: ['No entendí'] } }] })
    expect(r).toMatchObject({ intent: null, isFallback: true, messages: ['No entendí'] })
  })
})
