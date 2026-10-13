# Operations: events, inbox and delivery

::: warning Experimental and prototype packages — none is published
`@bot-wa/events` is **experimental**: a real, tested implementation that is
still private (not on npm). `@bot-wa/inbox`, `@bot-wa/crm`, `@bot-wa/hub`,
`@bot-wa/campaigns` and `@bot-wa/deployments` are **prototypes**: minimal
in-memory sketches to explore the design. They don't persist anything, don't
scale beyond one process and are not meant for production.
:::

The operational packages are transport-neutral and scoped by tenant.

## Event processing

Use `MemoryEventJournal` in tests. `FileEventJournal.open('./data/events.json')` persists a single-process journal with atomic snapshots, idempotency, leases, retries and replay. For multiple replicas, implement `EventJournal` over PostgreSQL, Redis or a broker.

`EventWorker` claims events, invokes the handler, acknowledges successful work and moves exhausted retries to the dead-letter state.

## Inbox and CRM

`@bot-wa/inbox` provides optimistic-concurrency assignment, handoff, notes and unread state. Project ledger `StoredMessage` entries with `inbox.projectMessage(message)` so conversations can be rebuilt across channels.

`@bot-wa/crm` stores contact channels, tags, attributes and marketing consent. Always segment campaigns using tenant-scoped data and consent.

## Campaigns, plugins and deployments

`@bot-wa/campaigns` skips opt-outs, mismatched segments and duplicate recipients. A durable worker must perform the actual send and record delivery results.

`@bot-wa/hub` validates plugin manifests, runtime compatibility and granted permissions before enabling a plugin. It does not execute or sandbox untrusted code by itself.

`@bot-wa/deployments` tracks immutable versions and one active deployment per tenant/bot. Connect it to your deployment system for gradual rollout and physical rollback.
