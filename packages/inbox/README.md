# @bot-wa/inbox

> [!WARNING]
> **Prototipo en memoria · privado (`"private": true`, no se publica en npm).**
> El estado vive en RAM y se pierde al reiniciar; no hay persistencia, tiempo real ni coordinación entre procesos, y la API puede cambiar sin aviso. Sirve para fijar el contrato antes de la implementación durable.
>
> Roadmap: track [E. Inbox, contactos y CRM ligero](../../ROADMAP.md#e-inbox-contactos-y-crm-ligero), fase [F4 — Operación y producto](../../ROADMAP.md#f4--operación-y-producto) («Inbox y ledger en tiempo real», «Handoff y operación de agentes»). Depende del message ledger durable de la fase [F1](../../ROADMAP.md#f1--runtime-productivo-y-datos).

Inbox aislado por tenant para conversaciones omnicanal. Incluye asignación con CAS, handoff, notas internas, unread y proyección desde el ledger del core.

```ts
import { MemoryInbox } from '@bot-wa/inbox'

const inbox = new MemoryInbox()
const conversation = inbox.projectMessage(storedMessage)
const assigned = inbox.assign('acme', conversation.id, 'agent-7', conversation.version)
inbox.handoff('acme', assigned.id, true, assigned.version)
```

Las mutaciones requieren `expectedVersion`: un conflicto (`InboxConflictError`) evita que dos agentes sobrescriban el handoff. `upsert(input, expectedVersion?)` también aplica CAS: sobre una conversación existente exige su versión actual; al crear acepta la versión omitida o `0` (`0` = solo crear).

`projectMessage()` aplica su incremento de `unread` de forma atómica sobre el estado más reciente, sin revertir cambios de agentes. La dirección sale de `direction` o, si falta, de `fromMe` (`true` = saliente); un mensaje sin ninguno de los dos se rechaza con `TypeError` sin escribir nada. Para producción, persiste esta misma semántica sobre una base de datos.
