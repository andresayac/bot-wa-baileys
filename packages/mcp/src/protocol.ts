/**
 * JSON-RPC 2.0 and the MCP stdio framing, hand-rolled so this package has no dependencies
 * (the same choice as `@botmesh/server` and `@botmesh/manager`).
 *
 * The stdio transport is **newline-delimited JSON**: one message per line, never pretty
 * printed, and nothing else may be written to stdout. {@link LineDecoder} tolerates
 * messages split across chunks, `\r\n` line endings and a final line without a newline.
 */

/** The only JSON-RPC version this server speaks. */
export const JSONRPC_VERSION = '2.0'

export type JsonRpcId = string | number

/** A request (with `id`) or a notification (without one). */
export interface JsonRpcRequest {
  jsonrpc: string
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResult {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: JsonRpcErrorBody
}

/** Standard JSON-RPC codes (MCP reuses them as-is). */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

/** Narrow an untrusted value to a JSON-RPC request (an `id` of the wrong type is a bug, not a request). */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.jsonrpc !== JSONRPC_VERSION) return false
  if (typeof candidate.method !== 'string' || candidate.method === '') return false
  const id = candidate.id
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') return false
  return true
}

/** The `id` to echo in an error, when the message carried one. */
export function idOf(value: unknown): JsonRpcId | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

export function resultResponse(id: JsonRpcId | null, value: unknown): JsonRpcResult {
  return { jsonrpc: JSONRPC_VERSION, id, result: value }
}

export function errorResponse(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  const error: JsonRpcErrorBody = data === undefined ? { code, message } : { code, message, data }
  return { jsonrpc: JSONRPC_VERSION, id, error }
}

/** One protocol message as a single line (no trailing newline). */
export function encodeMessage(message: JsonRpcResult | JsonRpcFailure): string {
  return JSON.stringify(message)
}

/** Reassembles newline-delimited messages from arbitrary chunks. */
export class LineDecoder {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() !== '') lines.push(line)
    }
    return lines
  }

  /** Lines left when the stream ends mid-line (a client that did not end with `\n`). */
  flush(): string[] {
    const rest = this.buffer.replace(/\r$/, '')
    this.buffer = ''
    return rest.trim() === '' ? [] : [rest]
  }
}
