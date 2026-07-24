# Operación: eventos, inbox y entregas

Los paquetes operativos son agnósticos de canal y están aislados por tenant.

`FileEventJournal.open('./data/events.json')` persiste el journal de una sola instancia con snapshots atómicos, idempotencia, leases, reintentos y replay. Para múltiples réplicas implementa `EventJournal` sobre PostgreSQL, Redis o un broker.

`@bot-wa/inbox` incorpora asignación con concurrencia optimista, handoff, notas y unread. Proyecta los `StoredMessage` del ledger con `inbox.projectMessage(message)` para reconstruir conversaciones entre canales.

`@bot-wa/crm` maneja canales, tags, atributos y consentimiento. `@bot-wa/campaigns` descarta opt-outs, segmentos que no coinciden y destinatarios duplicados. Un worker durable realiza el envío real.

`@bot-wa/hub` valida manifiestos, compatibilidad y permisos antes de habilitar plugins. `@bot-wa/deployments` registra versiones inmutables y rollback lógico por tenant/bot.
