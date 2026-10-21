/**
 * Google service-account auth without the Google SDK: an RS256 JWT signed
 * with `node:crypto`, exchanged for an OAuth2 access token
 * (`urn:ietf:params:oauth:grant-type:jwt-bearer`). Tokens are cached until
 * shortly before they expire and concurrent refreshes share one request.
 */

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { secureFetch, type SecureFetchOptions } from '@botmesh/http'

/** The fields of a Google service-account JSON key that are used here. */
export interface ServiceAccountCredentials {
  client_email: string
  private_key: string
  private_key_id?: string
  project_id?: string
  /** Defaults to `https://oauth2.googleapis.com/token`. */
  token_uri?: string
}

/** Scope that covers Dialogflow ES and CX. */
export const DIALOGFLOW_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

/** Thrown for credential, token and Dialogflow API failures. */
export class DialogflowError extends Error {
  constructor(
    message: string,
    /** HTTP status when the failure came from an HTTP response. */
    readonly status?: number,
    /** Google error status (`'PERMISSION_DENIED'`, `'NOT_FOUND'`…) or a local code. */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'DialogflowError'
  }
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url')

/** Validate the credential shape and parse the private key. Throws synchronously. */
export function parseCredentials(credentials: ServiceAccountCredentials): { credentials: ServiceAccountCredentials; key: KeyObject } {
  if (!credentials || typeof credentials !== 'object') {
    throw new DialogflowError('credentials must be a service-account JSON object', undefined, 'INVALID_CREDENTIALS')
  }
  if (typeof credentials.client_email !== 'string' || !credentials.client_email) {
    throw new DialogflowError('credentials.client_email is required', undefined, 'INVALID_CREDENTIALS')
  }
  if (typeof credentials.private_key !== 'string' || !credentials.private_key) {
    throw new DialogflowError('credentials.private_key is required', undefined, 'INVALID_CREDENTIALS')
  }
  try {
    // Keys pasted through env vars often carry literal "\n" sequences.
    const pem = credentials.private_key.includes('\\n') ? credentials.private_key.replace(/\\n/g, '\n') : credentials.private_key
    return { credentials, key: createPrivateKey(pem) }
  } catch {
    throw new DialogflowError('credentials.private_key is not a valid PEM private key', undefined, 'INVALID_CREDENTIALS')
  }
}

/** Build the signed assertion JWT for the token exchange. `now` is epoch seconds. */
export function createServiceAccountJwt(
  credentials: ServiceAccountCredentials,
  key: KeyObject,
  opts: { scope?: string; now?: number; lifetimeSec?: number } = {},
): string {
  const iat = opts.now ?? Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT', ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}) }
  const claims = {
    iss: credentials.client_email,
    sub: credentials.client_email,
    scope: opts.scope ?? DIALOGFLOW_SCOPE,
    aud: credentials.token_uri ?? DEFAULT_TOKEN_URI,
    iat,
    exp: iat + (opts.lifetimeSec ?? 3600),
  }
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key)
  return `${unsigned}.${b64url(signature)}`
}

/** HTTP knobs shared by the token exchange and the Dialogflow calls (tests inject `fetch`/`resolver`). */
export type HttpOptions = Pick<SecureFetchOptions, 'fetch' | 'resolver' | 'timeoutMs' | 'maxBytes'>

/** Something that yields a bearer token. */
export interface AccessTokenSource {
  getAccessToken(): Promise<string>
}

/** Access tokens for a service account, cached until 60 s before expiry. */
export class ServiceAccountTokenSource implements AccessTokenSource {
  private readonly credentials: ServiceAccountCredentials
  private readonly key: KeyObject
  private cached?: { token: string; expiresAt: number }
  private inflight?: Promise<string>

  constructor(
    credentials: ServiceAccountCredentials,
    private readonly http: HttpOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    const parsed = parseCredentials(credentials)
    this.credentials = parsed.credentials
    this.key = parsed.key
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token
    this.inflight ??= this.refresh().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async refresh(): Promise<string> {
    const assertion = createServiceAccountJwt(this.credentials, this.key, { now: Math.floor(this.now() / 1000) })
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    const { response, body: raw } = await secureFetch(this.credentials.token_uri ?? DEFAULT_TOKEN_URI, {
      ...this.http,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    let json: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } = {}
    try {
      json = JSON.parse(raw.toString('utf8')) as typeof json
    } catch { /* non-JSON error page: handled below */ }
    if (!response.ok || typeof json.access_token !== 'string') {
      const detail = typeof json.error_description === 'string' ? json.error_description : typeof json.error === 'string' ? json.error : `HTTP ${response.status}`
      throw new DialogflowError(`service-account token exchange failed: ${detail}`, response.status, 'TOKEN_EXCHANGE_FAILED')
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600
    this.cached = { token: json.access_token, expiresAt: this.now() + expiresIn * 1000 }
    return json.access_token
  }
}
