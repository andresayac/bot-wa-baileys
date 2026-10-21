/**
 * `@bot-wa/mcp` — an MCP server (Model Context Protocol) over stdio for BotWA.
 *
 * It exposes the project's pure, deterministic pieces to any MCP client (an AI coding
 * agent, an editor) so a flow document can be written, validated, compiled, rendered,
 * linted, migrated and diffed **without starting a bot**:
 *
 * - `flow_validate` / `flow_analyze` / `flow_migrate` / `flow_diff` / `flow_digest`
 * - `flow_schema` (the draft 2020-12 schema, its limits and the accepted step kinds)
 * - `flow_example` (a canonical document that validates and lints clean)
 * - `docs_search` / `docs_page` — only when a docs directory is configured
 *
 * No dependencies, no network, no `eval`: the transport is newline-delimited JSON-RPC 2.0
 * implemented in {@link LineDecoder}, and every tool is a function of its arguments.
 *
 * @example
 * ```ts
 * import { createMcpServer, serveStream } from '@bot-wa/mcp'
 *
 * const server = createMcpServer({ docsDir: 'docs' })
 * await serveStream(process.stdin, { server, write: (line) => console.log(line) })
 * ```
 */
export {
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  createMcpServer,
} from './server.js'
export type { McpServer, McpServerOptions, McpToolInfo } from './server.js'

export { EXAMPLE_FLOW_DOCUMENT, createTools, stepKindsOf } from './tools.js'
export type { ToolContext, ToolDefinition, ToolOutput } from './tools.js'

export {
  JSONRPC_VERSION,
  LineDecoder,
  RPC_ERROR,
  encodeMessage,
  errorResponse,
  idOf,
  isJsonRpcRequest,
  resultResponse,
} from './protocol.js'
export type { JsonRpcErrorBody, JsonRpcFailure, JsonRpcId, JsonRpcRequest, JsonRpcResult } from './protocol.js'

export { markdownFiles, parseSections, readDocPage, searchDocs, searchSections } from './docs.js'
export type { DocHit, DocSection } from './docs.js'

export { docsDirFromArgv, runStdio, serveStream } from './stdio.js'
export type { ServeOptions, StdioOptions } from './stdio.js'

export { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js'
