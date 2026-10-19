/**
 * Redis durability backend for `BotConfig.durability` (durable inbox/outbox).
 *
 * Each journal record is a string key holding `<version>\n<json>`; every write is one
 * Lua script that compares the stored string, writes the new one and updates the
 * record's `due`/`done` sorted-set entries atomically. Core's journal logic computes
 * each transition, so claims are exclusive across replicas and a stale lease holder's
 * completion is rejected by its fencing token. All keys of a journal share one hash tag
 * (`{durable:<table>}`), so the script is Redis Cluster safe.
 *
 * @example
 * ```ts
 * import { createClient } from 'redis'
 * const client = createClient({ url: process.env.REDIS_URL })
 * await client.connect()
 * const bot = new Bot({
 *   provider,
 *   store: new RedisStore({ client, prefix: 'mybot' }),
 *   durability: { journal: new RedisDurability({ client, prefix: 'mybot' }), instanceId: process.env.HOSTNAME },
 * })
 * ```
 */

import { createClient } from 'redis'
import { KvDurability, type DurableKv, type DurableKvEntry, type DurableKvIndex, type DurableTable } from '@bot-wa/core'
import type { NativeRedisClient, RedisLikeClient } from './RedisStore.js'
import { DURABLE_WRITE_SCRIPT } from './durabilityScripts.js'

export interface RedisDurabilityOptions {
  /** An existing client (e.g. the one given to `RedisStore`). The backend never closes it. */
  client?: RedisLikeClient | NativeRedisClient
  /** Used to create (and own) a client when `client` is not given. Default `redis://localhost:6379`. */
  url?: string
  /** Key prefix. Default `'botwa'` (same default as `RedisStore`; the keys never collide). */
  prefix?: string
}

function score(value: number | null): string {
  if (value === null) return ''
  if (value === Number.POSITIVE_INFINITY) return '+inf'
  if (value === Number.NEGATIVE_INFINITY) return '-inf'
  return String(value)
}

/** {@link DurableKv} over Redis strings + sorted sets. */
export class RedisDurableKv implements DurableKv {
  private readonly client: RedisLikeClient
  private readonly owned: boolean
  readonly prefix: string

  constructor(opts: RedisDurabilityOptions = {}) {
    this.prefix = opts.prefix ?? 'botwa'
    this.owned = !opts.client
    this.client = (opts.client ?? createClient({ url: opts.url ?? 'redis://localhost:6379' })) as RedisLikeClient
  }

  private base(tbl: DurableTable): string { return `${this.prefix}:{durable:${tbl}}` }
  private docKey(tbl: DurableTable, id: string): string { return `${this.base(tbl)}:doc:${id}` }
  private indexKey(tbl: DurableTable, index: keyof DurableKvIndex): string { return `${this.base(tbl)}:${index}` }

  async start(): Promise<void> {
    if (this.owned && this.client.isOpen !== true) await this.client.connect()
  }

  async stop(): Promise<void> {
    if (this.owned && this.client.isOpen === true) await this.client.quit()
  }

  async get(tbl: DurableTable, id: string): Promise<DurableKvEntry | undefined> {
    const raw = await this.client.get(this.docKey(tbl, id))
    if (raw === null) return undefined
    return { value: raw.slice(raw.indexOf('\n') + 1), version: raw }
  }

  private async write(mode: 'insert' | 'replace' | 'remove', tbl: DurableTable, id: string, expected: string, next: string, index: DurableKvIndex): Promise<boolean> {
    const ok = await this.client.eval(DURABLE_WRITE_SCRIPT, {
      keys: [this.docKey(tbl, id), this.indexKey(tbl, 'due'), this.indexKey(tbl, 'done')],
      arguments: [mode, expected, next, id, score(index.due), score(index.done)],
    })
    return Number(ok) === 1
  }

  async insert(tbl: DurableTable, id: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    const raw = `1\n${value}`
    return (await this.write('insert', tbl, id, '', raw, index)) ? raw : undefined
  }

  async replace(tbl: DurableTable, id: string, version: string, value: string, index: DurableKvIndex): Promise<string | undefined> {
    const v = Number.parseInt(version.slice(0, version.indexOf('\n')), 10) || 0
    const raw = `${v + 1}\n${value}`
    return (await this.write('replace', tbl, id, version, raw, index)) ? raw : undefined
  }

  async remove(tbl: DurableTable, id: string, version: string): Promise<boolean> {
    return this.write('remove', tbl, id, version, '', { due: null, done: null })
  }

  async range(tbl: DurableTable, index: keyof DurableKvIndex, max: number, limit: number): Promise<string[]> {
    const count = Math.max(0, Math.floor(limit))
    if (count === 0) return []
    return this.client.zRange(this.indexKey(tbl, index), '-inf', score(max), { BY: 'SCORE', LIMIT: { offset: 0, count } })
  }
}

/** Redis {@link DurabilityBackend} (see the module docs). */
export class RedisDurability extends KvDurability {
  constructor(opts: RedisDurabilityOptions = {}) { super(new RedisDurableKv(opts)) }
}
