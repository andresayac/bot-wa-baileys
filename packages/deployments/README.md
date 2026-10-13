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
