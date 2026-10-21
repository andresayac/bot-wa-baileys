import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  createMcpServer,
} from '../src/server.js'
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../src/version.js'

const server = createMcpServer()
const docsServer = createMcpServer({ docsDir: 'docs' })

/** Call `handle` and fail loudly when a notification (no response) comes back. */
async function rpc(instance: ReturnType<typeof createMcpServer>, message: unknown): Promise<Record<string, any>> {
  const response = await instance.handle(message)
  if (response === null) throw new Error('expected a response, got a notification')
  return response as Record<string, any>
}

const call = (name: string, args: Record<string, unknown> = {}, instance = server) =>
  rpc(instance, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

const payloadOf = (response: Record<string, any>): Record<string, any> =>
  JSON.parse(response.result.content[0].text) as Record<string, any>

describe('initialize', () => {
  it('reports the server, the tools capability and the instructions', async () => {
    const response = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(response.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    })
    expect(response.result.instructions).toBe(MCP_INSTRUCTIONS)
    expect(MCP_INSTRUCTIONS).toMatch(/v1 API/)
    expect(MCP_INSTRUCTIONS).toMatch(/never generate it/)
  })

  it('echoes an older supported revision and falls back for an unknown one', async () => {
    const old = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    expect(old.result.protocolVersion).toBe('2024-11-05')
    const unknown = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })
    expect(unknown.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(MCP_PROTOCOL_VERSIONS).toContain(unknown.result.protocolVersion)
    const missing = await rpc(server, { jsonrpc: '2.0', id: 3, method: 'initialize' })
    expect(missing.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })

  it('keeps the reported version in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; name: string }
    expect(pkg.version).toBe(MCP_SERVER_VERSION)
    expect(pkg.name).toBe(MCP_SERVER_NAME)
  })
})

describe('tools/list', () => {
  it('lists the tools without their handlers and includes title, description and schema', async () => {
    const response = await call('flow_validate')
    expect(response.error).toBeUndefined()
    const list = await rpc(server, { jsonrpc: '2.0', id: 5, method: 'tools/list' })
    expect(list.result.tools).toHaveLength(7)
    for (const entry of list.result.tools) {
      expect(entry).toMatchObject({ name: expect.any(String), title: expect.any(String), description: expect.any(String) })
      expect(entry.inputSchema.type).toBe('object')
      expect(entry.handler).toBeUndefined()
    }
    expect(list.result.tools.map((entry: { name: string }) => entry.name)).toContain('flow_analyze')
  })

  it('advertises the docs tools only when a docs directory is set', async () => {
    const without = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(without.result.tools.map((entry: { name: string }) => entry.name)).not.toContain('docs_search')
    const withDocs = await rpc(docsServer, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(withDocs.result.tools.map((entry: { name: string }) => entry.name)).toContain('docs_search')
  })
})

describe('tools/call', () => {
  it('wraps a tool result as text content', async () => {
    const response = await call('flow_example')
    expect(response.id).toBe(1)
    expect(response.result.isError).toBeUndefined()
    expect(response.result.content).toHaveLength(1)
    expect(response.result.content[0]).toMatchObject({ type: 'text' })
    expect(typeof response.result.content[0].text).toBe('string')
  })

  it('marks a handler that throws as isError, not as a JSON-RPC error', async () => {
    const response = await call('flow_validate', { document: 42 })
    expect(response.error).toBeUndefined()
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/"document"/)
  })

  it('answers -32602 for an unknown tool, a missing name or bad arguments', async () => {
    const unknown = await call('nope')
    expect(unknown.error.code).toBe(-32602)
    expect(unknown.error.message).toMatch(/unknown tool: nope/)
    const noName = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })
    expect(noName.error.code).toBe(-32602)
    const badArgs = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flow_validate', arguments: [] } })
    expect(badArgs.error.code).toBe(-32602)
    expect(badArgs.error.message).toMatch(/"arguments"/)
    const noParams = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/call' })
    expect(noParams.error.code).toBe(-32602)
  })

  it('treats missing arguments as an empty object', async () => {
    const response = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flow_schema' } })
    expect(response.result.isError).toBeUndefined()
    expect(payloadOf(response).stepKinds.length).toBe(14)
  })
})

describe('protocol edges', () => {
  it('answers ping with an empty result', async () => {
    expect((await rpc(server, { jsonrpc: '2.0', id: 9, method: 'ping' })).result).toEqual({})
  })

  it('never answers a notification', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await server.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'flow_example' } })).toBeNull()
    expect(await server.handle({ jsonrpc: '2.0', method: 'nope' })).toBeNull()
  })

  it('answers -32601 to a method it does not implement', async () => {
    const response = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'resources/list' })
    expect(response.error.code).toBe(-32601)
    expect(response.error.message).toMatch(/resources\/list/)
  })

  it('answers -32600 to a malformed message, echoing a usable id', async () => {
    const noMethod = await rpc(server, { jsonrpc: '2.0', id: 4 })
    expect(noMethod.error.code).toBe(-32600)
    expect(noMethod.id).toBe(4)
    const notAnObject = await rpc(server, 'hola')
    expect(notAnObject.error.code).toBe(-32600)
    expect(notAnObject.id).toBeNull()
  })
})
