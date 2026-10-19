/**
 * Offline migration between the `'legacy'` and `'cluster'` key layouts.
 *
 * Stop every bot of the prefix first (the helper refuses while a coordinator heartbeat
 * or a pending chat ticket exists, unless `allowLive`). The helper only uses ordinary
 * commands (GET/SET/ZADD/ZRANGE/EVAL and SCAN or KEYS on the single-node source), so it
 * runs against any Redis 6.2+ / 7.x server:
 *
 * ```ts
 * import { createClient, createCluster } from 'redis'
 * import { migrateToClusterLayout } from '@bot-wa/redis-store'
 *
 * const source = createClient({ url: 'redis://old-single-node:6379' })
 * await source.connect()
 * // In place (same server), then start the bots with `layout: 'cluster'`:
 * const report = await migrateToClusterLayout({ source, prefix: 'mybot' })
 * // …or straight into a cluster:
 * const target = createCluster({ rootNodes: [{ url: 'redis://cluster-node:6379' }] })
 * await target.connect()
 * await migrateToClusterLayout({ source, target, prefix: 'mybot' })
 * ```
 *
 * Copying is idempotent and resumable: an existing target key wins unless `overwrite`
 * (a schedule record with a higher fencing token always wins: tokens never go backwards).
 * The layout marker is written only by a complete (not `include`-limited) forward run.
 *
 * The rollback (`direction: 'cluster-to-legacy'`) mirrors by default: the legacy target is
 * made to match the cluster-layout source, so writes and deletions made after the forward
 * pass are carried back (see {@link MigrateKeyspaceOptions.mirror}). Its source may be a
 * single node or a Redis Cluster client; its target is a single node.
 *
 * The source is never modified unless `deleteSource` (a separate, explicit pass), except
 * the layout marker, which a complete rollback removes.
 */
import { legacyMessageKey, messageKey, type StoredMessage } from '@bot-wa/core'
import type { RedisLikeClient } from './RedisStore.js'
import {
  CAS_INDEXED_SCRIPT, MAX_COUNTER_SCRIPT, READ_WITH_TTL_SCRIPT, ZRANGE_RAW_SCRIPT,
} from './clusterScripts.js'
import { MERGE_CAS_SCRIPT } from './scripts.js'
import {
  LAYOUT_MARKER, assertLayoutPrefix, scheduleKeys, storeKeys, userDataKeys, coordKeys,
  type RedisKeyLayout,
} from './layout.js'
import { escapeGlob } from './glob.js'
import { matchKeys } from './keys.js'
import { isRedisClusterClient, withClusterRetry, type AnyRedisClient } from './client.js'

/** The families of keys the migration knows. */
export type KeyspaceNamespace =
  | 'messages' | 'chats' | 'contacts' | 'checkpoints' | 'conversations' | 'cursors'
  | 'locks' | 'coordination' | 'schedules' | 'leases' | 'userData' | 'durability'

const ALL_NAMESPACES: KeyspaceNamespace[] = [
  'messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors',
  'locks', 'coordination', 'schedules', 'leases', 'userData', 'durability',
]

export interface MigrateKeyspaceOptions {
  /**
   * Client holding the source layout: a single node (SCAN or KEYS enumerates it) or, for the
   * rollback only (`'cluster-to-legacy'`), a Redis Cluster client (a SCAN on every master).
   */
  source: AnyRedisClient
  /** Where to write. Default: `source` (in place). May be a cluster client (legacy → cluster). */
  target?: AnyRedisClient
  /** Prefix of the source keys. Default `'botwa'`. */
  prefix?: string
  /** Prefix of the target keys. Default `prefix`. Required when `prefix` contains `{`/`}` and the target is the cluster layout. */
  targetPrefix?: string
  /** Default `'legacy-to-cluster'`. `'cluster-to-legacy'` is the rollback (single-node target only). */
  direction?: 'legacy-to-cluster' | 'cluster-to-legacy'
  /** Count what would be copied, write nothing. */
  dryRun?: boolean
  /**
   * Replace target keys that already exist. Default: false (an existing target key wins),
   * except under `mirror`, which requires it. A schedule record never lowers the target's
   * fencing token: an overwritten record keeps the higher of the two tokens.
   */
  overwrite?: boolean
  /**
   * Make the target match the source for every migrated namespace: copied records overwrite,
   * and target records the source no longer holds are deleted (a schedule becomes a
   * deleted marker that keeps its fencing token; lock fences and leadership terms are kept,
   * they only grow). Only for the rollback, where it is the default: without it, the legacy
   * keys a forward pass left behind would win over newer cluster-layout writes, and records
   * deleted since would come back. Pass `false` for a copy-only rollback.
   */
  mirror?: boolean
  /** After copying, delete the source keys whose names changed (default false). */
  deleteSource?: boolean
  /** Run although a coordinator heartbeat or a pending ticket shows a live fleet (default false). */
  allowLive?: boolean
  /** Commands in flight at once (default 16). */
  concurrency?: number
  /** Only these namespaces (default all). */
  include?: KeyspaceNamespace[]
  /** Called after each namespace. */
  onProgress?: (progress: { namespace: KeyspaceNamespace; done: number }) => void
}

export interface MigrationReport {
  dryRun: boolean
  direction: 'legacy-to-cluster' | 'cluster-to-legacy'
  /** Records copied (or that would be, in a dry run), per namespace. */
  copied: Record<KeyspaceNamespace, number>
  /** Records left alone because the target already had them. */
  skippedExisting: Record<KeyspaceNamespace, number>
  /** Message items no chat log references (not copied; first 100). */
  orphans: string[]
  /** Target records deleted (for schedules: replaced by a deleted marker) by `mirror`, per namespace. */
  pruned: Record<KeyspaceNamespace, number>
  /**
   * What happened to the layout marker: `'written'` by a complete forward run, `'removed'`
   * by a complete rollback, `'unchanged'` otherwise (dry run, or a run limited by `include`).
   */
  layoutMarker: 'written' | 'removed' | 'unchanged'
  /** Source keys deleted by `deleteSource`. */
  deletedSource: number
  durationMs: number
}

function counts(): Record<KeyspaceNamespace, number> {
  return Object.fromEntries(ALL_NAMESPACES.map((n) => [n, 0])) as Record<KeyspaceNamespace, number>
}

function str(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : String(v)
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Enumerate keys matching `pattern`, optionally of one TYPE (SCAN … TYPE when available).
 * A cluster client is scanned on every master (no TYPE filter: callers check the key shape).
 */
async function listKeys(client: RedisLikeClient, pattern: string, type?: 'zset' | 'string'): Promise<string[]> {
  if (isRedisClusterClient(client)) return scanEverywhere(client as AnyRedisClient, pattern)
  if (typeof client.scanIterator === 'function' && type) {
    const seen = new Set<string>()
    const scan = client.scanIterator as (o: { MATCH: string; COUNT: number; TYPE: string }) => AsyncIterable<string | string[]>
    for await (const batch of scan.call(client, { MATCH: pattern, COUNT: 1000, TYPE: type })) {
      for (const k of Array.isArray(batch) ? batch : [batch]) seen.add(k)
    }
    return [...seen]
  }
  return matchKeys(client, pattern)
}

/** One readable record of the source layout. */
interface StringRecord { key: string; value: string; pttl: number }

async function readWithTtl(client: RedisLikeClient, key: string): Promise<StringRecord | null> {
  const [value, pttl] = (await client.eval(READ_WITH_TTL_SCRIPT, { keys: [key] })) as [unknown, unknown]
  const v = str(value)
  if (v === null) return null
  return { key, value: v, pttl: Number(pttl) }
}

/** A sorted set with exact scores (`inf`/`-inf` survive; node-redis 4 turns them into NaN). */
async function readZset(client: RedisLikeClient, key: string): Promise<Array<{ score: number; value: string }>> {
  const flat = (await client.eval(ZRANGE_RAW_SCRIPT, { keys: [key] })) as unknown[]
  const out: Array<{ score: number; value: string }> = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const raw = String(flat[i + 1]).toLowerCase()
    const score = raw === 'inf' || raw === '+inf' ? Number.POSITIVE_INFINITY : raw === '-inf' ? Number.NEGATIVE_INFINITY : Number(raw)
    out.push({ value: String(flat[i]), score })
  }
  return out
}

/** The fencing token of a stored schedule record (live or deleted marker); 0 when unreadable. */
function fencingTokenOf(raw: string): number {
  try {
    const token = Number((JSON.parse(raw) as { fencingToken?: unknown }).fencingToken)
    return Number.isFinite(token) ? token : 0
  } catch {
    return 0
  }
}

/** Decode a percent-encoded segment of the cluster layout. */
const dec = (s: string): string => decodeURIComponent(s)

interface Plan {
  ns: KeyspaceNamespace
  /** Run the namespace: returns the source keys that may be deleted afterwards. */
  run(): Promise<string[]>
}

/**
 * Copy a prefix's keyspace from one key layout to the other. See the module docs and the
 * Redis Cluster guide for the recommended procedure.
 */
export async function migrateToClusterLayout(opts: MigrateKeyspaceOptions): Promise<MigrationReport> {
  const started = Date.now()
  const direction = opts.direction ?? 'legacy-to-cluster'
  if (direction !== 'legacy-to-cluster' && direction !== 'cluster-to-legacy') throw new RangeError(`migrateToClusterLayout: unknown direction ${String(direction)}`)
  if (direction === 'legacy-to-cluster' && isRedisClusterClient(opts.source)) {
    throw new RangeError("migrateToClusterLayout: the legacy layout lives on a single-node source (a Redis Cluster client is a source only for the rollback, direction 'cluster-to-legacy')")
  }
  const fromLayout: RedisKeyLayout = direction === 'legacy-to-cluster' ? 'legacy' : 'cluster'
  const toLayout: RedisKeyLayout = direction === 'legacy-to-cluster' ? 'cluster' : 'legacy'
  if (toLayout === 'legacy' && opts.target && isRedisClusterClient(opts.target)) {
    throw new RangeError('migrateToClusterLayout: the legacy layout cannot be written to a Redis Cluster')
  }
  const prefix = opts.prefix ?? 'botwa'
  const targetPrefix = opts.targetPrefix ?? prefix
  assertLayoutPrefix(prefix, fromLayout, 'migrateToClusterLayout (prefix)')
  assertLayoutPrefix(targetPrefix, toLayout, 'migrateToClusterLayout (targetPrefix)')
  const mirror = opts.mirror ?? direction === 'cluster-to-legacy'
  if (mirror && direction !== 'cluster-to-legacy') throw new RangeError("migrateToClusterLayout: mirror is only supported by the rollback (direction 'cluster-to-legacy')")
  if (mirror && opts.overwrite === false) throw new RangeError('migrateToClusterLayout: mirror replaces target records (overwrite: false needs mirror: false)')
  // A cluster client is adapted: EVAL routed by its first key, TRYAGAIN/CLUSTERDOWN retried.
  const source = isRedisClusterClient(opts.source) ? withClusterRetry(opts.source) : (opts.source as RedisLikeClient)
  const rawTarget = (opts.target ?? opts.source) as RedisLikeClient
  const target = isRedisClusterClient(rawTarget) ? withClusterRetry(rawTarget) : rawTarget
  const sameKeyspace = (opts.target === undefined || opts.target === opts.source) && targetPrefix === prefix
  const dryRun = opts.dryRun === true
  const overwrite = opts.overwrite ?? mirror
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 16))
  const include = new Set(opts.include ?? ALL_NAMESPACES)
  const report: MigrationReport = {
    dryRun, direction, copied: counts(), skippedExisting: counts(), pruned: counts(), orphans: [],
    layoutMarker: 'unchanged', deletedSource: 0, durationMs: 0,
  }
  /** Every namespace runs (no `include` limit): only then is the marker written or removed. */
  const complete = ALL_NAMESPACES.every((n) => include.has(n))
  const p = prefix
  const g = escapeGlob(p)

  // --- live-fleet guard -------------------------------------------------------
  if (!opts.allowLive) {
    const assertQuiet = async (client: RedisLikeClient, pfx: string, layout: RedisKeyLayout): Promise<void> => {
      const gp = escapeGlob(pfx)
      const beats = await listKeys(client, `${gp}:co:rep:*`)
      const tickets = await listKeys(client, layout === 'legacy' ? `${gp}:co:t:*:tix` : `${gp}:co:\\{t:*\\}:tix`)
      if (beats.length || tickets.length) {
        throw new Error(`migrateToClusterLayout: prefix "${pfx}" looks live (${beats.length} coordinator heartbeat(s), ${tickets.length} pending ticket queue(s)); stop every bot first or pass allowLive: true`)
      }
    }
    await assertQuiet(source, p, fromLayout)
    // Bots already running on a separate target (another server or prefix) are just as unsafe.
    if (!sameKeyspace) await assertQuiet(target, targetPrefix, toLayout)
  }

  const from = { store: storeKeys(p, fromLayout), sched: scheduleKeys(p, fromLayout), ud: userDataKeys(p, fromLayout), co: coordKeys(p, fromLayout) }
  const to = { store: storeKeys(targetPrefix, toLayout), sched: scheduleKeys(targetPrefix, toLayout), ud: userDataKeys(targetPrefix, toLayout), co: coordKeys(targetPrefix, toLayout) }
  const toCluster = toLayout === 'cluster'

  /** Mirror: the target keys this run copied (or found up to date), per namespace; every other one is stale. */
  const keep = Object.fromEntries(ALL_NAMESPACES.map((n) => [n, new Set<string>()])) as Record<KeyspaceNamespace, Set<string>>

  /** Write one string record (with its remaining TTL and, in the cluster layout, its index entry). */
  async function put(ns: KeyspaceNamespace, key: string, value: string, pttl: number, index?: { key: string; member: string }): Promise<void> {
    if (pttl === -2) return // vanished meanwhile
    keep[ns].add(key)
    const px = pttl > 0 ? pttl : undefined
    if (dryRun) {
      report.copied[ns]++
      return
    }
    let written: boolean
    if (index) {
      written = Number(await target.eval(CAS_INDEXED_SCRIPT, {
        keys: [key, index.key],
        arguments: [overwrite ? '*' : '0', '', value, index.member, px !== undefined ? String(px) : ''],
      })) === 1
    } else {
      const options = { ...(overwrite ? {} : { NX: true as const }), ...(px !== undefined ? { PX: px } : {}) }
      written = (await target.set(key, value, options)) === 'OK'
    }
    if (written) report.copied[ns]++
    else report.skippedExisting[ns]++
  }

  /**
   * Write one schedule record so its fencing token never goes backwards ("never goes
   * backwards for an id", the ScheduleRecord contract): a source record with a higher token
   * than the target's replaces it even without `overwrite`; an overwritten record keeps the
   * higher of the two tokens. Compare-and-set against the target value that was read.
   */
  async function putSchedule(key: string, value: string, index?: { key: string; member: string }): Promise<void> {
    keep.schedules.add(key)
    const sourceToken = fencingTokenOf(value)
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = str(await target.get(key))
      let next: string | undefined = value
      if (current !== null) {
        const targetToken = fencingTokenOf(current)
        if (overwrite) next = targetToken > sourceToken ? JSON.stringify({ ...(JSON.parse(value) as object), fencingToken: targetToken }) : value
        else next = sourceToken > targetToken ? value : undefined
      }
      if (next === undefined) {
        report.skippedExisting.schedules++
        return
      }
      if (dryRun) {
        report.copied.schedules++
        return
      }
      const expected = current === null ? ['0', ''] : ['1', current]
      const ok = index
        ? await target.eval(CAS_INDEXED_SCRIPT, { keys: [key, index.key], arguments: [...expected, next, index.member, ''] })
        : await target.eval(MERGE_CAS_SCRIPT, { keys: [key], arguments: [...expected, next] })
      if (Number(ok) === 1) {
        report.copied.schedules++
        return
      }
    }
    throw new Error(`migrateToClusterLayout: ${key} kept changing while being copied`)
  }

  async function copyIndexed(ns: KeyspaceNamespace, sourceKey: string, id: string, targetKey: string, targetIndex: string | undefined): Promise<boolean> {
    const rec = await readWithTtl(source, sourceKey)
    if (!rec) return false
    const index = targetIndex ? { key: targetIndex, member: id } : undefined
    if (ns === 'schedules') await putSchedule(targetKey, rec.value, index)
    else await put(ns, targetKey, rec.value, rec.pttl, index)
    return true
  }

  /**
   * Mirror: delete the target keys matching `pattern` that this run did not copy (the target
   * is a single node: the rollback writes the legacy layout). `stale` handles one key itself
   * and says whether it counted as pruned.
   */
  async function prune(ns: KeyspaceNamespace, pattern: string, stale?: (key: string) => Promise<boolean>): Promise<void> {
    if (!mirror) return
    const keys = (await listKeys(target, pattern)).filter((k) => !keep[ns].has(k))
    await pool(keys, limit, async (key) => {
      if (stale) {
        if (await stale(key)) report.pruned[ns]++
      } else if (dryRun) {
        report.pruned[ns]++
      } else {
        const n = Number(await target.del(key)) // read before adding: concurrent workers
        report.pruned[ns] += n
      }
    })
  }

  /** Mirror, schedules: a stale live record becomes a deleted marker that keeps its fencing token. */
  async function tombstone(key: string): Promise<boolean> {
    const raw = str(await target.get(key))
    if (raw === null) return false
    let rec: { id?: unknown; deleted?: unknown; fencingToken?: unknown }
    try {
      rec = JSON.parse(raw) as typeof rec
    } catch {
      return false // not a schedule record: left alone
    }
    if (rec.deleted === true) return false
    if (dryRun) return true
    const marker = JSON.stringify({ id: rec.id, deleted: true, fencingToken: fencingTokenOf(raw) })
    return Number(await target.eval(MERGE_CAS_SCRIPT, { keys: [key], arguments: ['1', raw, marker] })) === 1
  }

  /** Ids of an indexed kind in the source layout. */
  async function sourceIds(kind: 'chat' | 'contact' | 'cp' | 'sched'): Promise<Array<{ id: string; key: string }>> {
    if (fromLayout === 'legacy') {
      const ns = { chat: 'chat', contact: 'contact', cp: 'cp', sched: 'sched' }[kind]
      const base = `${p}:${ns}:`
      return (await listKeys(source, `${escapeGlob(base)}*`, 'string')).map((key) => ({ key, id: key.slice(base.length) }))
    }
    const out: Array<{ id: string; key: string }> = []
    const idxs = kind === 'sched' ? from.sched.all() : from.store.indexes(kind)
    for (const idx of idxs) {
      for (const id of await source.zRange(idx, 0, -1)) {
        const key = kind === 'chat' ? from.store.chat(id) : kind === 'contact' ? from.store.contact(id) : kind === 'cp' ? from.store.checkpoint(id) : from.sched.record(id)
        out.push({ id, key })
      }
    }
    return out
  }

  const plans: Plan[] = []

  // --- chats, contacts, checkpoints, schedules (indexed records) ----------------
  const indexed: Array<[KeyspaceNamespace, 'chat' | 'contact' | 'cp' | 'sched']> = [['chats', 'chat'], ['contacts', 'contact'], ['checkpoints', 'cp'], ['schedules', 'sched']]
  for (const [ns, kind] of indexed) {
    plans.push({
      ns,
      run: async () => {
        const ids = await sourceIds(kind)
        const done: string[] = []
        await pool(ids, limit, async ({ id, key }) => {
          const targetKey = kind === 'chat' ? to.store.chat(id) : kind === 'contact' ? to.store.contact(id) : kind === 'cp' ? to.store.checkpoint(id) : to.sched.record(id)
          const targetIndex = kind === 'chat' ? to.store.chatIndex(id) : kind === 'contact' ? to.store.contactIndex(id) : kind === 'cp' ? to.store.checkpointIndex(id) : to.sched.index(id)
          if (await copyIndexed(ns, key, id, targetKey, targetIndex)) done.push(key)
        })
        if (fromLayout === 'cluster') done.push(...(kind === 'sched' ? from.sched.all() : from.store.indexes(kind)))
        // Mirror (legacy target): records the cluster layout no longer holds.
        const legacyNs = { chat: 'chat', contact: 'contact', cp: 'cp', sched: 'sched' }[kind]
        await prune(ns, `${escapeGlob(`${targetPrefix}:${legacyNs}:`)}*`, kind === 'sched' ? tombstone : undefined)
        return done
      },
    })
  }

  // --- messages ------------------------------------------------------------------
  plans.push({
    ns: 'messages',
    run: async () => {
      // Chat logs are found by their sorted sets (never by parsing item keys: legacy names are ambiguous).
      const logs: Array<{ chatId: string; key: string }> = []
      if (fromLayout === 'legacy') {
        const base = `${p}:msg:`
        for (const key of await listKeys(source, `${escapeGlob(base)}*`, 'zset')) {
          logs.push({ chatId: key.slice(base.length), key })
        }
      } else {
        const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\{m:([^}]*)\\}:z$`)
        for (const key of await listKeys(source, `${g}:\\{m:*\\}:z`, 'zset')) {
          const m = re.exec(key)
          if (m) logs.push({ chatId: dec(m[1]!), key })
        }
      }
      const referenced = new Set<string>()
      const done: string[] = []
      await pool(logs, limit, async ({ chatId, key }) => {
        let entries: Array<{ score: number; value: string }>
        try {
          entries = await readZset(source, key)
        } catch (err) {
          if (/WRONGTYPE/.test(String((err as Error)?.message))) return // a string item that matched the pattern
          throw err
        }
        const targetSet = to.store.msgSet(chatId)
        keep.messages.add(targetSet)
        const copiedMembers = new Set<string>()
        for (const { score, value: member } of entries) {
          const itemKey = from.store.msgItem(chatId, member)
          referenced.add(itemKey)
          const raw = str(await source.get(itemKey))
          if (raw == null) continue
          const msg = JSON.parse(raw) as StoredMessage
          // The owned-message rule: the item must hold a message of this chat under this member.
          if (msg.chatId !== chatId || !msg.ref || (messageKey(msg.ref) !== member && legacyMessageKey(msg.ref) !== member)) continue
          const targetItem = to.store.msgItem(chatId, member)
          keep.messages.add(targetItem)
          copiedMembers.add(member)
          if (dryRun) {
            report.copied.messages++
            done.push(itemKey)
            continue
          }
          const written = (await target.set(targetItem, raw, overwrite ? undefined : { NX: true })) === 'OK'
          await target.zAdd(targetSet, { score, value: member }, overwrite ? undefined : { NX: true })
          if (written) report.copied.messages++
          else report.skippedExisting.messages++
          done.push(itemKey)
        }
        if (mirror) {
          // Members the source log no longer has (deleted or pruned messages).
          const extra = (await target.zRange(targetSet, 0, -1)).map(String).filter((m) => !copiedMembers.has(m))
          if (extra.length) {
            if (!dryRun) await target.zRem(targetSet, extra)
            report.pruned.messages += extra.length
          }
        }
        done.push(key)
      })
      // Mirror: chat logs and items the source no longer has (their items too).
      await prune('messages', `${escapeGlob(`${targetPrefix}:msg:`)}*`)
      // Orphans: items no log references (reported, never copied).
      const itemPattern = fromLayout === 'legacy' ? `${escapeGlob(`${p}:msg:item:`)}*` : `${g}:\\{m:*\\}:i:*`
      for (const key of await listKeys(source, itemPattern, 'string')) {
        if (!referenced.has(key) && report.orphans.length < 100) report.orphans.push(key)
      }
      return done
    },
  })

  // --- user data -----------------------------------------------------------------
  plans.push({
    ns: 'userData',
    run: async () => {
      const entries: Array<{ key: string; user: string; ns: string; k: string }> = []
      const indexes: string[] = []
      if (fromLayout === 'legacy') {
        const base = `${p}:ud:`
        for (const key of await listKeys(source, `${escapeGlob(base)}*`, 'string')) {
          const parts = key.slice(base.length).split(':')
          if (parts.length !== 3) continue
          const [user, ns, k] = parts.map(dec) as [string, string, string]
          entries.push({ key, user, ns, k })
        }
      } else {
        const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\{ud:([^}]*)\\}:idx$`)
        for (const idx of await listKeys(source, `${g}:\\{ud:*\\}:idx`, 'zset')) {
          const m = re.exec(idx)
          if (!m) continue
          indexes.push(idx)
          const user = dec(m[1]!)
          for (const member of await source.zRange(idx, 0, -1)) {
            const parts = member.split(':')
            if (parts.length !== 2) continue
            const [ns, k] = parts.map(dec) as [string, string]
            entries.push({ key: from.ud.entry(user, ns, k), user, ns, k })
          }
        }
      }
      const done: string[] = []
      await pool(entries, limit, async (e) => {
        const index = to.ud.index(e.user)
        if (await copyIndexed('userData', e.key, to.ud.member(e.ns, e.k), to.ud.entry(e.user, e.ns, e.k), index)) done.push(e.key)
      })
      await prune('userData', `${escapeGlob(`${targetPrefix}:ud:`)}*`)
      return [...done, ...indexes]
    },
  })

  // --- locks (token + fence counter: fences never go backwards) --------------------
  plans.push({
    ns: 'locks',
    run: async () => {
      const done: string[] = []
      const locks: Array<{ key: string; name: string; fence: boolean }> = []
      if (fromLayout === 'legacy') {
        for (const key of await listKeys(source, `${escapeGlob(`${p}:lock:`)}*`, 'string')) locks.push({ key, name: key.slice(`${p}:lock:`.length), fence: false })
        for (const key of await listKeys(source, `${escapeGlob(`${p}:lockfence:`)}*`, 'string')) locks.push({ key, name: key.slice(`${p}:lockfence:`.length), fence: true })
      } else {
        const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\{lk:([^}]*)\\}:(l|f)$`)
        for (const key of await listKeys(source, `${g}:\\{lk:*\\}:?`, 'string')) {
          const m = re.exec(key)
          if (m) locks.push({ key, name: dec(m[1]!), fence: m[2] === 'f' })
        }
      }
      await pool(locks, limit, async (l) => {
        const rec = await readWithTtl(source, l.key)
        if (!rec) return
        if (l.fence) {
          if (dryRun) report.copied.locks++
          else {
            await target.eval(MAX_COUNTER_SCRIPT, { keys: [to.store.lockFence(l.name)], arguments: [rec.value] })
            report.copied.locks++
          }
        } else {
          await put('locks', to.store.lock(l.name), rec.value, rec.pttl)
        }
        done.push(l.key)
      })
      // Mirror: lock tokens the source does not hold (fences are kept: they only grow).
      await prune('locks', `${escapeGlob(`${targetPrefix}:lock:`)}*`)
      return done
    },
  })

  // --- coordination: leadership terms only (turn counters are short-lived) ---------
  plans.push({
    ns: 'coordination',
    run: async () => {
      const done: string[] = []
      const terms: Array<{ key: string; name: string }> = []
      if (fromLayout === 'legacy') {
        const base = `${p}:co:lead:`
        for (const key of await listKeys(source, `${escapeGlob(base)}*:term`, 'string')) {
          terms.push({ key, name: key.slice(base.length, -':term'.length) })
        }
      } else {
        const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:co:\\{ld:([^}]*)\\}:term$`)
        for (const key of await listKeys(source, `${g}:co:\\{ld:*\\}:term`, 'string')) {
          const m = re.exec(key)
          if (m) terms.push({ key, name: dec(m[1]!) })
        }
      }
      await pool(terms, limit, async (t) => {
        const raw = str(await source.get(t.key))
        if (raw === null || !/^\d+$/.test(raw)) return // a leadership lease of a name ending in ':term', not a counter
        if (!dryRun) await target.eval(MAX_COUNTER_SCRIPT, { keys: [to.co.lead(t.name).term], arguments: [raw] })
        report.copied.coordination++
        done.push(t.key)
      })
      return done
    },
  })

  // --- namespaces whose names do not change: copied only to another keyspace -------
  const unchanged: Array<[KeyspaceNamespace, string]> = [
    ['conversations', `${p}:conv:`], ['cursors', `${p}:cursor:`], ['leases', `${p}:lease:`],
  ]
  for (const [ns, base] of unchanged) {
    plans.push({
      ns,
      run: async () => {
        if (sameKeyspace) return []
        const keys = await listKeys(source, `${escapeGlob(base)}*`, 'string')
        await pool(keys, limit, async (key) => {
          const rec = await readWithTtl(source, key)
          if (rec) await put(ns, targetPrefix + key.slice(p.length), rec.value, rec.pttl)
        })
        await prune(ns, `${escapeGlob(targetPrefix + base.slice(p.length))}*`)
        return [] // never deleted: other layouts share these names
      },
    })
  }
  plans.push({
    ns: 'durability',
    run: async () => {
      if (sameKeyspace) return []
      const docs = await listKeys(source, `${g}:\\{durable:*\\}:doc:*`, 'string')
      await pool(docs, limit, async (key) => {
        const rec = await readWithTtl(source, key)
        if (rec) await put('durability', targetPrefix + key.slice(p.length), rec.value, rec.pttl)
      })
      for (const key of await listKeys(source, `${g}:\\{durable:*\\}:*`, 'zset')) {
        let entries: Array<{ score: number; value: string }>
        try { entries = await readZset(source, key) } catch { continue }
        const targetKey = targetPrefix + key.slice(p.length)
        keep.durability.add(targetKey)
        if (dryRun) continue
        if (mirror) await target.del(targetKey) // the index is replaced, not merged
        if (entries.length) await target.zAdd(targetKey, entries, overwrite ? undefined : { NX: true })
      }
      await prune('durability', `${escapeGlob(targetPrefix)}:\\{durable:*\\}:*`)
      return []
    },
  })

  const toDelete: string[] = []
  for (const plan of plans) {
    if (!include.has(plan.ns)) continue
    const done = await plan.run()
    toDelete.push(...done)
    opts.onProgress?.({ namespace: plan.ns, done: report.copied[plan.ns] })
  }

  // The marker means "this prefix is fully migrated": only a complete run sets or clears it.
  if (!dryRun && complete) {
    if (toCluster) {
      await target.set(to.store.meta(), LAYOUT_MARKER, { NX: true })
      report.layoutMarker = 'written'
    } else if (Number(await target.del(to.store.meta())) > 0) {
      // Rolled back: a cluster-layout store must not start over the restored legacy data.
      report.layoutMarker = 'removed'
    }
  }

  if (opts.deleteSource && !dryRun) {
    const unique = [...new Set(toDelete)]
    await pool(unique, limit, async (key) => {
      const n = await source.del(key)
      report.deletedSource += n
    })
    if (fromLayout === 'cluster' && complete) {
      const n = await source.del(from.store.meta())
      report.deletedSource += n
    }
  }

  report.durationMs = Date.now() - started
  return report
}

export interface KeyspaceInspection {
  /** Keys per namespace in the legacy layout. */
  legacy: Partial<Record<KeyspaceNamespace, number>>
  /** Keys per namespace in the cluster layout. */
  cluster: Partial<Record<KeyspaceNamespace, number>>
  /** The layout marker, if any. */
  marker: string | null
}

/**
 * Count a prefix's keys per layout and namespace (single node: SCAN/KEYS; cluster client:
 * a SCAN on every master). For planning a migration and for checking it.
 */
export async function inspectKeyspace(opts: { client: AnyRedisClient; prefix?: string }): Promise<KeyspaceInspection> {
  const p = opts.prefix ?? 'botwa'
  const g = escapeGlob(p)
  const keys = await scanEverywhere(opts.client, `${g}:*`)
  const legacy: Partial<Record<KeyspaceNamespace, number>> = {}
  const cluster: Partial<Record<KeyspaceNamespace, number>> = {}
  const bump = (into: Partial<Record<KeyspaceNamespace, number>>, ns: KeyspaceNamespace) => { into[ns] = (into[ns] ?? 0) + 1 }
  for (const key of keys) {
    const rest = key.slice(p.length + 1)
    if (rest.startsWith('msg:')) bump(legacy, 'messages')
    else if (rest.startsWith('chat:')) bump(legacy, 'chats')
    else if (rest.startsWith('contact:')) bump(legacy, 'contacts')
    else if (rest.startsWith('cp:')) bump(legacy, 'checkpoints')
    else if (rest.startsWith('ud:')) bump(legacy, 'userData')
    else if (rest.startsWith('lock:') || rest.startsWith('lockfence:')) bump(legacy, 'locks')
    else if (rest.startsWith('sched:')) bump(legacy, 'schedules')
    else if (rest.startsWith('co:t:') || rest.startsWith('co:lead:')) bump(legacy, 'coordination')
    else if (rest.startsWith('{m:')) bump(cluster, 'messages')
    else if (rest.startsWith('{ch:')) bump(cluster, 'chats')
    else if (rest.startsWith('{ct:')) bump(cluster, 'contacts')
    else if (rest.startsWith('{cp:')) bump(cluster, 'checkpoints')
    else if (rest.startsWith('{ud:')) bump(cluster, 'userData')
    else if (rest.startsWith('{lk:')) bump(cluster, 'locks')
    else if (rest.startsWith('{sc:')) bump(cluster, 'schedules')
    else if (rest.startsWith('co:{')) bump(cluster, 'coordination')
    else if (rest.startsWith('conv:')) { bump(legacy, 'conversations'); bump(cluster, 'conversations') }
    else if (rest.startsWith('cursor:')) { bump(legacy, 'cursors'); bump(cluster, 'cursors') }
    else if (rest.startsWith('lease:')) { bump(legacy, 'leases'); bump(cluster, 'leases') }
    else if (rest.startsWith('{durable:')) { bump(legacy, 'durability'); bump(cluster, 'durability') }
  }
  const marker = str(await (opts.client as RedisLikeClient).get(`${p}:{meta}:layout`))
  return { legacy, cluster, marker }
}

interface ClusterLike {
  masters: unknown[]
  nodeClient(node: unknown): RedisLikeClient | Promise<RedisLikeClient>
}

/** Every key matching `pattern`: SCAN on each master of a cluster client, else the single node. */
export async function scanEverywhere(client: AnyRedisClient, pattern: string): Promise<string[]> {
  if (!isRedisClusterClient(client)) return matchKeys(client as RedisLikeClient, pattern)
  const cluster = client as unknown as ClusterLike
  const out = new Set<string>()
  for (const master of cluster.masters) {
    const node = await cluster.nodeClient(master)
    for (const key of await matchKeys(node, pattern)) out.add(key)
  }
  return [...out]
}
