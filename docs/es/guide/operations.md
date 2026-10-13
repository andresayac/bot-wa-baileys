# Operación: eventos, inbox y entregas

::: warning Paquetes experimentales y prototipos — ninguno está publicado
`@bot-wa/events` es **experimental**: una implementación real y con tests,
pero todavía privada (no está en npm). `@bot-wa/inbox`, `@bot-wa/crm`,
`@bot-wa/hub`, `@bot-wa/campaigns` y `@bot-wa/deployments` son
**prototipos**: esqueletos mínimos en memoria para explorar el diseño. No
persisten nada, no escalan más allá de un proceso y no están pensados para
producción.
:::

Los paquetes operativos son agnósticos de canal y están aislados por tenant.

## Procesamiento de eventos

Usa `MemoryEventJournal` en tests. `FileEventJournal.open('./data/events.json')` persiste el journal de una sola instancia con snapshots atómicos, idempotencia, leases, reintentos y replay. Para múltiples réplicas implementa `EventJournal` sobre PostgreSQL, Redis o un broker.

`EventWorker` reclama eventos, invoca el handler, confirma el trabajo exitoso y mueve a la cola de mensajes muertos (DLQ) los que agotan sus reintentos.

## Inbox y CRM

`@bot-wa/inbox` incorpora asignación con concurrencia optimista, handoff, notas y unread. Proyecta los `StoredMessage` del ledger con `inbox.projectMessage(message)` para reconstruir conversaciones entre canales.

`@bot-wa/crm` guarda canales de contacto, tags, atributos y consentimiento de marketing. Segmenta siempre las campañas con datos aislados por tenant y con consentimiento.

## Campañas, plugins y despliegues

`@bot-wa/campaigns` descarta opt-outs, segmentos que no coinciden y destinatarios duplicados. Un worker durable debe realizar el envío real y registrar el resultado de cada entrega.

`@bot-wa/hub` valida manifiestos de plugins, compatibilidad con el runtime y permisos concedidos antes de habilitar un plugin. Por sí solo no ejecuta ni aísla código no confiable.

`@bot-wa/deployments` registra versiones inmutables y un despliegue activo por tenant/bot. Conéctalo a tu sistema de despliegue para hacer rollouts graduales y rollback físico.
