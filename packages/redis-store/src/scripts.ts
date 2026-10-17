/**
 * Lua scripts RedisStore sends with EVAL (internal). Exported so the
 * in-memory test fake can dispatch on the exact script text instead of
 * assuming a single script.
 */

/** Compare-and-delete: only DEL the lock if the token still matches. */
export const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

/**
 * Compare-and-set for record upserts: SET KEYS[1] to ARGV[3] only if its
 * current value is still the one the merge was computed from — ARGV[1] = '1'
 * and ARGV[2] = that exact string, or ARGV[1] = '0' meaning "the key did not
 * exist". Returns 1 when written, 0 on a conflict (the caller re-reads and
 * retries). The merge itself stays in JS: decoding and re-encoding the record
 * with cjson server-side would be lossy (empty arrays become `{}`, numbers are
 * cut to 14 significant digits, `/` gets escaped).
 */
export const MERGE_CAS_SCRIPT = `
local current = redis.call('get', KEYS[1])
if ARGV[1] == '0' then
  if current then return 0 end
elseif current ~= ARGV[2] then
  return 0
end
redis.call('set', KEYS[1], ARGV[3])
return 1
`
