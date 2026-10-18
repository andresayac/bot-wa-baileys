/**
 * DialogflowClient — `detectIntent` over the REST API for Dialogflow ES (v2)
 * and CX (v3), normalized into one {@link DialogflowResult} shape.
 */

import { createHash } from 'node:crypto'
import { secureFetch } from '@bot-wa/http'
import {
  DialogflowError,
  ServiceAccountTokenSource,
  type AccessTokenSource,
  type HttpOptions,
  type ServiceAccountCredentials,
} from './auth.js'

/** Dialogflow CX agent coordinates. */
export interface DialogflowCxAgent {
  /** Agent id (the UUID in the console URL). */
  agentId: string
  /** Agent region, e.g. `'us-central1'`, `'europe-west1'` or `'global'`. */
  location: string
  /** Optional environment id (defaults to the draft agent). */
  environment?: string
}

/** Client configuration shared by ES and CX. */
export interface DialogflowClientConfig {
  /** Google Cloud project id. Defaults to `credentials.project_id`. */
  projectId?: string
  /** Service-account JSON key. Required unless `tokenSource` is given. */
  credentials?: ServiceAccountCredentials
  /** Custom bearer-token source (e.g. workload identity); overrides `credentials`. */
  tokenSource?: AccessTokenSource
  /** Language of the queries (default `'es'`). */
  languageCode?: string
  /** Use Dialogflow CX instead of ES. */
  cx?: DialogflowCxAgent
  /** ES only: regional agent location (`'europe-west1'`…). Default global. */
  location?: string
  /** ES only: published environment id. Default the draft agent. */
  environment?: string
  /** Override the API base URL (default derived from the location). */
  apiBaseUrl?: string
  /** HTTP knobs for `secureFetch` (tests inject `fetch` and `resolver`). */
  http?: HttpOptions
  /** Clock override (tests). */
  now?: () => number
}

/** Normalized detectIntent result (ES and CX). */
export interface DialogflowResult {
  /** Matched intent display name, or `null` when nothing matched (CX `NO_MATCH`). */
  intent: string | null
  /** Full intent resource name, when matched. */
  intentId?: string
  /** Intent detection confidence in `[0, 1]`. */
  confidence: number
  /** True for the ES fallback intent or a CX no-match. */
  isFallback: boolean
  /** Extracted parameters (plain JSON). */
  parameters: Record<string, unknown>
  /** ES: `allRequiredParamsPresent`. CX: always `true` (form filling lives in pages). */
  allRequiredParamsPresent: boolean
  /** Text responses, in order (ES fulfillmentMessages / CX responseMessages). */
  messages: string[]
  /** ES fulfillmentText, or the CX text messages joined by a newline. */
  fulfillmentText: string
  /** ES action name, when set. */
  action?: string
  /** CX current page display name, when set. */
  page?: string
  /** The raw `queryResult` JSON. */
  raw: unknown
}

/** Per-request options. */
export interface DetectIntentOptions {
  languageCode?: string
  /** Sent as `queryParams` verbatim (ES: contexts/payload…; CX: parameters/payload…). */
  queryParams?: Record<string, unknown>
}

type Json = Record<string, unknown>

const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/**
 * Map an arbitrary chat/session key to a valid Dialogflow session id
 * (≤ 36 chars of `[A-Za-z0-9_-]`). The key is hashed, never parsed, so it
 * stays opaque — and private (a phone number is not sent to Google).
 */
export function toSessionId(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32)
}

function textMessages(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const m of list) {
    if (!isObj(m) || !isObj(m.text)) continue
    const texts = m.text.text
    if (Array.isArray(texts)) for (const t of texts) if (typeof t === 'string' && t) out.push(t)
  }
  return out
}

/** Normalize a v2 (ES) `queryResult`. */
export function normalizeEsResult(qr: unknown): DialogflowResult {
  const q = isObj(qr) ? qr : {}
  const intent = isObj(q.intent) ? q.intent : undefined
  const messages = textMessages(q.fulfillmentMessages)
  const fulfillmentText = str(q.fulfillmentText) ?? messages.join('\n')
  const name = intent ? str(intent.displayName) ?? null : null
  return {
    intent: name,
    ...(intent && str(intent.name) ? { intentId: str(intent.name) } : {}),
    confidence: num(q.intentDetectionConfidence),
    isFallback: intent ? intent.isFallback === true : true,
    parameters: isObj(q.parameters) ? q.parameters : {},
    allRequiredParamsPresent: q.allRequiredParamsPresent !== false,
    messages: messages.length > 0 ? messages : fulfillmentText ? [fulfillmentText] : [],
    fulfillmentText,
    ...(str(q.action) ? { action: str(q.action) } : {}),
    raw: qr,
  }
}

/** Normalize a v3 (CX) `queryResult`. */
export function normalizeCxResult(qr: unknown): DialogflowResult {
  const q = isObj(qr) ? qr : {}
  const match = isObj(q.match) ? q.match : {}
  const intent = isObj(match.intent) ? match.intent : isObj(q.intent) ? q.intent : undefined
  const noMatch = match.matchType === 'NO_MATCH' || match.matchType === 'NO_INPUT'
  const messages = textMessages(q.responseMessages)
  const page = isObj(q.currentPage) ? str(q.currentPage.displayName) : undefined
  return {
    intent: !noMatch && intent ? str(intent.displayName) ?? null : null,
    ...(!noMatch && intent && str(intent.name) ? { intentId: str(intent.name) } : {}),
    confidence: num(match.confidence ?? q.intentDetectionConfidence),
    isFallback: noMatch || !intent,
    parameters: isObj(q.parameters) ? q.parameters : isObj(match.parameters) ? match.parameters : {},
    allRequiredParamsPresent: true,
    messages,
    fulfillmentText: messages.join('\n'),
    ...(page ? { page } : {}),
    raw: qr,
  }
}

export class DialogflowClient {
  readonly projectId: string
  readonly languageCode: string
  readonly edition: 'es' | 'cx'
  private readonly tokens: AccessTokenSource

  constructor(private readonly config: DialogflowClientConfig) {
    if (config.tokenSource) this.tokens = config.tokenSource
    else if (config.credentials) this.tokens = new ServiceAccountTokenSource(config.credentials, config.http, config.now)
    else throw new DialogflowError('either credentials or tokenSource is required', undefined, 'INVALID_CREDENTIALS')
    const projectId = config.projectId ?? config.credentials?.project_id
    if (!projectId) throw new DialogflowError('projectId is required (or credentials.project_id)', undefined, 'INVALID_CONFIG')
    if (config.cx && (!config.cx.agentId || !config.cx.location)) {
      throw new DialogflowError('cx.agentId and cx.location are required for Dialogflow CX', undefined, 'INVALID_CONFIG')
    }
    this.projectId = projectId
    this.languageCode = config.languageCode ?? 'es'
    this.edition = config.cx ? 'cx' : 'es'
  }

  /** The REST URL of a session's `detectIntent`. */
  sessionUrl(sessionId: string): string {
    const p = encodeURIComponent(this.projectId)
    const s = encodeURIComponent(sessionId)
    const cx = this.config.cx
    if (cx) {
      const loc = encodeURIComponent(cx.location)
      const base = this.config.apiBaseUrl ?? (cx.location === 'global' ? 'https://dialogflow.googleapis.com' : `https://${loc}-dialogflow.googleapis.com`)
      const env = cx.environment ? `/environments/${encodeURIComponent(cx.environment)}` : ''
      return `${base}/v3/projects/${p}/locations/${loc}/agents/${encodeURIComponent(cx.agentId)}${env}/sessions/${s}:detectIntent`
    }
    const location = this.config.location
    const regional = location && location !== 'global'
    const base = this.config.apiBaseUrl ?? (regional ? `https://${encodeURIComponent(location)}-dialogflow.googleapis.com` : 'https://dialogflow.googleapis.com')
    const parent = regional ? `projects/${p}/locations/${encodeURIComponent(location)}` : `projects/${p}`
    const env = this.config.environment ? `/environments/${encodeURIComponent(this.config.environment)}/users/-` : ''
    return `${base}/v2/${parent}/agent${env}/sessions/${s}:detectIntent`
  }

  /** Send `text` to the agent in session `sessionId` and normalize the answer. */
  async detectIntent(sessionId: string, text: string, opts: DetectIntentOptions = {}): Promise<DialogflowResult> {
    const languageCode = opts.languageCode ?? this.languageCode
    const queryInput = this.edition === 'cx'
      ? { text: { text }, languageCode }
      : { text: { text, languageCode } }
    const payload: Json = { queryInput, ...(opts.queryParams ? { queryParams: opts.queryParams } : {}) }
    const token = await this.tokens.getAccessToken()
    const { response, body } = await secureFetch(this.sessionUrl(sessionId), {
      ...this.config.http,
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    })
    let json: unknown
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      json = undefined
    }
    if (!response.ok) {
      const err = isObj(json) && isObj(json.error) ? json.error : {}
      throw new DialogflowError(
        `detectIntent failed: ${str(err.message) ?? `HTTP ${response.status}`}`,
        response.status,
        str(err.status) ?? 'HTTP_ERROR',
      )
    }
    const qr = isObj(json) ? json.queryResult : undefined
    return this.edition === 'cx' ? normalizeCxResult(qr) : normalizeEsResult(qr)
  }
}
