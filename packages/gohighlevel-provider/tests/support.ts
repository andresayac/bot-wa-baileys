/** Hermetic HTTP fake for secureFetch: records calls, answers from a responder. */

export interface Call {
  url: string
  method: string
  headers: Headers
  body: string
}

export interface FakeResponse {
  status?: number
  json?: unknown
  bytes?: Buffer
  headers?: Record<string, string>
}

export function fakeHttp(responder: (call: Call) => FakeResponse = () => ({ json: {} })) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    const r = responder(call)
    const payload = r.bytes ?? Buffer.from(r.json === undefined ? '' : JSON.stringify(r.json))
    return new Response(new Uint8Array(payload), { status: r.status ?? 200, headers: r.headers ?? {} })
  }) as typeof globalThis.fetch
  return { calls, http: { fetch, resolver: async () => ['93.184.216.34'] } }
}
