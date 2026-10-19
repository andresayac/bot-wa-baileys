/**
 * The inbox/outbox state machines, written once over a {@link DurableKv}.
 *
 * Every transition is read → compute → compare-and-set on the record's version, retried
 * on a concurrent write, so two processes racing for one record can never both win a
 * claim, and a completion is accepted only under the fencing token of the current claim.
 */

import { StaleLeaseError } from './errors.js'
import type { DurableKv, DurableKvIndex, DurableTable } from './kv.js'
import type {
  ClaimedSend, ClaimOptions, DurabilityBackend, InboxAppend, InboxJournal, InboxRecord, InboxState,
  LeaseOptions, OutboxError, OutboxJournal, OutboxPut, OutboxRecord, OutboxState,
} from './types.js'
import type { MessageRef } from '../core/provider.js'

/** Compare-and-set retries before a transition gives up (only under pathological contention). */
const MAX_CAS_ATTEMPTS = 64
/** Upper bound of ids read per scan. */
const SCAN_LIMIT = 10_000

type Outcome<R> = { write: R; result?: unknown } | { result: unknown }

/** Read → transform → CAS loop shared by both journals. `fn` returns `{ write }` to store a new value. */
async function mutate<R, T>(
  kv: DurableKv,
  table: DurableTable,
  id: string,
  indexOf: (r: R) => DurableKvIndex,
  fn: (current: R | undefined) => Outcome<R>,
): Promise<T> {
  for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
    const entry = await kv.get(table, id)
    const current = entry ? (JSON.parse(entry.value) as R) : undefined
    const out = fn(current)
    if (!('write' in out)) return out.result as T
    const value = JSON.stringify(out.write)
    const ok = entry
      ? await kv.replace(table, id, entry.version, value, indexOf(out.write))
      : await kv.insert(table, id, value, indexOf(out.write))
    if (ok !== undefined) return (out.result ?? out.write) as T
  }
  throw new Error(`durability: too much contention on ${table} record ${id}`)
}

async function readAll<R>(kv: DurableKv, table: DurableTable): Promise<R[]> {
  const ids = new Set([
    ...await kv.range(table, 'due', Number.POSITIVE_INFINITY, SCAN_LIMIT),
    ...await kv.range(table, 'done', Number.POSITIVE_INFINITY, SCAN_LIMIT),
  ])
  const out: R[] = []
  for (const id of ids) {
    const entry = await kv.get(table, id)
    if (entry) out.push(JSON.parse(entry.value) as R)
  }
  return out
}

function stale(id: string, token: number, record: { fencingToken: number; state: string } | undefined): StaleLeaseError {
  return new StaleLeaseError(id, token, record?.fencingToken ?? -1, record?.state ?? 'missing')
}

/* ============================================================================
 * Inbox
 * ========================================================================== */

function inboxIndex(r: InboxRecord): DurableKvIndex {
  if (r.state === 'done' || r.state === 'dead') return { due: null, done: r.completedAt ?? r.receivedAt }
  if (r.state === 'processing') return { due: r.leaseUntil ?? 0, done: null }
  return { due: r.nextAttemptAt, done: null }
}

function inboxClaimable(r: InboxRecord, now: number, owner: string, reclaimOwn: boolean): boolean {
  if (r.state === 'pending' || r.state === 'failed') return r.nextAttemptAt <= now
  if (r.state === 'processing') return (r.leaseUntil ?? 0) <= now || (reclaimOwn && r.owner === owner)
  return false
}

function leased<R extends { fencingToken: number; attempts: number }>(r: R, o: LeaseOptions): R {
  return { ...r, owner: o.owner, leaseUntil: o.now + o.leaseMs, fencingToken: r.fencingToken + 1, attempts: r.attempts + 1 }
}

/** {@link InboxJournal} over a {@link DurableKv}. */
export class KvInbox implements InboxJournal {
  /** @param table The KV table (`'inbox'`, or `'inbox:<scope>'` for a scoped view). */
  constructor(private readonly kv: DurableKv, private readonly table: DurableTable = 'inbox') {}

  private mutate<T>(id: string, fn: (r: InboxRecord | undefined) => Outcome<InboxRecord>): Promise<T> {
    return mutate<InboxRecord, T>(this.kv, this.table, id, inboxIndex, fn)
  }

  async append(input: InboxAppend, now: number, lease?: LeaseOptions): Promise<{ status: 'appended' | 'duplicate'; record: InboxRecord }> {
    const fresh: InboxRecord = {
      id: input.id,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      partitionKey: input.partitionKey,
      kind: input.kind,
      payload: input.payload,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      fencingToken: 0,
      receivedAt: input.receivedAt,
    }
    const record: InboxRecord = lease ? { ...leased(fresh, lease), state: 'processing' } : fresh
    return this.mutate(input.id, (current) => current
      ? { result: { status: 'duplicate', record: current } }
      : { write: record, result: { status: 'appended', record } })
  }

  async claim(o: ClaimOptions): Promise<InboxRecord[]> {
    const reclaimOwn = o.reclaimOwn === true
    const max = reclaimOwn ? Number.POSITIVE_INFINITY : o.now
    const ids = await this.kv.range(this.table, 'due', max, reclaimOwn ? SCAN_LIMIT : Math.max(o.limit * 4, 64))
    const candidates: InboxRecord[] = []
    for (const id of ids) {
      const entry = await this.kv.get(this.table, id)
      if (!entry) continue
      const r = JSON.parse(entry.value) as InboxRecord
      if (!inboxClaimable(r, o.now, o.owner, reclaimOwn)) continue
      if (o.partitions && !o.partitions(r.partitionKey)) continue
      candidates.push(r)
    }
    candidates.sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const claimed: InboxRecord[] = []
    for (const c of candidates) {
      if (claimed.length >= o.limit) break
      const r = await this.take(c.id, o, reclaimOwn)
      if (r) claimed.push(r)
    }
    return claimed
  }

  claimOne(id: string, o: LeaseOptions): Promise<InboxRecord | null> { return this.take(id, o, false) }

  private take(id: string, o: LeaseOptions, reclaimOwn: boolean): Promise<InboxRecord | null> {
    return this.mutate(id, (r) => {
      if (!r || !inboxClaimable(r, o.now, o.owner, reclaimOwn)) return { result: null }
      return { write: { ...leased(r, o), state: 'processing' } }
    })
  }

  private complete(id: string, token: number, next: (r: InboxRecord) => InboxRecord): Promise<void> {
    return this.mutate(id, (r) => {
      if (!r || r.state !== 'processing' || r.fencingToken !== token) throw stale(id, token, r)
      return { write: next(r), result: undefined }
    })
  }

  ack(id: string, token: number, now: number): Promise<void> {
    return this.complete(id, token, (r) => ({ ...clearLease(r), state: 'done', completedAt: now }))
  }

  fail(id: string, token: number, error: string, o: { now: number; retryAt?: number; dead?: boolean }): Promise<void> {
    return this.complete(id, token, (r) => o.dead
      ? { ...clearLease(r), state: 'dead', lastError: error, completedAt: o.now }
      : { ...clearLease(r), state: 'failed', lastError: error, nextAttemptAt: o.retryAt ?? o.now })
  }

  release(id: string, token: number, now: number): Promise<void> {
    return this.complete(id, token, (r) => ({ ...clearLease(r), state: 'pending', nextAttemptAt: now, attempts: Math.max(0, r.attempts - 1) }))
  }

  extend(id: string, token: number, leaseUntil: number): Promise<void> {
    return this.complete(id, token, (r) => ({ ...r, leaseUntil }))
  }

  replay(id: string, now: number): Promise<void> {
    return this.mutate(id, (r) => r
      ? { write: { ...clearLease(r), state: 'pending' as InboxState, attempts: 0, nextAttemptAt: now, completedAt: undefined, lastError: undefined }, result: undefined }
      : { result: undefined })
  }

  async get(id: string): Promise<InboxRecord | undefined> {
    const entry = await this.kv.get(this.table, id)
    return entry ? (JSON.parse(entry.value) as InboxRecord) : undefined
  }

  async list(filter: { state?: InboxState; limit?: number } = {}): Promise<InboxRecord[]> {
    const all = (await readAll<InboxRecord>(this.kv, this.table)).filter((r) => !filter.state || r.state === filter.state)
    all.sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1))
    return filter.limit !== undefined ? all.slice(0, filter.limit) : all
  }

  async purge(o: { doneBefore: number; includeDead?: boolean }): Promise<number> {
    let n = 0
    for (const id of await this.kv.range(this.table, 'done', o.doneBefore, SCAN_LIMIT)) {
      const entry = await this.kv.get(this.table, id)
      if (!entry) continue
      const r = JSON.parse(entry.value) as InboxRecord
      const terminal = r.state === 'done' || (o.includeDead === true && r.state === 'dead')
      if (!terminal || (r.completedAt ?? 0) >= o.doneBefore) continue
      if (await this.kv.remove(this.table, id, entry.version)) n++
    }
    return n
  }
}

function clearLease<R extends { owner?: string; leaseUntil?: number }>(r: R): R {
  const { owner: _o, leaseUntil: _l, ...rest } = r
  return rest as R
}

/* ============================================================================
 * Outbox
 * ========================================================================== */

function outboxIndex(r: OutboxRecord): DurableKvIndex {
  if (r.state === 'sent' || r.state === 'dead' || r.state === 'unknown') return { due: null, done: r.completedAt ?? r.createdAt }
  if (r.state === 'sending') return { due: r.leaseUntil ?? 0, done: null }
  return { due: r.nextAttemptAt, done: null }
}

function outboxClaimable(r: OutboxRecord, now: number, owner: string, reclaimOwn: boolean): boolean {
  if (r.state === 'pending' || r.state === 'failed') return r.nextAttemptAt <= now
  if (r.state === 'sending') return (r.leaseUntil ?? 0) <= now || (reclaimOwn && r.owner === owner)
  return false
}

/** {@link OutboxJournal} over a {@link DurableKv}. */
export class KvOutbox implements OutboxJournal {
  /** @param table The KV table (`'outbox'`, or `'outbox:<scope>'` for a scoped view). */
  constructor(private readonly kv: DurableKv, private readonly table: DurableTable = 'outbox') {}

  private mutate<T>(key: string, fn: (r: OutboxRecord | undefined) => Outcome<OutboxRecord>): Promise<T> {
    return mutate<OutboxRecord, T>(this.kv, this.table, key, outboxIndex, fn)
  }

  put(input: OutboxPut, now: number, lease?: LeaseOptions): Promise<{ status: 'created' | 'exists'; record: OutboxRecord }> {
    const fresh: OutboxRecord = {
      key: input.key,
      chatId: input.chatId,
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      op: 'send',
      content: input.content,
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
      state: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      fencingToken: 0,
      createdAt: input.createdAt,
    }
    const record: OutboxRecord = lease ? { ...leased(fresh, lease), state: 'sending' } : fresh
    return this.mutate(input.key, (current) => current
      ? { result: { status: 'exists', record: current } }
      : { write: record, result: { status: 'created', record } })
  }

  begin(key: string, o: LeaseOptions): Promise<OutboxRecord | null> {
    return this.mutate(key, (r) => {
      if (!r || (r.state !== 'pending' && r.state !== 'failed')) return { result: null }
      return { write: { ...leased(r, o), state: 'sending' } }
    })
  }

  private complete(key: string, token: number, next: (r: OutboxRecord) => OutboxRecord): Promise<void> {
    return this.mutate(key, (r) => {
      if (!r || r.state !== 'sending' || r.fencingToken !== token) throw stale(key, token, r)
      return { write: next(r), result: undefined }
    })
  }

  markSent(key: string, token: number, result: { ref: MessageRef }, now: number): Promise<void> {
    return this.complete(key, token, (r) => ({ ...clearLease(r), state: 'sent', result: { ref: { ...result.ref } }, sentAt: now, completedAt: now, lastError: undefined }))
  }

  extend(key: string, token: number, leaseUntil: number): Promise<void> {
    return this.complete(key, token, (r) => ({ ...r, leaseUntil }))
  }

  markFailed(key: string, token: number, error: OutboxError, o: { now: number; retryAt?: number; dead?: boolean }): Promise<void> {
    return this.complete(key, token, (r) => o.dead
      ? { ...clearLease(r), state: 'dead', lastError: error, completedAt: o.now }
      : { ...clearLease(r), state: 'failed', lastError: error, nextAttemptAt: o.retryAt ?? o.now })
  }

  async claimDue(o: ClaimOptions): Promise<ClaimedSend[]> {
    const reclaimOwn = o.reclaimOwn === true
    const max = reclaimOwn ? Number.POSITIVE_INFINITY : o.now
    const ids = await this.kv.range(this.table, 'due', max, reclaimOwn ? SCAN_LIMIT : Math.max(o.limit * 4, 64))
    const candidates: OutboxRecord[] = []
    for (const id of ids) {
      const entry = await this.kv.get(this.table, id)
      if (!entry) continue
      const r = JSON.parse(entry.value) as OutboxRecord
      if (!outboxClaimable(r, o.now, o.owner, reclaimOwn)) continue
      if (o.partitions && !o.partitions(r.chatId)) continue
      candidates.push(r)
    }
    candidates.sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const claimed: ClaimedSend[] = []
    for (const c of candidates) {
      if (claimed.length >= o.limit) break
      const got = await this.mutate<ClaimedSend | null>(c.key, (r) => {
        if (!r || !outboxClaimable(r, o.now, o.owner, reclaimOwn)) return { result: null }
        const record: OutboxRecord = { ...leased(r, o), state: 'sending' }
        return { write: record, result: { record, ambiguous: r.state === 'sending' } }
      })
      if (got) claimed.push(got)
    }
    return claimed
  }

  resolveAmbiguous(key: string, token: number, to: 'unknown' | 'pending', now: number): Promise<void> {
    return this.complete(key, token, (r) => to === 'unknown'
      ? { ...clearLease(r), state: 'unknown', completedAt: now }
      : { ...clearLease(r), state: 'pending', nextAttemptAt: now })
  }

  async get(key: string): Promise<OutboxRecord | undefined> {
    const entry = await this.kv.get(this.table, key)
    return entry ? (JSON.parse(entry.value) as OutboxRecord) : undefined
  }

  async list(filter: { state?: OutboxState; chatId?: string; limit?: number } = {}): Promise<OutboxRecord[]> {
    const all = (await readAll<OutboxRecord>(this.kv, this.table))
      .filter((r) => (!filter.state || r.state === filter.state) && (filter.chatId === undefined || r.chatId === filter.chatId))
    all.sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1))
    return filter.limit !== undefined ? all.slice(0, filter.limit) : all
  }

  retry(key: string, now: number): Promise<void> {
    return this.mutate(key, (r) => r && (r.state === 'failed' || r.state === 'dead' || r.state === 'unknown')
      ? { write: { ...clearLease(r), state: 'pending', nextAttemptAt: now, completedAt: undefined }, result: undefined }
      : { result: undefined })
  }

  async discard(key: string): Promise<void> {
    for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
      const entry = await this.kv.get(this.table, key)
      if (!entry || await this.kv.remove(this.table, key, entry.version)) return
    }
  }

  async purge(o: { before: number }): Promise<number> {
    let n = 0
    for (const key of await this.kv.range(this.table, 'done', o.before, SCAN_LIMIT)) {
      const entry = await this.kv.get(this.table, key)
      if (!entry) continue
      const r = JSON.parse(entry.value) as OutboxRecord
      if ((r.state !== 'sent' && r.state !== 'dead' && r.state !== 'unknown') || (r.completedAt ?? 0) >= o.before) continue
      if (await this.kv.remove(this.table, key, entry.version)) n++
    }
    return n
  }
}

/** Options of {@link KvDurability}. */
export interface KvDurabilityOptions {
  /** Only one process uses this storage at a time (see `DurabilityBackend.exclusive`). */
  exclusive?: boolean
  /** Store the journals in the tables of this scope (see `DurabilityBackend.scope`). */
  scope?: string
}

/**
 * A {@link DurabilityBackend} over any {@link DurableKv}. Store packages build their
 * backends this way (`new KvDurability(new PostgresDurableKv(pool))`).
 */
export class KvDurability implements DurabilityBackend {
  readonly inbox: InboxJournal
  readonly outbox: OutboxJournal
  readonly exclusive: boolean
  /** The scope of this view (`undefined` = the unscoped tables). */
  readonly scopeName: string | undefined
  constructor(readonly kv: DurableKv, options: KvDurabilityOptions = {}) {
    this.exclusive = options.exclusive === true
    this.scopeName = options.scope
    const suffix = options.scope === undefined ? '' : `:${options.scope}`
    this.inbox = new KvInbox(kv, `inbox${suffix}`)
    this.outbox = new KvOutbox(kv, `outbox${suffix}`)
  }

  /** A view over the same KV holding only the records of `name` (tables `inbox:<name>` / `outbox:<name>`). */
  scope(name: string): KvDurability {
    if (typeof name !== 'string' || name === '') throw new TypeError('KvDurability.scope(): name must be a non-empty string')
    const scope = this.scopeName === undefined ? name : `${this.scopeName}:${name}`
    return new KvDurability(this.kv, { exclusive: this.exclusive, scope })
  }
  async start(): Promise<void> { await this.kv.start?.() }
  async stop(): Promise<void> { await this.kv.stop?.() }
}
