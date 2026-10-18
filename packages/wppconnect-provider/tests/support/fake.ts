import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Load a recorded webhook/response fixture (fresh copy every call). */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(here, '..', 'fixtures', `${name}.json`), 'utf8')) as T
}

export interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

export type Responder = (call: FakeCall) => { status?: number; body?: unknown; headers?: Record<string, string> }

/** A fake `fetch` recording every call; never touches the network. */
export function fakeFetch(responder: Responder) {
  const calls: FakeCall[] = []
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const call: FakeCall = { url: String(input), method: init?.method ?? 'GET', headers, body: raw ? JSON.parse(raw) : undefined }
    calls.push(call)
    const r = responder(call)
    const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return new Response(payload, { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** Offline DNS: everything resolves to loopback (the base URL is a local gateway). */
export const resolver = async (): Promise<string[]> => ['127.0.0.1']
