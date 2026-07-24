/**
 * Shared webhook-ingest guard for the Graph transports. Encapsulates the
 * (previously triplicated) appSecret check: raw-body handling, the
 * X-Hub-Signature-256 verification, and the "non-raw body while appSecret set"
 * footgun warning.
 */

import { verifySignature } from './webhook.js'

export interface GraphIngestLogger {
  warn?: (msg: string) => void
}

export type GraphSignatureResult =
  | { ok: true }
  | { ok: false; status: number }

/**
 * Verify an inbound webhook's signature when `appSecret` is configured.
 *
 * - No `appSecret` → `{ ok: true }` (verification disabled; the provider warns
 *   about this at construction time).
 * - `appSecret` set → checks `X-Hub-Signature-256` over the RAW request bytes.
 *   A non-raw (already-parsed) body is re-serialized only as a last resort and
 *   logged, because Meta signs the exact bytes it sent.
 */
export function checkGraphSignature(
  body: unknown,
  headers: Record<string, string | string[] | undefined> | undefined,
  appSecret: string | undefined,
  logger?: GraphIngestLogger,
): GraphSignatureResult {
  if (!appSecret) return { ok: true }
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
    logger?.warn?.(
      'ingest received a non-raw body while appSecret is set — signature verification needs the raw ' +
        'request bytes (use express.raw()/the raw body string), or valid webhooks will be rejected.',
    )
  }
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  const sig = headers?.['x-hub-signature-256']
  const sigStr = Array.isArray(sig) ? sig[0] : sig
  if (!verifySignature(raw, sigStr, appSecret)) {
    logger?.warn?.('webhook rejected: invalid X-Hub-Signature-256')
    return { ok: false, status: 403 }
  }
  return { ok: true }
}

/** Parse a webhook body (raw string, Buffer, or already-parsed object) into T. */
export function parseGraphBody<T>(body: unknown): T {
  if (typeof body === 'string') return JSON.parse(body) as T
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8')) as T
  return body as T
}
