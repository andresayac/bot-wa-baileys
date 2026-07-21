# Store Persistente

El **store** es donde el bot guarda mensajes, chats, contactos, estado de flujos, checkpoints e historial de conversaciones de IA. Elegir el store correcto es la diferencia entre un bot que olvida todo al reiniciar y uno que sobrevive a los deploys.

Los stores implementan el `IStore` genérico y neutral de transporte de `@bot-wa/core` — el mismo store funciona con cualquier provider (Baileys, Cloud API, Telegram, Discord).

## Stores disponibles

| Store | Paquete | Persistencia | Caso de uso |
|---|---|---|---|
| `MemoryStore` *(default)* | `@bot-wa/core` | En memoria (dump JSON opcional) | Desarrollo, tests, bots de vida corta |
| `SQLiteStore` | `@bot-wa/sqlite-store` | Archivo SQLite (modo WAL) | **Producción** — single-bot, cero config |
| `RedisStore` | `@bot-wa/redis-store` | Servidor Redis | Estado distribuido, varias instancias, TTL |

## MemoryStore (default)

Si no pasas un `store`, el bot crea un `MemoryStore`. Todo vive en RAM; un archivo JSON opcional puede guardar chats/contactos/checkpoints (no mensajes) en un intervalo.

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  // Opcional: persistir chats + estado de flujo a un archivo JSON
  storeConfig: {
    file: './store.json',
    autoSaveInterval: 60_000, // ms (0 = desactivar)
    maxMessagesPerChat: 1000,
  },
})
```

::: warning Los mensajes NO se restauran
`MemoryStore` intencionalmente omite los mensajes al recargar (privacidad + tamaño). Solo chats, contactos, flow states, checkpoints y conversaciones AI sobreviven un reinicio vía el dump JSON.
:::

## SQLiteStore (recomendado para producción)

Una base de datos real con [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — síncrona, cero config, un solo archivo. Perfecta para una sola instancia de bot en un VPS o contenedor Docker. Es un **paquete separado** con `better-sqlite3` como peer dependency opcional (carga perezosa):

```bash
pnpm add @bot-wa/sqlite-store better-sqlite3
```

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})
```

### Opciones

| Opción | Tipo | Default | Descripción |
|---|---|---|---|
| `file` | `string` | `'./bot.db'` | Ruta al archivo de base de datos SQLite |
| `wal` | `boolean` | `true` | Activar modo WAL (mejores lecturas concurrentes) |
| `logger` | `object` | — | Logger para errores (`{ error: fn }`) |

### Qué almacena

| Tabla | Contenido |
|---|---|
| `messages` | Cada mensaje entrante/saliente (indexado por chat + timestamp) |
| `chats` | Metadatos de chats (nombre, kind, etc.) |
| `contacts` | Info de contactos (display name, username, etc.) |
| `flow_states` | Estado de flujo por usuario (`c.state`) |
| `checkpoints` | Checkpoints de flujos `persistent()` — sobreviven reinicios |
| `conversations` | Historial de conversaciones AI (`@bot-wa/ai`) |

### Migraciones de schema

El store ejecuta **migraciones automáticas** al arrancar. Nunca necesitas crear tablas manualmente — solo apúntalo a un archivo y él se encarga del resto.

### Flujos persistentes + SQLiteStore

Con `SQLiteStore`, los checkpoints de `flow(...).persistent()` sobreviven reinicios del proceso gratis:

```ts
import { Bot, flow } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})

bot.use(
  flow('registro')
    .persistent()          // ← checkpoint guardado en SQLite tras cada paso
    .ask('¿Tu nombre?', 'name')
    .ask('¿Tu email?', 'email')
    .say((_ctx, c) => `✅ Registrado: ${c.state.name}`)
)
```

Si el proceso se cae a mitad del flujo, el próximo mensaje de ese usuario **reanuda en el paso exacto** donde se quedó.

## RedisStore (distribuido)

Cuando necesitas estado compartido entre procesos/instancias (escalamiento horizontal, logs por chat con TTL), usa el store de Redis:

```bash
pnpm add @bot-wa/redis-store
```

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { RedisStore } from '@bot-wa/redis-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new RedisStore({ url: 'redis://localhost:6379' }),
})
```

## Stores personalizados

Implementa la interfaz `IStore` para conectar Postgres, Mongo o lo que quieras:

```ts
import type { IStore } from '@bot-wa/core'

class PostgresStore implements IStore {
  async saveMessage(msg) { /* ... */ }
  async getMessage(ref) { /* ... */ }
  // ... implementa cada método
}

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new PostgresStore({ /* ... */ }),
})
```

La interfaz completa está documentada en la [referencia de API](/api/interfaces/IStore.html).

## Docker + SQLiteStore

Monta el directorio de datos como volumen para que la base de datos sobreviva reinicios del contenedor:

```yaml
# docker-compose.yml
services:
  bot:
    build: .
    volumes:
      - ./sessions:/app/sessions   # Auth de WhatsApp
      - ./data:/app/data           # Base de datos SQLite
```
