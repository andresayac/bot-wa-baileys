import { describe, expect, it } from 'vitest'

import { createMcpServer } from '../src/server.js'
import { docsDirFromArgv, serveStream } from '../src/stdio.js'

/** Feed `chunks` through the transport and collect the lines it wrote. */
async function run(chunks: readonly string[]): Promise<Array<Record<string, any>>> {
  const written: string[] = []
  await serveStream(
    (async function* stream() { for (const chunk of chunks) yield chunk })(),
    { server: createMcpServer(), write: (line) => { written.push(line) } },
  )
  return written.map((line) => JSON.parse(line) as Record<string, any>)
}

const request = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })

describe('serveStream', () => {
  it('answers one line per request, in order, even when the messages are split', async () => {
    const responses = await run([
      `${request(1, 'initialize')}\n{"jsonrpc":"2.0","id":2,`,
      '"method":"ping"}\n',
      `${request(3, 'tools/list')}\n`,
    ])
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3])
    expect(responses[1]!.result).toEqual({})
    expect(responses[2]!.result.tools).toHaveLength(7)
  })

  it('answers -32700 for a malformed line and keeps the session alive', async () => {
    const responses = await run(['no soy json\n', `${request(2, 'ping')}\n`])
    expect(responses).toHaveLength(2)
    expect(responses[0]).toMatchObject({ id: null, error: { code: -32700, message: 'invalid JSON' } })
    expect(responses[1]).toMatchObject({ id: 2, result: {} })
  })

  it('writes nothing for a notification', async () => {
    expect(await run([`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`])).toEqual([])
  })

  it('handles a final message that does not end with a newline', async () => {
    const responses = await run([request(7, 'ping')])
    expect(responses).toHaveLength(1)
    expect(responses[0]!.id).toBe(7)
  })

  it('decodes byte chunks as UTF-8', async () => {
    const message = request(1, 'tools/call', { name: 'flow_validate', arguments: { document: { version: 1, id: 'x', trigger: 'x', steps: [{ kind: 'say', text: '¡Hola! 🚀' }] } } })
    const bytes = new TextEncoder().encode(`${message}\n`)
    const written: string[] = []
    await serveStream(
      (async function* stream() { yield bytes })(),
      { server: createMcpServer(), write: (line) => { written.push(line) } },
    )
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!).result.content[0].text).toContain('valid')
  })

  it('reports a failing write instead of throwing', async () => {
    const errors: unknown[] = []
    await serveStream(
      (async function* stream() { yield `${request(1, 'ping')}\n` })(),
      { server: createMcpServer(), write: () => { throw new Error('broken pipe') }, reportError: (error) => { errors.push(error) } },
    )
    expect(errors).toHaveLength(1)
  })
})

describe('docsDirFromArgv', () => {
  it('parses --docs <dir> and --docs=<dir>', () => {
    expect(docsDirFromArgv(['--docs', 'docs'])).toBe('docs')
    expect(docsDirFromArgv(['--verbose', '--docs=./docs'])).toBe('./docs')
    expect(docsDirFromArgv(['--docs', '--other'])).toBeUndefined()
    expect(docsDirFromArgv(['--docs='])).toBeUndefined()
    expect(docsDirFromArgv([])).toBeUndefined()
  })
})
