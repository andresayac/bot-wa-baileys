#!/usr/bin/env node
/**
 * Executable entry of the MCP server (stdio transport).
 *
 * Run it from a checkout with:
 *   node packages/mcp/lib/bin.js --docs docs        # documentation tools on
 *   node packages/mcp/lib/bin.js                    # flow tools only
 *
 * stdout is the protocol channel: nothing else may be written there.
 */
import { runStdio } from './stdio.js'

runStdio().catch((error: unknown) => {
  process.stderr.write(`bot-wa-mcp: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
