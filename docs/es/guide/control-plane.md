# Control plane

`@bot-wa/manager` conserva el API compacto con `createManagerApi`, pero los despliegues nuevos deben usar `createControlPlaneApi`. Este API vive bajo `/v1` y nunca tiene modo anónimo.

Cada respuesta incluye `x-request-id`. Las rutas iniciales son `GET /v1/health`, `GET /v1/bots`, `POST /v1/bots/:id/start`, `POST /v1/bots/:id/stop` y `GET /v1/audit`.

Usa `X-API-Key` o `Authorization: Bearer <key>`. Las mutaciones requieren `bots:operate`; envía `Idempotency-Key` para reintentar lifecycle sin duplicar la operación.

`SecretVault` cifra valores con AES-256-GCM y solo expone referencias/versiones. `AuditLog` redacta tokens, secretos, contraseñas y API keys.

`MemoryDesiredStateStore` y `BotReconciler` separan el estado deseado del observado y usan versiones CAS. Sustituye el store en memoria por una implementación de base de datos antes de ejecutar varias réplicas.
