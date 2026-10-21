/**
 * The stdio transport: newline-delimited JSON-RPC over a pair of streams.
 *
 * {@link serveStream} is the testable half (any async iterable in, a `write` callback out);
 * {@link runStdio} wires `process.stdin`/`process.stdout`, keeps stdout reserved for protocol
 * messages and sends every diagnostic to stderr. `--docs <dir>` (or `BOTWA_DOCS_DIR`)
 * enables the documentation tools.
 */
import { LineDecoder, RPC_ERROR, encodeMessage, errorResponse } from './protocol.js'
import { createMcpServer, type McpServer, type McpToolInfo } from './server.js'

/** Everything a single protocol session needs. */
export interface ServeOptions {
  server: McpServer
  /** Write one protocol message; a returned promise is awaited (backpressure). */
  write(line: string): void | Promise<void>
  /** Called when a write itself fails (a broken pipe, for instance). */
  reportError?(error: unknown): void
}

export interface StdioOptions {
  /** Docs tree for the documentation tools (default: `--docs` argument, then `BOTWA_DOCS_DIR`). */
  docsDir?: string
  /** argv to parse when `docsDir` is absent (default: `process.argv.slice(2)`). */
  argv?: readonly string[]
}

/** `--docs <dir>` / `--docs=<dir>` from a command line. */
export function docsDirFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--docs') {
      const next = argv[index + 1]
      return next !== undefined && next !== '' && !next.startsWith('-') ? next : undefined
    }
    if (arg.startsWith('--docs=')) {
      const value = arg.slice('--docs='.length)
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/**
 * Serve messages from `input` until it ends. Messages are handled one at a time so the
 * responses cannot interleave; a malformed line answers `-32700` and the session continues.
 */
export async function serveStream(input: AsyncIterable<string | Uint8Array>, options: ServeOptions): Promise<void> {
  const write = async (line: string): Promise<void> => {
    try {
      await options.write(line)
    } catch (error) {
      options.reportError?.(error)
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      await write(encodeMessage(errorResponse(null, RPC_ERROR.parseError, 'invalid JSON')))
      return
    }
    const response = await options.server.handle(message)
    if (response !== null) await write(encodeMessage(response))
  }

  const decoder = new LineDecoder()
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const line of decoder.push(text)) await handleLine(line)
  }
  for (const line of decoder.flush()) await handleLine(line)
}

/** Run the server over the process streams (what `bin.ts` calls). */
export async function runStdio(options: StdioOptions = {}): Promise<void> {
  const docsDir = options.docsDir ?? docsDirFromArgv(options.argv ?? process.argv.slice(2)) ?? process.env.BOTWA_DOCS_DIR
  const server = createMcpServer(docsDir !== undefined && docsDir !== '' ? { docsDir } : {})
  const tools: readonly McpToolInfo[] = server.tools
  process.stderr.write(`botmesh-mcp: ${tools.length} tool(s)${docsDir ? `, docs ${docsDir}` : ' (docs tools off: pass --docs <dir>)'}\n`)

  process.stdin.setEncoding('utf8')
  await serveStream(process.stdin, {
    server,
    write(line) {
      if (process.stdout.write(`${line}\n`)) return
      // Respect backpressure: the pipe is full, wait for it to drain.
      return new Promise<void>((resolve) => { process.stdout.once('drain', resolve) })
    },
    reportError(error) {
      process.stderr.write(`botmesh-mcp: write failed: ${error instanceof Error ? error.message : String(error)}\n`)
    },
  })
}
