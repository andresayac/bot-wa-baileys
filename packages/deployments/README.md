# @bot-wa/deployments

> Experimental · privado (`"private": true`, no se publica en npm). La API puede cambiar sin aviso.
>
> Roadmap: track [D. BotWA Studio](../../ROADMAP.md#d-botwa-studio) («Drafts, diff, publish y rollback») y [C. Control plane y API](../../ROADMAP.md#c-control-plane-y-api), fase [F3 — Studio MVP](../../ROADMAP.md#f3--studio-mvp) («Publish y rollback»).

Versiones inmutables por tenant y bot, con una única versión activa, publish gates cuyas ejecuciones quedan registradas y rollback. Persiste sobre cualquier `DurableKv` del core (SQLite, PostgreSQL, Redis, archivo) o en memoria.

```ts
import { DeploymentRegistry } from '@bot-wa/deployments'

const registry = new DeploymentRegistry() // en memoria; ver «Persistencia»
await registry.publish('acme', 'support', '1.1.0', 'sha256:...')
await registry.publish('acme', 'support', '1.2.0', 'sha256:...')
await registry.rollback('acme', 'support', '1.1.0')
```

El artefacto es una referencia opaca; el despliegue real y el rollout gradual pertenecen al adaptador de infraestructura. `publish` rechaza con `DeploymentExistsError` una versión que ya existe (o que un gate en curso tiene reservada) y `rollback` con `DeploymentNotFoundError`.

## Persistencia

`DeploymentRegistry` recibe un `DeploymentStore`. `MemoryDeploymentStore` (el de por defecto) vive en RAM; `KvDeploymentStore` guarda todo en un `DurableKv` del core a través de `@bot-wa/tenant-kv`, así que funciona en cualquier backend de durabilidad:

```ts
import { KvDeploymentStore } from '@bot-wa/deployments'
import { SQLiteStore } from '@bot-wa/sqlite-store'
import { PostgresDurableKv } from '@bot-wa/postgres-store'
import { RedisDurableKv } from '@bot-wa/redis-store'

const sqlite = new SQLiteStore({ file: './data/bot.db' })
new DeploymentRegistry(new KvDeploymentStore(sqlite.durability().kv))

const pg = new PostgresDurableKv({ pool }); await pg.start()
new DeploymentRegistry(new KvDeploymentStore(pg))

const redis = new RedisDurableKv({ client, prefix: 'mybot' })   // nodo único o cluster
new DeploymentRegistry(new KvDeploymentStore(redis))
```

Quien crea el kv es quien lo arranca y lo para (`start()`/`stop()`); puede ser el mismo que respalda `BotConfig.durability` (las tablas `product/deployments/*` nunca chocan con el journal). Tablas: un documento por bot (`activeVersion`, orden de publicación, reservas), un documento inmutable por versión y una tabla de ejecuciones de gate por versión. «Exactamente una versión activa» es una propiedad del documento del bot, así que publicar, reservar y hacer rollback son un solo compare-and-set atómico en el backend; dos publishes concurrentes de la misma versión producen una sola reserva.

## Publish gate (golden transcripts)

`publish(..., { gate })` ejecuta una comprobación **antes** de activar la versión. Si la gate pasa, la versión se guarda y se activa (con `deployment.gate = { passed: true, checkedAt, summary, runId }`); si falla o lanza, `publish` rechaza con `DeploymentGateError` (con `runId`) y no se guarda ninguna versión, así que la misma versión se puede corregir y volver a publicar. Mientras la gate corre, la versión queda reservada (un publish duplicado falla con `already exists`); si el proceso muere, la reserva caduca a los `gateTimeoutMs` (10 min por defecto).

**Toda ejecución de gate se persiste**, pase o falle: `registry.gateRuns(tenantId, botId, version)` devuelve los `GateRun` (`ok`, `reason`, `summary`, `details` en JSON, `startedAt`/`finishedAt`). Los `details` (en `goldenTranscriptGate`, los resultados por transcript con sus diffs y el informe) se guardan como JSON; por encima de `maxGateDetailsBytes` (256 KiB) se recortan y el run queda marcado `truncated: true` sin cambiar la decisión.

`goldenTranscriptGate` reproduce transcripts dorados (ver `recordTranscript` / `redactTranscript` / `replayTranscript` en `@bot-wa/core/testing`) contra el bot candidato y solo deja pasar la versión si todos coinciden:

```ts
import { readFileSync } from 'node:fs'
import { parseTranscript, REPLAY_MASKS } from '@bot-wa/core/testing'
import { DeploymentGateError, DeploymentRegistry, goldenTranscriptGate } from '@bot-wa/deployments'

const gate = goldenTranscriptGate({
  transcripts: [parseTranscript(readFileSync('golden/checkout.json', 'utf8'))],
  createBot: (candidate) => loadBotFactory(candidate.artifact), // (provider) => Bot, sin arrancar
  replay: { masks: [REPLAY_MASKS.isoDate] },
})

try {
  await registry.publish('acme', 'support', '1.4.0', 'sha256:...', { gate })
} catch (error) {
  if (error instanceof DeploymentGateError) console.error(error.message) // incluye el diff esperado vs. real
}
```

Una gate puede ser cualquier función `(candidate) => boolean | GateResult` (síncrona o async). Sin transcripts, o con un transcript sin turnos de entrada o sin respuestas esperadas (un pase vacío), `goldenTranscriptGate` bloquea el publish salvo `allowEmpty: true`. Para leer un transcript del log del store, pasa el bot (`transcriptFromStore(bot, chatId)`): el `Bot` guarda en una vista con namespace del store que recibe.

## Límites

- No hay rollout gradual ni despliegue físico: el registro solo decide qué versión está activa.
- `list()` devuelve hasta `limit` versiones (1000 por defecto) en orden de publicación; `gateRuns()` hasta `limit` ejecuciones (100) de la más antigua a la más reciente.
- La reserva de una gate en curso caduca por tiempo (`gateTimeoutMs`); un gate que tarde más que eso deja de proteger la versión.
