# Control plane

::: warning Experimental — aún no publicado en npm
`@bot-wa/manager` es **experimental**: una implementación real y con tests,
pero todavía privada (no está en npm ni forma parte de la primera alpha) y su
API puede cambiar. Úsalo desde el monorepo (`workspace:*`).
:::

`@bot-wa/manager` tiene dos superficies HTTP. `createManagerApi` conserva el API compacto heredado. Los despliegues nuevos deben usar `createControlPlaneApi`, que vive bajo `/v1` y nunca tiene modo anónimo.

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

## API y seguridad

Cada respuesta incluye `x-request-id`. Las rutas iniciales son `GET /v1/health`, `GET /v1/bots`, `POST /v1/bots/:id/start`, `POST /v1/bots/:id/stop` y `GET /v1/audit`.

Usa `X-API-Key` o `Authorization: Bearer <key>`. Las mutaciones requieren el scope `bots:operate`. Envía `Idempotency-Key` en las peticiones de ciclo de vida para reintentarlas sin duplicar la operación tras un fallo de red.

`SecretVault` cifra valores con AES-256-GCM y en las vistas administrativas solo expone referencias y versiones. `AuditLog` redacta campos como tokens, secretos, contraseñas y API keys.

## Estado deseado

`MemoryDesiredStateStore` y `BotReconciler` separan el estado deseado (`running`/`stopped`) del observado. Usan versiones compare-and-set para que dos actualizaciones concurrentes no se pisen en silencio. Sustituye el store en memoria por un `DesiredStateStore` respaldado por base de datos antes de ejecutar más de un proceso.
