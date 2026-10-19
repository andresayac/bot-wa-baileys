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

/**
 * Drop one message of a chat: ZREM the member from the chat's ZSET and, only
 * when it really was a member, DEL its item. Membership proves ownership — an
 * item key can be shared by two refs only through the legacy, unescaped key
 * format — so deleting a ref that was never saved in this chat never removes
 * another chat's message. KEYS[1] = chat ZSET, KEYS[2] = item; ARGV[1] = member.
 * Returns 1 when the message was removed, else 0.
 */
export const DROP_MESSAGE_SCRIPT = `
if redis.call('zrem', KEYS[1], ARGV[1]) == 1 then
  redis.call('del', KEYS[2])
  return 1
end
return 0
`

/**
 * Delete a chat atomically: every message item listed in its ZSET, the ZSET
 * and the chat record, in one script. Reading the members first and deleting
 * in a later MULTI let a message saved in between keep its item while losing
 * its ZSET entry (an orphan that getMessage still returned). DELs go in
 * batches so a long history never exceeds Lua's unpack() limit.
 * KEYS[1] = chat ZSET, KEYS[2] = chat record; ARGV[1] = item-key prefix.
 * Returns the number of messages removed.
 */
export const DELETE_CHAT_SCRIPT = `
local members = redis.call('zrange', KEYS[1], 0, -1)
local batch = {}
for i = 1, #members do
  batch[#batch + 1] = ARGV[1] .. members[i]
  if #batch == 1000 then
    redis.call('del', unpack(batch))
    batch = {}
  end
end
if #batch > 0 then redis.call('del', unpack(batch)) end
redis.call('del', KEYS[1], KEYS[2])
return #members
`

/**
 * Fenced lock acquire: SET NX PX, and on success INCR the lock's fence counter.
 * KEYS[1] = lock, KEYS[2] = fence counter; ARGV = token, ttlMs. Returns the new
 * fence (≥ 1) when acquired, 0 when the lock is held. The counter never expires,
 * so fences only grow.
 */
export const ACQUIRE_FENCED_LOCK_SCRIPT = `
if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('incr', KEYS[2])
end
return 0
`

/** Extend a lock only while `token` still owns it. KEYS[1] = lock; ARGV = token, ttlMs. Returns 1 or 0. */
export const RENEW_LOCK_SCRIPT = `
-- store: renew lock
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`
