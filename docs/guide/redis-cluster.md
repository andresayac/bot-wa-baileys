# Redis Cluster

`@bot-wa/redis-store` runs on a **Redis Cluster** through an opt-in **key layout**.
A bot that does not opt in keeps the exact key names, scripts and commands it
used before.

## Why a separate layout

A Redis Cluster splits the keyspace into 16384 hash slots spread over several
masters. Two rules break the historical (`'legacy'`) key layout:

- a script, a `MULTI` or a multi-key command must only touch keys of **one
  slot**, or the server answers `CROSSSLOT`;
- `KEYS` and `SCAN` only see **one node**, so a listing built on them is
  silently incomplete.

The `'cluster'` layout fixes both. Every group of keys that one script touches
shares a **hash tag** (`{…}`), and listings read **index sorted sets** that live
in the same slot as their records, so they are exact even while slots move.

## Setup

Pass a node-redis cluster client, or let the component create one:

```ts
import { createCluster } from 'redis'
import { Bot } from '@bot-wa/core'
import { RedisStore, RedisDurability } from '@bot-wa/redis-store'

const cluster = createCluster({ rootNodes: [{ url: 'redis://redis-0:6379' }], useReplicas: false })
cluster.on('error', (err) => logger.error({ err }, 'redis cluster'))
await cluster.connect()

const store = new RedisStore({ client: cluster, prefix: 'mybot' })   // layout 'cluster' is picked automatically
const bot = new Bot({
  provider,
  store,
  coordination: { coordinator: store.coordinator() },              // same client, same layout
  scheduler: { store: store.schedules(), lease: store.leases() },
  durability: { journal: new RedisDurability({ client: cluster, prefix: 'mybot' }), instanceId: process.env.HOSTNAME },
})
```

Or with an own client, created and closed by the store:

```ts
const store = new RedisStore({
  cluster: {
    rootNodes: ['redis://redis-0:6379', 'redis://redis-1:6379'],
    // When the cluster announces addresses your process cannot reach (Docker, NAT):
    nodeAddressMap: (address) => ({ host: 'localhost', port: Number(address.split(':').pop()) }),
    defaults: { password: process.env.REDIS_PASSWORD },
  },
  prefix: 'mybot',
})
```

`RedisCoordinator` and `RedisDurability` accept the same `cluster` option.
`cluster` cannot be combined with `url` or `client`.

| Option | Where | Default |
| --- | --- | --- |
| `layout: 'legacy' \| 'cluster'` | `RedisStore`, `RedisCoordinator`, `RedisScheduleStore`, `RedisLeaseProvider` | `'cluster'` with a cluster client or `cluster` options, else `'legacy'` |
| `cluster: { rootNodes, nodeAddressMap?, defaults?, maxCommandRedirections? }` | `RedisStore`, `RedisCoordinator`, `RedisDurability` | none |
| `allowLegacyData: true` | `RedisStore` | `false` |

Rules:

- `layout: 'legacy'` with a cluster client throws a `RangeError`.
- In the cluster layout the prefix cannot contain `{` or `}` (it would break the
  hash tags).
- `layout: 'cluster'` also works on a **single node**. That is how an existing
  keyspace is migrated in place, and how you can test the layout locally.
- `store.coordinator()`, `store.schedules()` and `store.leases()` inherit the
  store's layout. Use the same layout and prefix on every replica.

## Key layout

`p` is the prefix; variable segments are percent-encoded (no `:`, `{`, `}` or
glob character survives), so a chat id can never break a hash tag.

| Data | Keys | One slot per |
| --- | --- | --- |
| Messages | `p:{m:<chat>}:z` (log) and `p:{m:<chat>}:i:<member>` | chat |
| Chats, contacts, checkpoints, schedules | `p:{ch:<b>}:r:<id>` and the index `p:{ch:<b>}:idx` (`ct`, `cp`, `sc`) | bucket `b` (32 per kind) |
| User data (`ctx.user`) | `p:{ud:<user>}:e:<ns>:<key>` and `p:{ud:<user>}:idx` | user |
| Locks | `p:{lk:<key>}:l` and the fence `p:{lk:<key>}:f` | lock |
| Coordinator turns | `p:co:{t:<chat key>}:seq\|tix\|serving\|owner\|last` | chat |
| Leaderships | `p:co:{ld:<name>}` and `…:term` | name |
| Unchanged | `p:conv:*`, `p:cursor:*`, `p:lease:*`, `p:co:rep:*`, `p:{durable:<table>}:*` | (one key, or already tagged) |
| Layout marker | `p:{meta}:layout` = `cluster:v1` | |

The bucket of a record is FNV-1a of its id modulo 32 (part of the `cluster:v1`
contract). Bucket tags carry no prefix, so the bots that share a cluster spread
each kind over the same 32 slots. That is about 10 per master on a 3-master
cluster, and keeps listings to 32 commands.

### What changes inside

- Every script declares all its keys (the store checks they share a slot before
  the call). The cluster layout uses scripts instead of `MULTI`.
- `deleteChat` drops the messages in chunks of 1000, each chunk atomic: an item
  only goes together with its log entry. The chat record goes last. A message
  saved during the delete survives intact. It is no longer one single script,
  because the log and the record live in different slots.
- Checkpoint and user-data indexes carry the server-side expiry as their score
  and are pruned on read, so expired entries disappear from listings like
  expired keys.
- A coordinator waiting for its turn cannot read another replica's heartbeat
  from its script (another slot). The turn script reports the earlier holder,
  and the coordinator probes that holder's heartbeat with a separate one-key
  call before skipping its ticket. Mutual exclusion still rests on the atomic
  owner-key check in the chat's slot.
- `TRYAGAIN` and `CLUSTERDOWN` replies, and a `MOVED`/`ASK` redirect node-redis
  did not follow, are retried with backoff (10 attempts, about 2.5 s; tune with
  `withClusterRetry(client, { attempts, baseMs })` and pass the wrapped client).
  These replies come before anything runs. A lost reply is never retried.

### node-redis 4 notes

The package works around two node-redis 4.x cluster quirks:

- `cluster.eval(script, { keys })` is routed by the wrong argument, so it can
  land on a random master and never follow `MOVED`. The components send `EVAL`
  routed by its first key.
- After a topology change a `MULTI` can fail with `EXECABORT` without node-redis
  re-reading the topology. The cluster layout does not use `MULTI`.

## Migrating an existing keyspace

There is no dual reading of both layouts: it would break the atomicity of the
compare-and-set writes, fences and indexes. Migrate offline instead.

1. **Stop every bot of the prefix.** The helper refuses while a coordinator
   heartbeat or a pending chat ticket exists, unless `allowLive: true`.
2. Copy the keyspace:

   ```ts
   import { createClient } from 'redis'
   import { migrateToClusterLayout, inspectKeyspace } from '@bot-wa/redis-store'

   const source = createClient({ url: 'redis://old:6379' })
   await source.connect()
   console.log(await inspectKeyspace({ client: source, prefix: 'mybot' }))   // counts per layout
   const report = await migrateToClusterLayout({ source, prefix: 'mybot', dryRun: true })
   await migrateToClusterLayout({ source, prefix: 'mybot' })                 // in place, or:
   await migrateToClusterLayout({ source, target: cluster, prefix: 'mybot' }) // straight into a cluster
   ```

3. Start the bots with the cluster layout (`layout: 'cluster'` on the single
   node, or a cluster client). After an in-place migration you can move the data
   into the cluster with your usual tools.
4. Once verified, delete the source keys with
   `migrateToClusterLayout({ source, prefix, deleteSource: true })`.

What the helper does:

- **Messages** are read from each chat's log (never by parsing item keys). Items
  that do not belong to their chat are skipped, and items no log references are
  reported in `report.orphans`.
- **Checkpoints and user data** keep their remaining TTL.
- **Lock fences and leadership terms** are raised with "set if greater", so
  fences never go backwards. Turn counters are short-lived and are not copied.
- **Schedules**, including deleted markers, keep their fencing tokens.
- Conversations, cursors, leases and the durability journal keep their names.
  They are copied only into another server or prefix.
- **Idempotent and resumable**: an existing target key wins unless
  `overwrite: true`. The layout marker is written last.
- **Rollback**: `direction: 'cluster-to-legacy'` (single-node target). Writes
  made after the forward migration exist only in the cluster layout; the
  reverse pass copies them back.

Starting a cluster-layout store on a single node that still holds legacy keys
under its prefix throws ("run migrateToClusterLayout() first"). This check scans
at most 10,000 keys. Pass `allowLegacyData: true` to start anyway.

## Limits

- **Asynchronous replication.** As with Sentinel, a failover can lose the last
  acknowledged writes: a lease granted twice, a compare-and-set update lost, a
  fence or term handed out again. This is not Redlock. Set
  `min-replicas-to-write 1` and rely on the durable outbox's idempotency for
  sends.
- Each durability table sits in one slot (`{durable:<table>}`), as before.
- Slot moves: listings stay exact. Multi-key writes on a slot being moved get
  `TRYAGAIN` and are retried until the move finishes.
- Read from masters only (`useReplicas: false`): compare-and-set loops and
  checkpoints must see their own writes.

## Testing locally

```bash
docker run -d --name botwa-it-redis-cluster -e IP=0.0.0.0 -e INITIAL_PORT=47100 \
  -e MASTERS=3 -e SLAVES_PER_MASTER=1 -p 127.0.0.1:47100-47105:47100-47105 grokzen/redis-cluster:7.0.10
BOTWA_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:47100 pnpm --filter @bot-wa/redis-store test
# optional: failover and slot migration under load
BOTWA_TEST_REDIS_CLUSTER_CHAOS=1 BOTWA_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:47100 pnpm --filter @bot-wa/redis-store test
docker rm -f botwa-it-redis-cluster
```

See also [Running N replicas](./replicas.md) and [Durable message processing](./durability.md).
