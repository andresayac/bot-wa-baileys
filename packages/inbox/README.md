# @bot-wa/inbox

Inbox aislado por tenant para conversaciones omnicanal. Incluye asignación con CAS, handoff, notas internas, unread y proyección desde el ledger del core.

```ts
const inbox = new MemoryInbox()
const conversation = inbox.projectMessage(storedMessage)
const assigned = inbox.assign('acme', conversation.id, 'agent-7', conversation.version)
inbox.handoff('acme', assigned.id, true, assigned.version)
```

Las mutaciones requieren `expectedVersion`: un conflicto evita que dos agentes sobrescriban el handoff. Para producción, persiste esta misma semántica sobre una base de datos.
