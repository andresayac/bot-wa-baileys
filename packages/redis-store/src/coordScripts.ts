/**
 * Lua scripts of {@link RedisCoordinator} (internal). Exported so the in-memory test
 * fake can dispatch on the exact script text. Every script runs atomically on the
 * server, and every expiry is a server-side `PX`, so replica clocks never matter.
 *
 * Key layout (`base` = `{prefix}:co`):
 *   {base}:rep:{replicaId}       heartbeat, PX leaseMs (a replica is alive while it exists)
 *   {base}:t:{key}:seq           INCR counter: ticket numbers of the key
 *   {base}:t:{key}:tix           HASH seq → replicaId: reserved, not yet released tickets
 *   {base}:t:{key}:serving       the ticket allowed to run next
 *   {base}:t:{key}:owner         "{seq}|{replicaId}" PX leaseMs: the granted turn
 *   {base}:t:{key}:last          replica that released the previous turn
 *   {base}:lead:{name}           "{term}|{replicaId}" PX leaseMs: the leadership
 *   {base}:lead:{name}:term      INCR counter: leadership terms (fencing tokens)
 */

/** KEYS[1] = heartbeat key; ARGV[1] = leaseMs. Keep this replica alive. */
export const HEARTBEAT_SCRIPT = `
redis.call('set', KEYS[1], '1', 'PX', ARGV[1])
return 1
`

/** KEYS[1] = heartbeat key. This replica leaves (graceful stop). */
export const LEAVE_SCRIPT = `
return redis.call('del', KEYS[1])
`

/**
 * Reserve a ticket. KEYS = seq, tix, serving, last; ARGV[1] = replicaId.
 * Returns the ticket number. Cancels the idle expiry RELEASE_TURN set.
 */
export const RESERVE_SCRIPT = `
local s = redis.call('incr', KEYS[1])
redis.call('hset', KEYS[2], s, ARGV[1])
if redis.call('exists', KEYS[3]) == 0 then redis.call('set', KEYS[3], s) end
redis.call('persist', KEYS[1])
redis.call('persist', KEYS[3])
redis.call('persist', KEYS[4])
return s
`

/**
 * Try to take a ticket's turn. KEYS = serving, owner, tix, last;
 * ARGV = seq, replicaId, leaseMs, heartbeat key prefix ({base}:rep:).
 * Skips tickets that were withdrawn or whose replica is dead (no heartbeat and no live
 * turn). Returns {1, lastHolder} when granted, {0, ''} when an earlier live ticket goes
 * first, {-1, ''} when this ticket was skipped (superseded) or the state is gone.
 */
export const TURN_SCRIPT = `
local seq = tonumber(ARGV[1])
for i = 1, 1000 do
  local cur = tonumber(redis.call('get', KEYS[1]))
  if cur == nil or cur > seq then return {-1, ''} end
  if cur == seq then
    if redis.call('hget', KEYS[3], ARGV[1]) ~= ARGV[2] then return {-1, ''} end
    local mine = ARGV[1] .. '|' .. ARGV[2]
    local o = redis.call('get', KEYS[2])
    if o and o ~= mine then return {0, ''} end
    redis.call('set', KEYS[2], mine, 'PX', ARGV[3])
    local last = redis.call('get', KEYS[4])
    if not last then last = '' end
    return {1, last}
  end
  local h = redis.call('hget', KEYS[3], tostring(cur))
  if h then
    if redis.call('exists', ARGV[4] .. h) == 1 then return {0, ''} end
    if redis.call('get', KEYS[2]) == (tostring(cur) .. '|' .. h) then return {0, ''} end
    redis.call('hdel', KEYS[3], tostring(cur))
  end
  redis.call('incr', KEYS[1])
end
return {0, ''}
`

/** KEYS[1] = lease key; ARGV = expected value, leaseMs. Extend a turn or leadership only while it is still ours: 1, else 0. */
export const RENEW_SCRIPT = `
-- coordinator: renew lease
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`

/**
 * Release a turn (or withdraw a ticket). KEYS = serving, owner, tix, last, seq;
 * ARGV = seq, replicaId, idleMs. Returns 1 when the turn was handed on, 2 when a
 * not-yet-served ticket was withdrawn, 0 when nothing of ours was left (lost/skipped).
 * When the key has no tickets left its counters expire after idleMs.
 */
export const RELEASE_TURN_SCRIPT = `
local mine = ARGV[1] .. '|' .. ARGV[2]
local cur = tonumber(redis.call('get', KEYS[1]))
local ours = redis.call('hget', KEYS[3], ARGV[1]) == ARGV[2]
if cur == tonumber(ARGV[1]) and ours then
  local o = redis.call('get', KEYS[2])
  if o and o ~= mine then return 0 end
  redis.call('del', KEYS[2])
  redis.call('hdel', KEYS[3], ARGV[1])
  redis.call('set', KEYS[4], ARGV[2])
  redis.call('incr', KEYS[1])
  if redis.call('hlen', KEYS[3]) == 0 then
    redis.call('pexpire', KEYS[1], ARGV[3])
    redis.call('pexpire', KEYS[4], ARGV[3])
    redis.call('pexpire', KEYS[5], ARGV[3])
  end
  return 1
end
if ours then
  redis.call('hdel', KEYS[3], ARGV[1])
  return 2
end
return 0
`

/**
 * Leadership election. KEYS = lead, term; ARGV = replicaId, leaseMs. Returns the term
 * when this replica leads (newly elected or already leading, lease extended), else 0.
 */
export const LEAD_SCRIPT = `
local cur = redis.call('get', KEYS[1])
if not cur then
  local t = redis.call('incr', KEYS[2])
  redis.call('set', KEYS[1], t .. '|' .. ARGV[1], 'PX', ARGV[2])
  return t
end
local sep = string.find(cur, '|', 1, true)
if sep and string.sub(cur, sep + 1) == ARGV[1] then
  redis.call('pexpire', KEYS[1], ARGV[2])
  return tonumber(string.sub(cur, 1, sep - 1))
end
return 0
`

/** KEYS[1] = lead key; ARGV[1] = "{term}|{replicaId}". Step down only if still ours. */
export const LEAD_RELEASE_SCRIPT = `
-- coordinator: release leadership
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`
