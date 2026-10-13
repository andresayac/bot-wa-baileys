# Control plane

::: warning Experimental — not published yet
`@bot-wa/manager` is **experimental**: a real, tested implementation that is
still private (not on npm, not part of the first alpha) and whose API may
change. Use it from the monorepo (`workspace:*`).
:::

`@bot-wa/manager` has two HTTP surfaces. `createManagerApi` preserves the compact legacy API. New deployments should use `createControlPlaneApi`, which is versioned under `/v1` and never has an unauthenticated mode.

```ts
import { BotManager, createControlPlaneApi } from '@bot-wa/manager'
import { createServer } from 'node:http'

const manager = new BotManager()
createServer(createControlPlaneApi(manager, {
  tenantId: 'acme',
  apiKeys: [{
    id: 'operations', tenantId: 'acme', secret: process.env.MANAGER_KEY!,
    scopes: ['bots:read', 'bots:operate', 'audit:read'],
  }],
})).listen(3000)
```

## API and safety

Every response includes `x-request-id`. The initial routes are `GET /v1/health`, `GET /v1/bots`, `POST /v1/bots/:id/start`, `POST /v1/bots/:id/stop`, and `GET /v1/audit`.

Use `X-API-Key` or `Authorization: Bearer <key>`. Mutations require the `bots:operate` scope. Pass `Idempotency-Key` on lifecycle requests to safely retry after a network failure.

`SecretVault` encrypts values using AES-256-GCM and returns only references and versions from administrative views. `AuditLog` redacts fields such as token, secret, password and API key.

## Desired state

`MemoryDesiredStateStore` and `BotReconciler` separate desired state (`running`/`stopped`) from observed state. They use compare-and-set versions so competing updates cannot silently overwrite each other. Replace the memory store with a database-backed `DesiredStateStore` before running more than one process.
