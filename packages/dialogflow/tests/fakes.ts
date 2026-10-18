import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { HttpOptions, ServiceAccountCredentials } from '../src/index.js'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const publicKey: KeyObject = pair.publicKey
export const credentials: ServiceAccountCredentials = {
  client_email: 'bot@demo-project.iam.gserviceaccount.com',
  private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'key-1',
  project_id: 'demo-project',
}

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export type Responder = (req: RecordedRequest) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>

/** Fake Google: token endpoint + detectIntent, no network. */
export class FakeGoogle {
  requests: RecordedRequest[] = []
  tokenCalls = 0
  tokenExpiresIn = 3600
  tokenStatus = 200
  detect: Responder = () => ({ json: { queryResult: {} } })

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const req: RecordedRequest = { url, method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') }
    this.requests.push(req)
    if (url === 'https://oauth2.googleapis.com/token') {
      this.tokenCalls++
      if (this.tokenStatus !== 200) {
        return Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: this.tokenStatus })
      }
      return Response.json({ access_token: `tok-${this.tokenCalls}`, expires_in: this.tokenExpiresIn, token_type: 'Bearer' })
    }
    const { status = 200, json } = await this.detect(req)
    return Response.json(json, { status })
  }

  get http(): HttpOptions {
    return { fetch: this.fetch as typeof globalThis.fetch, resolver: async () => ['142.250.0.10'] }
  }

  detectRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.includes(':detectIntent'))
  }
}

/** A v2 (ES) detectIntent response body. */
export function esResponse(intent: string | null, parameters: Record<string, unknown> = {}, opts: { confidence?: number; text?: string; fallback?: boolean } = {}) {
  return {
    responseId: 'r-1',
    queryResult: {
      queryText: 'q',
      action: intent ? `${intent}.action` : 'input.unknown',
      parameters,
      allRequiredParamsPresent: true,
      fulfillmentText: opts.text ?? '',
      fulfillmentMessages: opts.text ? [{ text: { text: [opts.text] } }] : [],
      intent: intent
        ? { name: `projects/demo-project/agent/intents/${intent}`, displayName: intent, isFallback: opts.fallback ?? false }
        : undefined,
      intentDetectionConfidence: opts.confidence ?? 0.9,
      languageCode: 'es',
    },
  }
}
