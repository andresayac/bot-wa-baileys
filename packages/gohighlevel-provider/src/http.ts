/**
 * Small transport helpers shared by the provider: header lookup, the
 * numbered-text fallback for buttons / lists, and the REST call wrapper over
 * `secureFetch` (@botmesh/http).
 */

import { secureFetch, type SecureFetchOptions } from '@botmesh/http'
import type { ListSection } from '@botmesh/core'

export type HeaderBag = Record<string, string | string[] | undefined>

/** HTTP options forwarded to `secureFetch` for every request the provider makes. */
export type ProviderHttpOptions = Pick<
  SecureFetchOptions,
  'timeoutMs' | 'maxBytes' | 'maxRedirects' | 'resolver' | 'allowHttp' | 'allowPrivateHosts' | 'fetch'
>

/** Case-insensitive header read; the first value wins for repeated headers. */
export function header(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

/** Render buttons / list rows as a numbered text menu (transport has no native widget). */
export function numberedText(text: string, items: ReadonlyArray<{ title: string }>, footer?: string): string {
  const lines = items.map((item, index) => `${index + 1}. ${item.title}`)
  return [text, '', ...lines, ...(footer ? ['', footer] : [])].join('\n')
}

export function listRows(sections: ListSection[]): Array<{ id: string; title: string; description?: string }> {
  return sections.flatMap((section) => section.rows)
}

export interface HttpResult {
  status: number
  ok: boolean
  headers: Headers
  /** Parsed JSON body, or `{}` when the body is empty / not JSON. */
  json: Record<string, unknown>
  body: Buffer
}

/** One REST call through `secureFetch`; never throws on HTTP status (callers map errors). */
export async function request(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  http: ProviderHttpOptions | undefined,
): Promise<HttpResult> {
  const { response, body } = await secureFetch(url, { ...http, ...init })
  let json: Record<string, unknown> = {}
  if (body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
    } catch {
      // Non-JSON error page; callers fall back to the HTTP status.
    }
  }
  return { status: response.status, ok: response.ok, headers: response.headers, json, body }
}

/** `Retry-After` (seconds or HTTP date) in ms, or undefined. */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/** A bounded insertion-ordered map: the oldest key is evicted past `limit`. */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly limit = 10_000) {}
  get(key: K): V | undefined { return this.map.get(key) }
  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }
  }
}
