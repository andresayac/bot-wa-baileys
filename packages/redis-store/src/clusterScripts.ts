/**
 * Lua scripts of the cluster key layout (internal). Every script declares EVERY key it
 * touches in KEYS, and every caller checks with `assertOneSlot` that they share one hash
 * slot, so the scripts run unchanged on a single node and on Redis Cluster. Exported so
 * the in-memory test fakes can dispatch on the exact script text. The legacy scripts
 * (scripts.ts, coordScripts.ts, durabilityScripts.ts) are untouched.
 */

/**
 * Compare-and-set of one record plus its index entry, atomically.
 * KEYS[1] = record, KEYS[2] = index ZSET.
 * ARGV[1] = '0' (record must be absent) | '1' (record must equal ARGV[2]) | '*' (no check);
 * ARGV[3] = new value; ARGV[4] = index member; ARGV[5] = PX in ms or '' (no expiry).
 * The index score is the server's expiry instant in ms (TIME + PX), or +inf.
 * Returns 1 when written, 0 on a conflict.
 */
export const CAS_INDEXED_SCRIPT = `
local cur = redis.call('get', KEYS[1])
if ARGV[1] == '0' then
  if cur then return 0 end
elseif ARGV[1] == '1' then
  if cur ~= ARGV[2] then return 0 end
end
if ARGV[5] ~= '' then
  redis.call('set', KEYS[1], ARGV[3], 'PX', ARGV[5])
  local t = redis.call('time')
  local at = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[5])
  redis.call('zadd', KEYS[2], at, ARGV[4])
else
  redis.call('set', KEYS[1], ARGV[3])
  redis.call('zadd', KEYS[2], '+inf', ARGV[4])
end
return 1
`

/**
 * Checkpoint compare-and-set plus its index entry, atomically (cluster layout; see
 * `IStore.setCheckpointIf`). KEYS[1] = record, KEYS[2] = index ZSET; ARGV[1] = expected
 * revision (the stored JSON's `revision`, 0 when absent or without one); ARGV[2] = new
 * value; ARGV[3] = index member; ARGV[4] = PX in ms or ''. Index score as CAS_INDEXED_SCRIPT.
 * Returns 1 when written, 0 when refused.
 */
export const CAS_CHECKPOINT_INDEXED_SCRIPT = `
local cur = redis.call('get', KEYS[1])
local rev = 0
if cur then
  local ok, doc = pcall(cjson.decode, cur)
  if ok and type(doc) == 'table' and type(doc.revision) == 'number' then rev = doc.revision end
end
if rev ~= tonumber(ARGV[1]) then return 0 end
if ARGV[4] ~= '' then
  redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[4])
  local t = redis.call('time')
  local at = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[4])
  redis.call('zadd', KEYS[2], at, ARGV[3])
else
  redis.call('set', KEYS[1], ARGV[2])
  redis.call('zadd', KEYS[2], '+inf', ARGV[3])
end
return 1
`

/**
 * Conditional checkpoint delete plus its index entry (cluster layout; see
 * `IStore.clearCheckpointIf`). KEYS[1] = record, KEYS[2] = index; ARGV[1] = expected
 * revision, ARGV[2] = member. Returns 1 when the record is gone (deleted or absent), 0
 * when another revision is stored.
 */
export const CLEAR_CHECKPOINT_IF_INDEXED_SCRIPT = `
local cur = redis.call('get', KEYS[1])
if not cur then
  redis.call('zrem', KEYS[2], ARGV[2])
  return 1
end
local rev = 0
local ok, doc = pcall(cjson.decode, cur)
if ok and type(doc) == 'table' and type(doc.revision) == 'number' then rev = doc.revision end
if rev ~= tonumber(ARGV[1]) then return 0 end
redis.call('del', KEYS[1])
redis.call('zrem', KEYS[2], ARGV[2])
return 1
`

/** Delete one record and its index entry. KEYS[1] = record, KEYS[2] = index; ARGV[1] = member. Returns the DEL count. */
export const DEL_INDEXED_SCRIPT = `
local n = redis.call('del', KEYS[1])
redis.call('zrem', KEYS[2], ARGV[1])
return n
`

/**
 * Drop messages of ONE chat: for each i, ZREM ARGV[i] from KEYS[1] and, only when it
 * really was a member, DEL KEYS[i + 1] (membership proves ownership, like
 * DROP_MESSAGE_SCRIPT). Returns how many were removed.
 */
export const DROP_MESSAGES_SCRIPT = `
local n = 0
for i = 1, #ARGV do
  if redis.call('zrem', KEYS[1], ARGV[i]) == 1 then
    redis.call('del', KEYS[i + 1])
    n = n + 1
  end
end
return n
`

/** Prune index entries whose expiry passed (server clock) and return the live members. KEYS[1] = index. */
export const LIVE_INDEX_SCRIPT = `
local t = redis.call('time')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('zremrangebyscore', KEYS[1], '-inf', now)
return redis.call('zrange', KEYS[1], 0, -1)
`

/** Delete several entries of one index. KEYS[1] = index, KEYS[i + 1] = entry of member ARGV[i]. Returns the DEL count. */
export const DELETE_BATCH_SCRIPT = `
local n = 0
for i = 1, #ARGV do
  n = n + redis.call('del', KEYS[i + 1])
  redis.call('zrem', KEYS[1], ARGV[i])
end
return n
`

/** EXISTS through EVAL (the coordinator's client surface is EVAL-only). KEYS[1] = key. */
export const PROBE_EXISTS_SCRIPT = `
return redis.call('exists', KEYS[1])
`

/**
 * Cluster variant of TURN_SCRIPT: the heartbeat of another replica lives in another
 * slot, so the script cannot read it. KEYS = serving, owner, tix, last (one slot);
 * ARGV = seq, holder, leaseMs, ...holders the caller saw without a heartbeat.
 * An earlier ticket whose turn is held waits ({0}); one whose holder is not in the
 * dead list returns {2, holder} (the caller probes its heartbeat and retries); one of
 * a dead holder is skipped exactly as TURN_SCRIPT does. Other replies as TURN_SCRIPT.
 */
export const TURN_CLUSTER_SCRIPT = `
local seq = tonumber(ARGV[1])
local dead = {}
for i = 4, #ARGV do dead[ARGV[i]] = true end
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
    if redis.call('get', KEYS[2]) == (tostring(cur) .. '|' .. h) then return {0, ''} end
    if not dead[h] then return {2, h} end
    redis.call('hdel', KEYS[3], tostring(cur))
    redis.call('set', KEYS[4], h)
  end
  redis.call('incr', KEYS[1])
end
return {0, ''}
`

/** Read a string and its remaining PTTL in one round trip. KEYS[1] = key. Returns {value|nil, pttl}. */
export const READ_WITH_TTL_SCRIPT = `
return {redis.call('get', KEYS[1]), redis.call('pttl', KEYS[1])}
`

/**
 * Raise a counter to ARGV[1] if it is lower ("set if greater"): migrated fences and
 * terms never go backwards. KEYS[1] = counter. Returns the resulting value.
 */
export const MAX_COUNTER_SCRIPT = `
local c = tonumber(redis.call('get', KEYS[1]) or '0')
local v = tonumber(ARGV[1])
if v > c then
  redis.call('set', KEYS[1], ARGV[1])
  return v
end
return c
`

/**
 * Every member of a sorted set with its score as the server prints it (`inf`, `-inf`
 * included: node-redis 4 parses those to NaN). KEYS[1] = sorted set. Returns a flat
 * {member, score, …} array.
 */
export const ZRANGE_RAW_SCRIPT = `
return redis.call('zrange', KEYS[1], 0, -1, 'WITHSCORES')
`

/**
 * Save one message: its item and its log entry, atomically (the cluster layout uses
 * scripts instead of MULTI: node-redis follows MOVED/ASK for a routed EVAL, but not for
 * a MULTI aborted by a topology change). KEYS[1] = item, KEYS[2] = chat log;
 * ARGV = JSON, score, member.
 */
export const SAVE_MESSAGE_SCRIPT = `
redis.call('set', KEYS[1], ARGV[1])
redis.call('zadd', KEYS[2], ARGV[2], ARGV[3])
return 1
`
