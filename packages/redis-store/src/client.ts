/**
 * Redis client helpers shared by the store, the coordinator and the durability backend:
 * Redis Cluster detection, creation of an own (single-node or cluster) client, and a
 * retry wrapper for the errors a cluster returns BEFORE running a command.
 */
import { createClient, createCluster } from 'redis'
import type { NativeRedisClient, RedisLikeClient, RedisMulti, RedisZRangeOptions } from './RedisStore.js'
import type { RedisKeyLayout } from './layout.js'

/** The native node-redis cluster client type produced by `createCluster`. */
export type NativeRedisClusterClient = ReturnType<typeof createCluster>

/** Any client the Redis components accept: a node-redis client or cluster, or a structural {@link RedisLikeClient}. */
export type AnyRedisClient = RedisLikeClient | NativeRedisClient | NativeRedisClusterClient

/** Options to let a component create (and own) a node-redis cluster client. */
export interface RedisClusterConnectOptions {
  /** Seed node URLs (`redis://host:port`), at least one; the client discovers the rest. */
  rootNodes: string[]
  /**
   * Map the addresses the cluster announces to the ones this process can reach (NAT,
   * Docker): an object keyed by `host:port`, or a function. Optional.
   */
  nodeAddressMap?: Record<string, { host: string; port: number }> | ((address: string) => { host: string; port: number } | undefined)
  /** Applied to every node connection (ACL credentials, TLS, connect timeout). */
  defaults?: {
    username?: string
    password?: string
    socket?: { tls?: boolean; connectTimeout?: number }
  }
  /** MOVED/ASK redirections followed per command (node-redis default 16). */
  maxCommandRedirections?: number
}

/**
 * True for a node-redis cluster client (v4 and v5 expose `masters` and `nodeClient`).
 * Such a client has no `KEYS`/`SCAN` over the whole keyspace and rejects multi-key
 * commands across hash slots, so it needs the `'cluster'` key layout.
 */
export function isRedisClusterClient(client: unknown): boolean {
  if (client === null || typeof client !== 'object') return false
  const c = client as { masters?: unknown; nodeClient?: unknown }
  return Array.isArray(c.masters) && typeof c.nodeClient === 'function'
}

/**
 * Pick the key layout of a component: the explicit `layout`, else `'cluster'` for a
 * cluster client or `cluster` connect options, else `'legacy'`. The legacy layout on a
 * cluster throws: its scripts touch keys of several hash slots.
 */
export function resolveLayout(who: string, opts: { layout?: RedisKeyLayout; client?: unknown; cluster?: RedisClusterConnectOptions; url?: string }): RedisKeyLayout {
  if (opts.cluster && opts.url !== undefined) throw new RangeError(`${who}: pass either url or cluster, not both`)
  if (opts.cluster && opts.client) throw new RangeError(`${who}: pass either client or cluster, not both`)
  if (opts.cluster && !(Array.isArray(opts.cluster.rootNodes) && opts.cluster.rootNodes.length > 0)) {
    throw new RangeError(`${who}: cluster.rootNodes needs at least one node URL`)
  }
  const onCluster = Boolean(opts.cluster) || isRedisClusterClient(opts.client)
  const layout = opts.layout ?? (onCluster ? 'cluster' : 'legacy')
  if (layout !== 'legacy' && layout !== 'cluster') throw new RangeError(`${who}: layout must be 'legacy' or 'cluster', got ${String(layout)}`)
  if (layout === 'legacy' && onCluster) {
    throw new RangeError(`${who}: the 'legacy' key layout is not Redis Cluster safe; use layout 'cluster' (and migrate existing data with migrateToClusterLayout())`)
  }
  return layout
}

export interface OwnClientOptions {
  url?: string
  cluster?: RedisClusterConnectOptions
  reconnectStrategy?: (retries: number, cause: Error) => number | Error
  onError?: (err: unknown) => void
}

/** Create a node-redis client (single node, or cluster when `cluster` is given) with an `'error'` listener. */
export function createOwnRedisClient(o: OwnClientOptions): NativeRedisClient | NativeRedisClusterClient {
  let client: NativeRedisClient | NativeRedisClusterClient
  if (o.cluster) {
    const { rootNodes, nodeAddressMap, defaults, maxCommandRedirections } = o.cluster
    client = createCluster({
      rootNodes: rootNodes.map((url) => ({ url })),
      defaults: {
        ...(defaults?.username !== undefined ? { username: defaults.username } : {}),
        ...(defaults?.password !== undefined ? { password: defaults.password } : {}),
        socket: {
          ...(defaults?.socket?.connectTimeout !== undefined ? { connectTimeout: defaults.socket.connectTimeout } : {}),
          ...(defaults?.socket?.tls ? { tls: true as const } : {}),
          ...(o.reconnectStrategy ? { reconnectStrategy: o.reconnectStrategy } : {}),
        },
      },
      // Reads go to masters: compare-and-set loops and checkpoints must see their own writes.
      useReplicas: false,
      ...(nodeAddressMap ? { nodeAddressMap } : {}),
      ...(maxCommandRedirections !== undefined ? { maxCommandRedirections } : {}),
    } as Parameters<typeof createCluster>[0])
  } else {
    client = createClient({
      url: o.url ?? 'redis://localhost:6379',
      ...(o.reconnectStrategy ? { socket: { reconnectStrategy: o.reconnectStrategy } } : {}),
    })
  }
  // node-redis re-throws an 'error' event nobody listens to (crashing the process).
  if (o.onError && typeof (client as { on?: unknown }).on === 'function') {
    (client as unknown as { on(event: 'error', l: (err: unknown) => void): void }).on('error', o.onError)
  }
  return client
}

/**
 * Errors returned before the command ran: safe to retry. TRYAGAIN (multi-key command on a
 * slot being migrated) and CLUSTERDOWN come from the server; a MOVED/ASK redirect or a
 * "Cannot find node" can escape node-redis 4 while a slot moves (its one-shot ASKING flag
 * is consumed by a concurrent command, or the topology is being re-read).
 */
function isRetryableClusterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /^(TRYAGAIN|CLUSTERDOWN|MOVED|ASK)\b/.test(message)
    || /^Cannot find node /.test(message)
    || (/EXECABORT/.test(message) && /TRYAGAIN|CLUSTERDOWN|MOVED|ASK/.test(message))
}

export interface ClusterRetryOptions {
  /** Total attempts per command (default 10: about 2.5 s of backoff, enough for a slot move). */
  attempts?: number
  /** First backoff in ms, doubled per attempt up to 500 ms (default 20). */
  baseMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wrap a client so commands rejected with `TRYAGAIN` (a multi-key command during a slot
 * migration), `CLUSTERDOWN`, or a redirect node-redis did not follow are retried with a backoff (default 10 attempts, 20 ms
 * doubling up to 500 ms). Only those errors are retried: the server replies them before
 * applying anything. A lost reply (timeout, dropped connection) is never retried, so no
 * command is applied twice by the wrapper. A node-redis cluster client is also adapted (see
 * {@link asRedisLike}). The components wrap a cluster client themselves; pass an already
 * wrapped client to use other limits.
 */
export function withClusterRetry(client: AnyRedisClient, opts: ClusterRetryOptions = {}): RedisLikeClient {
  if (client instanceof ClusterRetryClient) return client // already wrapped (a store shares its client)
  const base = client instanceof ClusterClientAdapter || !isRedisClusterClient(client)
    ? (client as RedisLikeClient)
    : new ClusterClientAdapter(client as unknown as ClusterSurface)
  return new ClusterRetryClient(base, Math.max(1, opts.attempts ?? 10), Math.max(1, opts.baseMs ?? 20))
}

/**
 * Narrow any accepted client to the {@link RedisLikeClient} surface. A node-redis cluster
 * client is wrapped in {@link ClusterClientAdapter}: node-redis 4.x routes
 * `cluster.eval(script, { keys })` by the wrong argument (the script text instead of the
 * keys), so the EVAL lands on a random master and the MOVED reply is never followed. The
 * adapter sends EVAL with its first key for routing instead, and is wrapped by
 * {@link withClusterRetry}. Any other client is returned as is.
 */
export function asRedisLike(client: AnyRedisClient): RedisLikeClient {
  if (client instanceof ClusterClientAdapter || client instanceof ClusterRetryClient) return client
  if (!isRedisClusterClient(client)) return client as RedisLikeClient
  // A cluster client also gets the TRYAGAIN/CLUSTERDOWN retry (see withClusterRetry).
  return withClusterRetry(client)
}

/** The node-redis cluster members the adapter uses (structural, so fakes can provide them). */
interface ClusterSurface extends Omit<RedisLikeClient, 'eval' | 'keys' | 'scanIterator'> {
  masters: unknown[]
  nodeClient(node: unknown): unknown
  sendCommand(firstKey: string | undefined, isReadonly: boolean | undefined, args: string[]): Promise<unknown>
}

/** Delegates to a node-redis cluster client (bound calls: it keeps `#private` state) and routes EVAL by its first key. */
class ClusterClientAdapter implements RedisLikeClient {
  constructor(private readonly c: ClusterSurface) {}

  /** Cluster shape, kept so the adapter is still recognised as a cluster client. */
  get masters(): unknown[] { return this.c.masters }
  nodeClient(node: unknown): unknown { return this.c.nodeClient(node) }

  get isOpen(): boolean | undefined { return this.c.isOpen }
  get isReady(): boolean | undefined { return this.c.isReady }

  get(key: string) { return this.c.get(key) }
  set(key: string, value: string, options?: { NX?: true; XX?: true; EX?: number; PX?: number }) { return this.c.set(key, value, options) }
  del(key: string | string[]) { return this.c.del(key) }
  async keys(): Promise<string[]> {
    throw new Error('redis-store: KEYS is not available on a Redis Cluster client (use the cluster key layout)')
  }
  zAdd(key: string, members: { score: number; value: string } | Array<{ score: number; value: string }>, options?: { NX?: true; XX?: true }) {
    return this.c.zAdd(key, members, options)
  }
  zRange(key: string, min: number | string, max: number | string, options?: RedisZRangeOptions) { return this.c.zRange(key, min, max, options) }
  zRangeWithScores(key: string, min: number | string, max: number | string, options?: RedisZRangeOptions) {
    return this.c.zRangeWithScores(key, min, max, options)
  }
  zRem(key: string, member: string | string[]) { return this.c.zRem(key, member) }
  zCard(key: string) { return this.c.zCard(key) }
  eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    const keys = options?.keys ?? []
    const args = options?.arguments ?? []
    return this.c.sendCommand(keys[0], false, ['EVAL', script, String(keys.length), ...keys, ...args])
  }
  multi(): RedisMulti { return this.c.multi() }
  connect() { return this.c.connect() }
  quit() { return this.c.quit() }
  disconnect(): Promise<unknown> { return this.c.disconnect ? this.c.disconnect() : this.c.quit() }
}

type MultiOp = (tx: RedisMulti) => void

class ClusterRetryClient implements RedisLikeClient {
  scanIterator?: RedisLikeClient['scanIterator']

  constructor(private readonly base: RedisLikeClient, private readonly attempts: number, private readonly baseMs: number) {
    if (typeof base.scanIterator === 'function') this.scanIterator = (o) => base.scanIterator!(o)
  }

  /** Cluster shape of the wrapped client (so a pre-wrapped cluster client is still detected). */
  get masters(): unknown[] | undefined { return (this.base as { masters?: unknown[] }).masters }
  get nodeClient(): ((node: unknown) => unknown) | undefined {
    const b = this.base as { nodeClient?: (node: unknown) => unknown }
    return typeof b.nodeClient === 'function' ? (node: unknown) => b.nodeClient!(node) : undefined
  }

  private async retry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run()
      } catch (err) {
        if (attempt >= this.attempts || !isRetryableClusterError(err)) throw err
        await sleep(Math.min(500, this.baseMs * 2 ** (attempt - 1)))
      }
    }
  }

  get isOpen(): boolean | undefined { return this.base.isOpen }
  get isReady(): boolean | undefined { return this.base.isReady }

  get(key: string) { return this.retry(() => this.base.get(key)) }
  set(key: string, value: string, options?: { NX?: true; XX?: true; EX?: number; PX?: number }) {
    return this.retry(() => this.base.set(key, value, options))
  }
  del(key: string | string[]) { return this.retry(() => this.base.del(key)) }
  keys(pattern: string) { return this.retry(() => this.base.keys(pattern)) }
  zAdd(key: string, members: { score: number; value: string } | Array<{ score: number; value: string }>, options?: { NX?: true; XX?: true }) {
    return this.retry(() => this.base.zAdd(key, members, options))
  }
  zRange(key: string, min: number | string, max: number | string, options?: RedisZRangeOptions) {
    return this.retry(() => this.base.zRange(key, min, max, options))
  }
  zRangeWithScores(key: string, min: number | string, max: number | string, options?: RedisZRangeOptions) {
    return this.retry(() => this.base.zRangeWithScores(key, min, max, options))
  }
  zRem(key: string, member: string | string[]) { return this.retry(() => this.base.zRem(key, member)) }
  zCard(key: string) { return this.retry(() => this.base.zCard(key)) }
  eval(script: string, options?: { keys?: string[]; arguments?: string[] }) {
    return this.retry(() => this.base.eval(script, options))
  }
  /** Records the queued commands so a retried EXEC replays them on a fresh MULTI. */
  multi(): RedisMulti {
    const ops: MultiOp[] = []
    const tx: RedisMulti = {
      set: (key, value, options) => { ops.push((m) => m.set(key, value, options)); return tx },
      del: (key) => { ops.push((m) => m.del(key)); return tx },
      zAdd: (key, members, options) => { ops.push((m) => m.zAdd(key, members, options)); return tx },
      zRem: (key, member) => { ops.push((m) => m.zRem(key, member)); return tx },
      exec: () => this.retry(() => {
        const m = this.base.multi()
        for (const op of ops) op(m)
        return m.exec()
      }),
    }
    return tx
  }
  connect() { return this.base.connect() }
  quit() { return this.base.quit() }
  disconnect(): Promise<unknown> {
    return this.base.disconnect ? this.base.disconnect() : this.base.quit()
  }
}
