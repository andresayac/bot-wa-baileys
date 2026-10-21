import { describe, expect, it } from 'vitest'

import {
  LineDecoder,
  RPC_ERROR,
  encodeMessage,
  errorResponse,
  idOf,
  isJsonRpcRequest,
  resultResponse,
} from '../src/protocol.js'

describe('LineDecoder', () => {
  it('reassembles messages split across chunks', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('{"jsonrpc":"2.0","id":1,')).toEqual([])
    expect(decoder.push('"method":"ping"}\n')).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}'])
  })

  it('returns every complete line of a chunk and keeps the remainder buffered', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('a\nb\r\nc')).toEqual(['a', 'b'])
    expect(decoder.push('\n')).toEqual(['c'])
  })

  it('ignores blank lines and flushes a final line without a newline', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('\n\n  \n')).toEqual([])
    expect(decoder.push('tail')).toEqual([])
    expect(decoder.flush()).toEqual(['tail'])
    expect(decoder.flush()).toEqual([])
  })
})

describe('JSON-RPC guards and envelopes', () => {
  it('accepts a request or a notification and rejects anything else', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'ping' })).toBe(true)
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).toBe(true)
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 'abc', method: 'tools/call' })).toBe(true)
    for (const bad of [
      null,
      undefined,
      42,
      'hola',
      [],
      {},
      { jsonrpc: '1.0', method: 'ping' },
      { jsonrpc: '2.0' },
      { jsonrpc: '2.0', method: '' },
      { jsonrpc: '2.0', id: true, method: 'ping' },
      { jsonrpc: '2.0', id: null, method: 'ping' },
    ]) {
      expect(isJsonRpcRequest(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('echoes the id only when the message carried a usable one', () => {
    expect(idOf({ id: 7 })).toBe(7)
    expect(idOf({ id: 'x' })).toBe('x')
    expect(idOf({ id: null })).toBeNull()
    expect(idOf({})).toBeNull()
    expect(idOf('nope')).toBeNull()
  })

  it('builds responses that serialize as one line', () => {
    const ok = encodeMessage(resultResponse(1, { pong: true }))
    expect(ok).toBe('{"jsonrpc":"2.0","id":1,"result":{"pong":true}}')
    expect(ok).not.toContain('\n')
    const failure = errorResponse(null, RPC_ERROR.parseError, 'invalid JSON')
    expect(failure).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } })
    expect(errorResponse(2, RPC_ERROR.internalError, 'boom', { detail: 1 })).toMatchObject({
      id: 2,
      error: { code: -32603, message: 'boom', data: { detail: 1 } },
    })
  })
})
