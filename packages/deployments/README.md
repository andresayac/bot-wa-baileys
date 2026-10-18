# @bot-wa/deployments

> [!WARNING]
> **Prototipo en memoria · privado (`"private": true`, no se publica en npm).**
> El estado vive en RAM y se pierde al reiniciar; no hay persistencia, despliegue real ni rollout gradual, y la API puede cambiar sin aviso. Sirve para fijar el contrato antes de la implementación durable.
>
> Roadmap: track [D. BotWA Studio](../../ROADMAP.md#d-botwa-studio) («Drafts, diff, publish y rollback») y [C. Control plane y API](../../ROADMAP.md#c-control-plane-y-api), fase [F3 — Studio MVP](../../ROADMAP.md#f3--studio-mvp) («Publish y rollback»).

Versiones inmutables por tenant y bot, con una única versión activa.

```ts
import { DeploymentRegistry } from '@bot-wa/deployments'

const registry = new DeploymentRegistry()
registry.publish('acme', 'support', '1.1.0', 'sha256:...')
registry.publish('acme', 'support', '1.2.0', 'sha256:...')
registry.rollback('acme', 'support', '1.1.0')
```

El artefacto es una referencia opaca; el despliegue real y el rollout gradual pertenecen al adaptador de infraestructura.

## Publish gate (golden transcripts)

`publish(..., { gate })` ejecuta una comprobación **antes** de activar la versión. Si la gate pasa, la versión se guarda y se activa (con `deployment.gate = { passed: true, checkedAt, summary }`); si falla o lanza, `publish` rechaza con `DeploymentGateError` y no se guarda nada, así que la misma versión se puede corregir y volver a publicar. Con `gate`, `publish` devuelve una `Promise`; mientras la gate corre, la versión queda reservada (un publish duplicado falla con `already exists`).

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
