/**
 * Lua script of RedisDurableKv (internal). Kept apart from scripts.ts so other features
 * adding scripts never touch it. Exported so the in-memory test fake can dispatch on its text.
 */

/**
 * Atomic versioned write of one durability document plus its two index entries.
 * KEYS[1] = document, KEYS[2] = `due` ZSET, KEYS[3] = `done` ZSET.
 * ARGV[1] = 'insert' | 'replace' | 'remove'; ARGV[2] = the stored string the write was
 * computed from (replace/remove); ARGV[3] = the new stored string; ARGV[4] = the member
 * (document id); ARGV[5] / ARGV[6] = the `due` / `done` score, or '' for "not indexed".
 * Returns 1 when written, 0 when the document is not in the expected state.
 */
export const DURABLE_WRITE_SCRIPT = `
local cur = redis.call('get', KEYS[1])
if ARGV[1] == 'insert' then
  if cur then return 0 end
elseif cur ~= ARGV[2] then
  return 0
end
if ARGV[1] == 'remove' then
  redis.call('del', KEYS[1])
  redis.call('zrem', KEYS[2], ARGV[4])
  redis.call('zrem', KEYS[3], ARGV[4])
  return 1
end
redis.call('set', KEYS[1], ARGV[3])
if ARGV[5] == '' then redis.call('zrem', KEYS[2], ARGV[4]) else redis.call('zadd', KEYS[2], ARGV[5], ARGV[4]) end
if ARGV[6] == '' then redis.call('zrem', KEYS[3], ARGV[4]) else redis.call('zadd', KEYS[3], ARGV[6], ARGV[4]) end
return 1
`
