# @botmesh/deployments

> Experimental · private (`"private": true`, not published to npm). The API may change without notice.
>
> Roadmap: track [D. BotWA Studio](../../ROADMAP.md#d-botwa-studio) ("Drafts, diff, publish and rollback") and [C. Control plane and API](../../ROADMAP.md#c-control-plane-y-api), phase [F3 — Studio MVP](../../ROADMAP.md#f3--studio-mvp) ("Publish and rollback").

Immutable versions per tenant and bot, with a single active version, publish gates whose runs are recorded and rollback. Persists over any core `DurableKv` (SQLite, PostgreSQL, Redis, file) or in memory.

```ts
import { DeploymentRegistry } from '@botmesh/deployments'

const registry = new DeploymentRegistry() // in memory; see "Persistence"
await registry.publish('acme', 'support', '1.1.0', 'sha256:...')
await registry.publish('acme', 'support', '1.2.0', 'sha256:...')
await registry.rollback('acme', 'support', '1.1.0')
```

The artifact is an opaque reference; the actual deployment and gradual rollout belong to the infrastructure adapter. `publish` rejects with `DeploymentExistsError` a version that already exists (or that a running gate has reserved) and `rollback` with `DeploymentNotFoundError`.

## Persistence

`DeploymentRegistry` takes a `DeploymentStore`. `MemoryDeploymentStore` (the default) lives in RAM; `KvDeploymentStore` stores everything in a core `DurableKv` through `@botmesh/tenant-kv`, so it works on any durability backend:

```ts
import { KvDeploymentStore } from '@botmesh/deployments'
import { SQLiteStore } from '@botmesh/sqlite-store'
import { PostgresDurableKv } from '@botmesh/postgres-store'
import { RedisDurableKv } from '@botmesh/redis-store'

const sqlite = new SQLiteStore({ file: './data/bot.db' })
new DeploymentRegistry(new KvDeploymentStore(sqlite.durability().kv))

const pg = new PostgresDurableKv({ pool }); await pg.start()
new DeploymentRegistry(new KvDeploymentStore(pg))

const redis = new RedisDurableKv({ client, prefix: 'mybot' })   // single node or cluster
new DeploymentRegistry(new KvDeploymentStore(redis))
```

Whoever creates the kv starts and stops it (`start()`/`stop()`); it can be the same one backing `BotConfig.durability` (the `product/deployments/*` tables never clash with the journal). Tables: one document per bot (`activeVersion`, publish order, reservations), one immutable document per version and a gate-run table per version. "Exactly one active version" is a property of the bot document, so publishing, reserving and rolling back are a single atomic compare-and-set on the backend; two concurrent publishes of the same version produce a single reservation.

## Publish gate (golden transcripts)

`publish(..., { gate })` runs a check **before** activating the version. If the gate passes, the version is stored and activated (with `deployment.gate = { passed: true, checkedAt, summary, runId }`); if it fails or throws, `publish` rejects with `DeploymentGateError` (with `runId`) and no version is stored, so the same version can be fixed and published again. While the gate runs, the version stays reserved (a duplicate publish fails with `already exists`); if the process dies, the reservation expires after `gateTimeoutMs` (10 min by default).

**Every gate run is persisted**, pass or fail: `registry.gateRuns(tenantId, botId, version)` returns the `GateRun`s (`ok`, `reason`, `summary`, `details` as JSON, `startedAt`/`finishedAt`). `details` (in `goldenTranscriptGate`, the per-transcript results with their diffs and the report) are stored as JSON; above `maxGateDetailsBytes` (256 KiB) they are trimmed and the run is marked `truncated: true` without changing the decision.

`goldenTranscriptGate` replays golden transcripts (see `recordTranscript` / `redactTranscript` / `replayTranscript` in `@botmesh/core/testing`) against the candidate bot and only lets the version through when all of them match:

```ts
import { readFileSync } from 'node:fs'
import { parseTranscript, REPLAY_MASKS } from '@botmesh/core/testing'
import { DeploymentGateError, DeploymentRegistry, goldenTranscriptGate } from '@botmesh/deployments'

const gate = goldenTranscriptGate({
  transcripts: [parseTranscript(readFileSync('golden/checkout.json', 'utf8'))],
  createBot: (candidate) => loadBotFactory(candidate.artifact), // (provider) => Bot, without starting it
  replay: { masks: [REPLAY_MASKS.isoDate] },
})

try {
  await registry.publish('acme', 'support', '1.4.0', 'sha256:...', { gate })
} catch (error) {
  if (error instanceof DeploymentGateError) console.error(error.message) // includes the expected vs. actual diff
}
```

A gate can be any `(candidate) => boolean | GateResult` function (sync or async). Without transcripts, or with a transcript that has no inbound turns or no expected replies (an empty pass), `goldenTranscriptGate` blocks the publish unless `allowEmpty: true`. To read a transcript from the store log, pass the bot (`transcriptFromStore(bot, chatId)`): the `Bot` stores it in a namespaced view of the store it receives.

## Limits

- There is no gradual rollout or physical deployment: the registry only decides which version is active.
- `list()` returns up to `limit` versions (1000 by default) in publish order; `gateRuns()` up to `limit` runs (100) from oldest to newest.
- The reservation of a running gate expires by time (`gateTimeoutMs`); a gate that takes longer stops protecting the version.
