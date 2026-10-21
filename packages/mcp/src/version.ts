/**
 * Identity reported in the MCP `initialize` handshake. `tests/server.test.ts` asserts that
 * {@link MCP_SERVER_VERSION} matches `package.json`, so the two cannot drift.
 */
export const MCP_SERVER_NAME = '@botmesh/mcp'

/** Must equal the `version` field of this package's `package.json`. */
export const MCP_SERVER_VERSION = '0.1.0'
