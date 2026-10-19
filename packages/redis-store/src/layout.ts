/**
 * Key layouts of `@bot-wa/redis-store`.
 *
 * - `'legacy'` (default on a single node): exactly the historical key names. Several
 *   multi-key scripts and transactions touch keys of different hash slots, so it does
 *   NOT work on Redis Cluster.
 * - `'cluster'`: every group of keys that one script or MULTI touches shares a hash tag
 *   (`{…}`), so it always lives in one slot; listings read per-bucket index sorted sets
 *   instead of scanning (`KEYS`/`SCAN` only see one node of a cluster). Works on a
 *   single node too, which is how an existing keyspace is migrated in place
 *   (see `migrateToClusterLayout`).
 *
 * Cluster layout (`p` = prefix; `enc()` percent-encodes a segment, see {@link encodeSegment}):
 *
 *   p:{m:<enc chat>}:z                    ZSET member -> timestamp (one chat's message log)
 *   p:{m:<enc chat>}:i:<member>           JSON StoredMessage
 *   p:{ch:<b>}:r:<enc id>  + p:{ch:<b>}:idx   chat record + bucket index (b = bucketOf(id))
 *   p:{ct:<b>}:r:<enc id>  + p:{ct:<b>}:idx   contact
 *   p:{cp:<b>}:r:<enc key> + p:{cp:<b>}:idx   flow checkpoint (index score = server expiry ms or +inf)
 *   p:{sc:<b>}:r:<enc id>  + p:{sc:<b>}:idx   durable schedule record
 *   p:{ud:<enc user>}:e:<enc ns>:<enc key> + p:{ud:<enc user>}:idx   ctx.user entry + per-user index
 *   p:{lk:<enc key>}:l     + p:{lk:<enc key>}:f   lock + its fence counter
 *   p:co:{t:<enc key>}:seq|tix|serving|owner|last  coordinator chat turn
 *   p:co:{ld:<enc name>}   + …:term       coordinator leadership
 *   p:conv:*, p:cursor:*, p:lease:*, p:co:rep:*, p:{durable:<table>}:*   unchanged (single key / already tagged)
 *   p:{meta}:layout                       layout marker ("cluster:v1")
 */

/** Which key names the Redis components use. See the module docs. */
export type RedisKeyLayout = 'legacy' | 'cluster'

/** Buckets per indexed record kind in the cluster layout. Part of the layout contract (`cluster:v1`). */
export const INDEX_BUCKETS = 32

/** Value of the layout marker key written by a cluster-layout store. */
export const LAYOUT_MARKER = 'cluster:v1'

/** Percent-encode one key segment: no `:` separator, no `{`/`}` hash-tag braces and no glob character survives. */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** The legacy user-data segment encoding (kept byte for byte: it names existing keys). */
function legacyUserSegment(value: string): string {
  return encodeURIComponent(value).replace(/\*/g, '%2A')
}

/** Index bucket of a record id: FNV-1a 32 over its UTF-8 bytes, modulo {@link INDEX_BUCKETS}. */
export function bucketOf(id: string): number {
  let h = 0x811c9dc5
  for (const b of Buffer.from(id, 'utf8')) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % INDEX_BUCKETS
}

/** Validate a layout name and, for the cluster layout, a prefix without hash-tag braces. */
export function assertLayoutPrefix(prefix: string, layout: RedisKeyLayout, who: string): void {
  if (layout !== 'legacy' && layout !== 'cluster') {
    throw new RangeError(`${who}: layout must be 'legacy' or 'cluster', got ${String(layout)}`)
  }
  if (layout === 'cluster' && /[{}]/.test(prefix)) {
    throw new RangeError(`${who}: a prefix with '{' or '}' would break the hash tags of the cluster layout, got ${JSON.stringify(prefix)}`)
  }
}

export type IndexedKind = 'chat' | 'contact' | 'cp' | 'sched'

const TAGS: Record<IndexedKind, string> = { chat: 'ch', contact: 'ct', cp: 'cp', sched: 'sc' }

function bucketIndexes(prefix: string, kind: IndexedKind): string[] {
  return Array.from({ length: INDEX_BUCKETS }, (_, b) => `${prefix}:{${TAGS[kind]}:${b}}:idx`)
}

function indexedRecord(prefix: string, kind: IndexedKind, id: string): { record: string; index: string } {
  const b = bucketOf(id)
  return { record: `${prefix}:{${TAGS[kind]}:${b}}:r:${encodeSegment(id)}`, index: `${prefix}:{${TAGS[kind]}:${b}}:idx` }
}

/** Key names of {@link RedisStore}. */
export interface StoreKeys {
  readonly layout: RedisKeyLayout
  msgSet(chatId: string): string
  /** Item key of a message-log member (`member` = messageKey(ref), or the legacy key for old rows). */
  msgItem(chatId: string, member: string): string
  chat(id: string): string
  chatIndex(id: string): string | undefined
  contact(id: string): string
  contactIndex(id: string): string | undefined
  checkpoint(key: string): string
  checkpointIndex(key: string): string | undefined
  conversation(key: string): string
  cursor(key: string): string
  lock(key: string): string
  lockFence(key: string): string
  /** Every bucket index of a record kind (cluster layout; empty in the legacy one). */
  indexes(kind: IndexedKind): string[]
  /** The layout marker key. */
  meta(): string
}

export function storeKeys(prefix: string, layout: RedisKeyLayout): StoreKeys {
  assertLayoutPrefix(prefix, layout, 'RedisStore')
  const p = prefix
  const meta = (): string => `${p}:{meta}:layout`
  if (layout === 'legacy') {
    return {
      layout,
      msgSet: (chatId) => `${p}:msg:${chatId}`,
      msgItem: (_chatId, member) => `${p}:msg:item:${member}`,
      chat: (id) => `${p}:chat:${id}`,
      chatIndex: () => undefined,
      contact: (id) => `${p}:contact:${id}`,
      contactIndex: () => undefined,
      checkpoint: (key) => `${p}:cp:${key}`,
      checkpointIndex: () => undefined,
      conversation: (key) => `${p}:conv:${key}`,
      cursor: (key) => `${p}:cursor:${key}`,
      lock: (key) => `${p}:lock:${key}`,
      lockFence: (key) => `${p}:lockfence:${key}`,
      indexes: () => [],
      meta,
    }
  }
  return {
    layout,
    msgSet: (chatId) => `${p}:{m:${encodeSegment(chatId)}}:z`,
    msgItem: (chatId, member) => `${p}:{m:${encodeSegment(chatId)}}:i:${member}`,
    chat: (id) => indexedRecord(p, 'chat', id).record,
    chatIndex: (id) => indexedRecord(p, 'chat', id).index,
    contact: (id) => indexedRecord(p, 'contact', id).record,
    contactIndex: (id) => indexedRecord(p, 'contact', id).index,
    checkpoint: (key) => indexedRecord(p, 'cp', key).record,
    checkpointIndex: (key) => indexedRecord(p, 'cp', key).index,
    conversation: (key) => `${p}:conv:${key}`,
    cursor: (key) => `${p}:cursor:${key}`,
    lock: (key) => `${p}:{lk:${encodeSegment(key)}}:l`,
    lockFence: (key) => `${p}:{lk:${encodeSegment(key)}}:f`,
    indexes: (kind) => bucketIndexes(p, kind),
    meta,
  }
}

/** Key names of {@link RedisCoordinator}. */
export interface CoordKeys {
  rep(holder: string): string
  /** Prefix of every heartbeat key (the legacy turn script builds heartbeat keys from it). */
  readonly repPrefix: string
  turn(key: string): { seq: string; tix: string; serving: string; owner: string; last: string }
  lead(name: string): { lease: string; term: string }
}

export function coordKeys(prefix: string, layout: RedisKeyLayout): CoordKeys {
  assertLayoutPrefix(prefix, layout, 'RedisCoordinator')
  const base = `${prefix}:co`
  const repPrefix = `${base}:rep:`
  const turn = (k: string) => ({ seq: `${k}:seq`, tix: `${k}:tix`, serving: `${k}:serving`, owner: `${k}:owner`, last: `${k}:last` })
  if (layout === 'legacy') {
    return {
      rep: (holder) => repPrefix + holder,
      repPrefix,
      turn: (key) => turn(`${base}:t:${key}`),
      lead: (name) => ({ lease: `${base}:lead:${name}`, term: `${base}:lead:${name}:term` }),
    }
  }
  return {
    rep: (holder) => repPrefix + holder,
    repPrefix,
    turn: (key) => turn(`${base}:{t:${encodeSegment(key)}}`),
    lead: (name) => ({ lease: `${base}:{ld:${encodeSegment(name)}}`, term: `${base}:{ld:${encodeSegment(name)}}:term` }),
  }
}

/** Key names of {@link RedisScheduleStore}. */
export interface ScheduleKeys {
  record(id: string): string
  index(id: string): string | undefined
  /** Every bucket index (cluster layout; empty in the legacy one). */
  all(): string[]
}

export function scheduleKeys(prefix: string, layout: RedisKeyLayout): ScheduleKeys {
  assertLayoutPrefix(prefix, layout, 'RedisScheduleStore')
  if (layout === 'legacy') return { record: (id) => `${prefix}:sched:${id}`, index: () => undefined, all: () => [] }
  return {
    record: (id) => indexedRecord(prefix, 'sched', id).record,
    index: (id) => indexedRecord(prefix, 'sched', id).index,
    all: () => bucketIndexes(prefix, 'sched'),
  }
}

/** Key names of `ctx.user` entries. */
export interface UserDataKeys {
  entry(userId: string, namespace: string, key: string): string
  /** Per-user index (cluster layout only). */
  index(userId: string): string | undefined
  /** Index member of an entry (cluster layout). */
  member(namespace: string, key: string): string
}

export function userDataKeys(prefix: string, layout: RedisKeyLayout): UserDataKeys {
  assertLayoutPrefix(prefix, layout, 'RedisStore')
  if (layout === 'legacy') {
    const e = legacyUserSegment
    return {
      entry: (u, ns, k) => `${prefix}:ud:${e(u)}:${e(ns)}:${e(k)}`,
      index: () => undefined,
      member: (ns, k) => `${e(ns)}:${e(k)}`,
    }
  }
  const e = encodeSegment
  return {
    entry: (u, ns, k) => `${prefix}:{ud:${e(u)}}:e:${e(ns)}:${e(k)}`,
    index: (u) => `${prefix}:{ud:${e(u)}}:idx`,
    member: (ns, k) => `${e(ns)}:${e(k)}`,
  }
}
