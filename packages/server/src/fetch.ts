import { readWebBody } from './body.js'
import type { Ingress, IngressHeaders } from './types.js'

function headersRecord(headers: Headers): IngressHeaders {
  const out: IngressHeaders = {}
  headers.forEach((value, key) => { out[key.toLowerCase()] = value })
  return out
}

/**
 * Serve a WHATWG `Request` through the ingress. Resolves `undefined` when no
 * route matches, so callers can fall through (see the Hono adapter).
 */
export async function serveFetch(ingress: Ingress, request: Request): Promise<Response | undefined> {
  const url = new URL(request.url)
  const response = await ingress.handle({
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    headers: headersRecord(request.headers),
    readBody: (limit, timeoutMs) => readWebBody(request, limit, timeoutMs),
  })
  if (!response) return undefined
  const headers: Record<string, string> = { ...response.headers }
  if (response.closeConnection) headers.connection = 'close'
  const noBody = request.method === 'HEAD' || response.status === 204 || response.status === 304
  return new Response(noBody ? null : response.body, { status: response.status, headers })
}

/**
 * A fetch-style handler (`(Request) => Promise<Response>`) for runtimes and
 * frameworks built on web-standard requests. Unmatched paths answer 404.
 */
export function createFetchHandler(ingress: Ingress): (request: Request) => Promise<Response> {
  return async (request) => (await serveFetch(ingress, request)) ?? new Response(null, { status: 404 })
}
