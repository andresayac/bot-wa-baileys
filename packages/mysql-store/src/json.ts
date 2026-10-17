/**
 * JSON serialisation shared by {@link MysqlStore} and its user-data table.
 */

/**
 * JSON.stringify for MySQL JSON columns. MySQL rejects unpaired UTF-16
 * surrogates (ER_INVALID_JSON_TEXT "The surrogate pair in string is
 * invalid"), e.g. a body truncated in the middle of an emoji. JSON.stringify
 * emits well-formed pairs raw and ONLY lone surrogates as `\udXXX` escapes, so
 * every such escape is rewritten to U+FFFD — the same value UTF-8 based stores
 * end up with. The `\\\\` alternative consumes escaped backslashes first, so
 * literal text such as "\\ud83d" is never touched. Covers keys and values.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value).replace(/\\\\|\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, (m) => (m === '\\\\' ? m : '\\ufffd'))
}
