# Store Persistente

El **store** es donde el bot guarda mensajes, chats, contactos, estado de flujos, checkpoints e historial de conversaciones de IA. Elegir el store correcto es la diferencia entre un bot que olvida todo al reiniciar y uno que sobrevive a los deploys.

Los stores implementan el `IStore` genérico y neutral de transporte de `@bot-wa/core` — el mismo store funciona con cualquier provider (Baileys, Cloud API, Telegram, Discord).

## Stores disponibles

| Store | Paquete | Persistencia | Caso de uso |
|---|---|---|---|
| `MemoryStore` *(default)* | `@bot-wa/core` | En memoria (dump JSON opcional) | Desarrollo, tests, bots de vida corta |
| `SQLiteStore` | `@bot-wa/sqlite-store` | Archivo SQLite (modo WAL) | **Producción** — single-bot, cero config |
| `RedisStore` | `@bot-wa/redis-store` | Servidor Redis | Estado distribuido, varias instancias, TTL |
| `MongoStore` · `PostgresStore` · `MysqlStore` | `@bot-wa/mongo-store` · `@bot-wa/postgres-store` · `@bot-wa/mysql-store` | MongoDB / PostgreSQL / MySQL | **Experimental** — implementaciones reales y con tests, aún sin publicar |

`MemoryStore` viene con el core. `SQLiteStore` y `RedisStore` forman parte de
la primera alpha (todavía no están en npm; la primera publicación se está
preparando). Los stores de MongoDB, PostgreSQL y MySQL pasan la misma suite de
conformidad de `IStore`, pero de momento siguen siendo privados (sin
publicar); mira sus READMEs en el
[repositorio](https://github.com/andresayac/bot-wa-baileys/tree/main/packages).

## MemoryStore (default)

Si no pasas un `store`, el bot crea un `MemoryStore`. Todo vive en RAM; un archivo JSON opcional puede guardar chats/contactos/checkpoints (no mensajes) en un intervalo.

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  // Opcional: persistir chats + estado de flujo a un archivo JSON
  storeConfig: {
    file: './store.json',
    autoSaveInterval: '1m', // duración o ms (0 = desactivar)
    maxMessagesPerChat: 1000,
  },
})
```

::: warning Los mensajes NO se restauran
`MemoryStore` intencionalmente omite los mensajes al recargar (privacidad + tamaño). Solo chats, contactos, flow states, checkpoints y conversaciones AI sobreviven un reinicio vía el dump JSON.
:::

## SQLiteStore (recomendado para producción)

Una base de datos real con [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — síncrona, cero config, un solo archivo. Perfecta para una sola instancia de bot en un VPS o contenedor Docker. Es un **paquete separado**; `better-sqlite3` es una peer dependency que instalas a su lado (se carga al construir el store, así que si falta obtienes un error claro):

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
| `maxMessagesPerChat` | `number` | — (sin límite) | Conserva solo los N mensajes más recientes por chat; los más viejos se podan al guardar |
| `logger` | `object` | — | Logger para errores (`{ error: fn }`) |

### Qué almacena

| Tabla | Contenido |
|---|---|
| `messages` | Cada mensaje entrante/saliente (indexado por chat + timestamp) |
| `chats` | Metadatos de chats (nombre, kind, etc.) |
| `contacts` | Info de contactos (display name, username, etc.) |
| `checkpoints` | Checkpoints de flujos `persistent()`, incluido el `c.state` del flujo — sobreviven reinicios |
| `conversations` | Historial de conversaciones AI (`@bot-wa/ai`) |
| `cursors` | Cursores de entrega (p. ej. el `update_id` de Telegram) |

### Schema

El store crea sus tablas al construirse (`CREATE TABLE IF NOT EXISTS`). Nunca necesitas crearlas a mano — solo apúntalo a un archivo y él se encarga del resto.

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
  store: new RedisStore({ url: 'redis://localhost:6379', sessionTtl: '7d' }),
})
```

`sessionTtl` (una duración como `'24h'`, o milisegundos, como el resto de opciones de
duración) hace expirar el historial de IA y los checkpoints de flujos; los mensajes,
chats y contactos nunca expiran. Sustituye a la opción obsoleta `ttl`, que iba en segundos.

## Tablas de datos de usuario

Los perfiles de [`ctx.user`](./datos-usuario) se guardan junto al resto del
estado del bot, respetando `tablePrefix` / `collectionPrefix`:

| Store | Dónde |
| --- | --- |
| `MemoryStore` | en memoria; el `file` JSON suma el campo `userData` (los archivos antiguos siguen cargando) |
| `SQLiteStore` | tabla `user_data` (`user_id`, `namespace`, `key`, `value_json`, `expires_at`, `updated_at`) + índice sobre `expires_at` |
| `PostgresStore` | tabla `{prefix}user_data` (valor como `TEXT`, no JSONB, para conservar el JSON exacto: U+0000 y los surrogates sueltos vuelven sin cambios, como escapes JSON `\u0000`) + índice de expiración |
| `MysqlStore` | tabla `{prefix}user_data`: ids, namespace y clave como `VARBINARY` (exactos byte a byte), valor `MEDIUMTEXT` (16 MiB) |
| `MongoStore` | colección `{prefix}user_data`, índices sobre `{ userId, namespace }` y `expiresAt` |
| `RedisStore` | una clave por entrada, `{prefix}:ud:{user}:{ns}:{key}`, con expiración nativa `PX`; para listar y borrar namespaces usa `KEYS`, como `listChats` |

Postgres y MySQL crean ahora siete tablas en `start()`. Las filas expiradas
se borran de forma perezosa con `bot.purgeExpiredUserData()` (Redis las
expira por sí mismo).

## Stores personalizados

Implementa la interfaz `IStore` para conectar cualquier otro backend (MongoDB, PostgreSQL y MySQL ya tienen stores experimentales en el monorepo):

```ts
import type { IStore } from '@bot-wa/core'

class MiStore implements IStore {
  async saveMessage(msg) { /* ... */ }
  async getMessage(ref) { /* ... */ }
  // ... implementa cada método
}

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new MiStore({ /* ... */ }),
})
```

La interfaz completa está documentada en la [referencia de API](/api/interfaces/IStore.html). `MemoryStore` es la implementación de referencia del contrato; dentro del monorepo, todos los stores corren la suite de conformidad compartida (`test-utils/store-conformance.ts`).

Semántica que todo store debe respetar:

- `upsertChat` / `upsertContact` hacen **merge superficial** sobre el registro
  guardado. Un campo propio con valor `undefined` **borra** ese campo, así que un
  upsert parcial debe omitir lo que no conoce. El `Bot` ya lo hace: un mensaje sin
  nombre visible (o sin nombre de chat) nunca borra el que estaba guardado.
- `deleteChat` borra también el log de mensajes de ese chat.
- `maxMessagesPerChat` es opt-in; por defecto el log de mensajes no tiene límite.

Los métodos de datos de usuario (`getUserData`, `setUserData`,
`deleteUserData`, `listUserData`, `purgeExpiredUserData`) son opcionales:
sin ellos `ctx.user` rechaza con `UNSUPPORTED_STORE`. Si los añades, pasa
también `runUserDataConformance` de `test-utils/user-data-conformance.ts`.
Un store con `getCursor`/`setCursor` también persiste las marcas de
[`WELCOME`](./triggers#welcome) y el índice de [handoff](./handoff).

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
