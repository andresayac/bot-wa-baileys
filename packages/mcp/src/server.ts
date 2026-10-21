/**
 * The MCP server: JSON-RPC dispatch over the {@link createTools} catalogue. Transport
 * agnostic — `stdio.ts` wires the process streams and the tests call {@link McpServer.handle}
 * directly with plain objects.
 *
 * Only `tools` is advertised as a capability, so `resources/*`, `prompts/*` and
 * `logging/setLevel` answer `-32601` instead of pretending to work.
 *
 * Tool failures follow the MCP convention: a bad request (unknown tool, bad arguments) is a
 * JSON-RPC error, while a handler that throws becomes a successful `tools/call` result with
 * `isError: true`, so the model sees the message and can retry.
 */
import {
  RPC_ERROR,
  errorResponse,
  idOf,
  isJsonRpcRequest,
  resultResponse,
  type JsonRpcFailure,
  type JsonRpcResult,
} from './protocol.js'
import { createTools, type ToolContext, type ToolDefinition } from './tools.js'
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js'

/** Protocol revisions this server accepts; the first one is its own. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** Revision reported when the client asks for one this server does not know. */
export const MCP_PROTOCOL_VERSION: string = MCP_PROTOCOL_VERSIONS[0]

/**
 * Sent in the `initialize` result. This is the one piece of context every MCP client sees
 * before calling a tool, so it states the invariants that are expensive to get wrong.
 */
export const MCP_INSTRUCTIONS = [
  'BotWA v2. The v1 API (.addAnswer, .addAction, { capture: true }, createBot/createFlow, BaileysClass) does not exist: never generate it.',
  'Flow documents are data: version 1, `steps` array, no code, no local paths, no eval. The only expressions are the safe grammar of `condition.if` / `ask.validate.expr`; texts only interpolate `{{ path }}` over c.state and $body/$from/$sender/$isGroup.',
  'Workflow: flow_example or flow_schema to write a document, flow_validate on every iteration, flow_analyze for the graph and the static lint, flow_migrate for old versions, flow_diff/flow_digest before publishing.',
  'A handler that starts a conversation must not await it: `void runtime.enter(...).catch(...)` (enter resolves when the conversation ENDS and would block the chat FIFO queue).',
  'Ids are opaque strings; the provider resolves identity (LID/PN and friends) before emitting, so the same person always has the same senderId.',
].join('\n')

/** A tool as `tools/list` reports it (no handler). */
export interface McpToolInfo {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpServerOptions extends ToolContext {
  /** Defaults to `@bot-wa/mcp`. */
  name?: string
  /** Defaults to the package version. */
  version?: string
  /** Override the `initialize` instructions (tests, or a host with its own conventions). */
  instructions?: string
}

/** What a transport needs from the server. */
export interface McpServer {
  readonly tools: readonly McpToolInfo[]
  /**
   * Handle one decoded message.
   * Returns the response, or `null` for a notification (JSON-RPC forbids answering those).
   */
  handle(message: unknown): Promise<JsonRpcResult | JsonRpcFailure | null>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Create a server over the given tool context (`docsDir` enables the docs tools). */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const tools: ToolDefinition[] = createTools({ ...(options.docsDir !== undefined ? { docsDir: options.docsDir } : {}) })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const context: ToolContext = { ...(options.docsDir !== undefined ? { docsDir: options.docsDir } : {}) }

  return {
    tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),

    async handle(message) {
      if (!isJsonRpcRequest(message)) {
        return errorResponse(idOf(message), RPC_ERROR.invalidRequest, 'invalid JSON-RPC request')
      }
      // A notification (no `id`) is never answered, even when the method is unknown.
      if (message.id === undefined) return null
      const id = message.id
      const params = asRecord(message.params)

      switch (message.method) {
        case 'initialize': {
          const requested = params?.protocolVersion
          const protocolVersion = typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : MCP_PROTOCOL_VERSION
          return resultResponse(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name ?? MCP_SERVER_NAME, version: options.version ?? MCP_SERVER_VERSION, title: 'BotWA flow tools' },
            instructions: options.instructions ?? MCP_INSTRUCTIONS,
          })
        }

        case 'ping':
          return resultResponse(id, {})

        case 'tools/list':
          return resultResponse(id, { tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) })

        case 'tools/call': {
          const name = params?.name
          if (typeof name !== 'string' || name === '') {
            return errorResponse(id, RPC_ERROR.invalidParams, '"name" must be a tool name')
          }
          const rawArguments = params?.arguments
          const args = rawArguments === undefined ? {} : asRecord(rawArguments)
          if (!args) return errorResponse(id, RPC_ERROR.invalidParams, '"arguments" must be an object')
          const tool = byName.get(name)
          if (!tool) return errorResponse(id, RPC_ERROR.invalidParams, `unknown tool: ${name}`)
          try {
            const output = await tool.handler(args, context)
            return resultResponse(id, {
              content: [{ type: 'text', text: output.text }],
              ...(output.isError === true ? { isError: true } : {}),
            })
          } catch (error) {
            return resultResponse(id, { content: [{ type: 'text', text: messageOf(error) }], isError: true })
          }
        }

        default:
          return errorResponse(id, RPC_ERROR.methodNotFound, `method not found: ${message.method}`)
      }
    },
  }
}
