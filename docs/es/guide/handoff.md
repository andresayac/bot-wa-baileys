# Handoff humano y listas de acceso

Dos gates que deciden si el bot responde o no:

- El **handoff humano** pausa el bot en un chat mientras una persona (un
  agente, el inbox de un CRM) toma el control.
- La **blacklist / whitelist** descarta los mensajes de ciertos remitentes o
  chats antes incluso de guardarlos.

Ambos están en el `Bot` (y en `pluginCtx.bot` dentro de los plugins).

## Handoff humano

```ts
const bot = new Bot({ provider, store, handoff: { allowCommands: ['/bot'] } })

bot.when('hablar con humano', async (ctx) => {
  await ctx.handoff({ reason: 'user request', meta: { queue: 'ventas' } })
  await ctx.reply('Te conecto con un agente…')  // el handler que hace el handoff aún puede responder
})
bot.command('bot', async (ctx) => { await bot.resume(ctx.from); await ctx.reply('🤖 De vuelta') })

bot.on('handoff', ({ chatId, reason, since, meta }) => crm.assign(chatId, reason))
bot.on('resume', ({ chatId, at, reason, handoff }) => crm.close(chatId))
bot.on('message', (ctx) => { if (bot.isHandedOff(ctx.from)) crm.relay(ctx.from, ctx.body) })

// El agente responde fuera del pipeline (un string se envía como texto)
await bot.sendTo(chatId, 'Hola, soy Ana 👋')
await bot.resume(chatId, { reason: 'ticket cerrado' })

bot.isHandedOff(chatId)   // boolean
bot.getHandoff(chatId)    // { chatId, since, reason?, meta? } | undefined (una copia)
bot.listHandoffs()        // HandoffState[]
```

El estado es **por chat** (`ctx.from`): un handoff en un grupo pausa el bot
para todos los miembros del grupo, pero no en sus DMs.

### Qué pasa mientras el chat está en handoff

- Los mensajes **se persisten**, los hooks `before`/`after('message')`
  **corren** (un hook `before` todavía puede hacer `abort()`) y el **evento
  `'message'` se emite**, así que una integración de inbox lo ve todo.
- Comandos, conversaciones, checkpoints dormidos, matchers y catch-all
  **no corren**, y no se emite `'command:unknown'`. También se bloquean las
  interacciones (botones y listas) y los [triggers `CALL`](./triggers#call).
- **Comandos de escape** (`handoff.allowCommands`): con o sin prefijo, se
  comparan como los comandos (sin distinguir mayúsculas ni acentos). Solo
  pasan si hay un `bot.command()` registrado con ese nombre; si no, siguen
  bloqueados y nunca llegan al catch-all. Conviene que ese comando haga
  `bot.resume(...)` en vez de iniciar un flujo.
- Los temporizadores de [`bot.onIdle`](./flujos#bot-onidle-inactividad-por-chat)
  del chat se cancelan y quedan suspendidos hasta el resume.

### Al empezar el handoff

- Se cancelan **en silencio** (sin `cancelledMessage`) todas las
  conversaciones activas del chat: todos los participantes, con cualquier
  `conversationScope`. Sus checkpoints dormidos se borran de memoria y del
  store.
- Si `ctx.handoff()` se llama dentro de un `.do()` de un flujo, el flujo
  termina: los pasos siguientes no corren. En los pasos de un flujo el
  `ctx` está tipado como `RuntimeMessage`, así que ahí usa
  `bot.handoff(ctx.from)`.

### Valores de retorno

- `handoff()` / `resume()` devuelven `Promise<boolean>`: `true` si cambió el
  estado. Son idempotentes: un segundo handoff no cambia la razón ni emite
  evento.
- El estado cambia de forma síncrona, así que no hace falta `await` antes
  de la siguiente línea.
- Nunca rechazan por errores del store; esos errores van al evento
  `'error'`. Lanzan un `TypeError` síncrono si el chatId está vacío.
- `ctx.handoff()` resuelve `false` si el contexto no lo construyó un bot.
- `bot.sendTo()` pasa por los hooks `before`/`after('send')` y por el
  ledger de salida, como `bot.send()`. No reanuda el bot.

### Persistencia

- El estado se guarda en `StoredChat.handoff = { since, reason?, meta? }`
  (queda en `null` al hacer resume), más un pequeño índice de chats en
  handoff bajo la clave de cursor `HANDOFF_INDEX_KEY`.
- `bot.start()` lo restaura con una lectura por chat en handoff (los stores
  sin cursores usan `listChats()`). Al restaurar no se emite `'handoff'`.
  También borra los checkpoints dormidos de cada chat en handoff, así que
  un flujo viejo nunca se reanuda tras `bot.resume()`.
- Si la restauración falla, se informa en `'error'` y `start()` no falla.
  Un `resume()` llamado mientras la restauración sigue en curso la espera.
- Sobrevive a reinicios con un store persistente (SQLite, Redis, Postgres,
  MySQL, Mongo o `MemoryStore` con `file`). `handoff: { persist: false }`
  lo deja solo en memoria. `meta` debe ser serializable a JSON.
- `bot.deleteSubject(userId)` olvida el handoff del chat de ese usuario,
  sin eventos.

## Blacklist y whitelist

```ts
bot.blacklist.add('573001234567@s.whatsapp.net')        // ids EXACTOS, como llegan en ctx.sender / ctx.from
bot.blacklist.add(['a@s.whatsapp.net', '1203630@g.us'])  // el id de un grupo bloquea a todo el grupo
bot.blacklist.remove('a@s.whatsapp.net')
bot.blacklist.has(id); bot.blacklist.list(); bot.blacklist.size; bot.blacklist.clear()

bot.whitelist.add(['vip@s.whatsapp.net', '1203630@g.us']).enable()  // modo whitelist
bot.whitelist.disable(); bot.whitelist.enabled
```

### Reglas de acceso

- Las dos listas se comparan contra el **id del remitente y el id del
  chat**, con igualdad exacta: el core no normaliza nada. En WhatsApp
  (Baileys) usa el JID completo, no solo el número.
- Gana la blacklist. Una whitelist habilitada pero vacía bloquea a todos.
  La whitelist está deshabilitada por defecto.
- Un usuario en la whitelist pasa en cualquier grupo; un grupo en la
  whitelist deja pasar a todos sus miembros.
- `checkAccess(blacklist, whitelist, { chatId, senderId })` devuelve la
  misma decisión (`'allowed' | 'blacklisted' | 'not-whitelisted'`) para tu
  propio código.

### Qué pasa con un mensaje bloqueado

Se descarta **antes de persistir**: no se guardan el mensaje, el chat ni el
contacto; no corren hooks, comandos, conversaciones ni la reanudación
dormida (el checkpoint queda intacto), y no se emite `'message'`. Se
registra en debug con `{ gate, chatId, senderId }`, nunca el cuerpo. Aplica
a mensajes, interacciones y triggers `CALL`; no filtra reacciones, votos de
encuestas, presencia ni eventos de grupo.

Bloquear a alguien **no** cancela una conversación que ya esté en curso
(simplemente dejan de llegar sus respuestas). Usa
`bot.abortConversation(...)` si lo necesitas.

### Guardar las listas

Las listas viven en memoria; persistirlas es cosa tuya:

```ts
import fs from 'node:fs'

function save() { fs.writeFileSync('acl.json', JSON.stringify(bot.exportAccessLists())) }
bot.blacklist.onChange(save)
bot.whitelist.onChange(save)

bot.loadAccessLists(JSON.parse(fs.readFileSync('acl.json', 'utf8')))
// formato: { blacklist: { ids: [...] }, whitelist: { ids: [...], enabled: true } }
```

- `add`/`remove` aceptan un id o un array y lanzan `TypeError` si un id
  está vacío o no es string (se valida antes de cambiar nada).
- `onChange` solo notifica cambios efectivos; `load` notifica siempre.
- `loadAccessLists` también acepta arrays simples de ids para cada lista.

## Siguientes pasos

- [Conceptos básicos](./conceptos#el-pipeline-de-entrada): dónde corre cada gate
- [Hooks](./hooks)
- [Control plane](./control-plane)
