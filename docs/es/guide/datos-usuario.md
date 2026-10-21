# Datos persistentes por usuario (`ctx.user`)

`ctx.user` es un perfil clave/valor **por usuario** que sobrevive entre
conversaciones y, con un store persistente, entre reinicios. Úsalo para
preferencias, un nombre que preguntaste una vez, el tablero de un juego, un
consentimiento...

```ts
bot.when('hola', async (ctx) => {
  const name = await ctx.user.get<string>('name')               // undefined si no existe o expiró
  await ctx.user.set('name', 'Juan')
  await ctx.user.set('address.city', 'Bogotá')                   // paths con puntos
  await ctx.user.update({ lang: 'es', 'address.zip': '110111' }) // cada clave es un path
  await ctx.user.delete('address.zip')
  const perfil = await ctx.user.all()                            // { name, lang, address: {...} }

  // Namespaces por feature o plugin
  await ctx.user.ns('game').set('board', board, { ttl: '30m' })  // TTL: '90s', '30m', '12h', '7d', '2w' o ms
  await ctx.user.ns('game').clear()                              // solo ese namespace
})
```

## De quién es el perfil

- La clave es el remitente canónico (`ctx.sender`, el `senderId` que
  resolvió el provider), así que la misma persona ve los mismos datos en su
  DM y en todos los grupos.
- Vive dentro del namespace de store del bot (tenant / entorno / bot /
  provider / conexión): dos bots que comparten backend no ven los perfiles
  del otro.

## Fuera de handlers y dentro de flujos

```ts
// Jobs, webhooks, endpoints de administración
await bot.user('5491122334455').ns('billing').set('plan', 'pro')

// En los pasos de un flujo el ctx es un RuntimeMessage: usa userOf()
import { userOf } from '@botmesh/core'

flow('idioma')
  .ask('¿Idioma?', 'lang')
  .do(async (ctx, c) => { await userOf(ctx).set('lang', c.state.lang) })
```

`userOf(ctx)` rechaza con `UserDataError('UNAVAILABLE')` si el contexto no
lo construyó un bot. En `bot.conversation(name, async (c, ctx) => ...)` el
`ctx` es un `MessageContext` completo, así que `ctx.user` funciona directo.

## API

| Método | Qué hace |
| --- | --- |
| `get<T>(path)` | Valor en `path`, o `undefined` si no existe o expiró. `T` es un cast sin comprobar. |
| `all()` | Todas las claves de primer nivel vivas del namespace como objeto (`{}` si está vacío). |
| `set(path, value, { ttl? })` | Escribe `value`. `set(path, undefined)` equivale a `delete(path)`. |
| `update(values, { ttl? })` | Varias escrituras; cada propiedad de `values` es un path. |
| `delete(path)` | Borra una clave de primer nivel o un miembro anidado. Un path inexistente no hace nada. |
| `clear()` | Borra todas las claves de **este** namespace para este usuario. |
| `ns(name)` | La misma API en el namespace `name` (plano: `ns('a').ns('b')` es `'b'`). |

`ctx.user` es el namespace `'default'` (`DEFAULT_USER_NAMESPACE`).

## Paths y valores

- Un path se parte en cada punto. El **primer segmento es la clave de
  primer nivel**, la unidad que el store guarda de forma atómica; los
  segmentos siguientes viven dentro de su valor JSON. Los arrays se indexan
  (`'items.0'`) y solo pueden crecer por el final (índice ≤ longitud).
- Se rechazan con `UserDataError('INVALID_PATH')`: segmentos vacíos,
  `__proto__`/`prototype`/`constructor`, caracteres de control y claves de
  más de 255 caracteres. Los namespaces tienen de 1 a 128 caracteres, sin
  caracteres de control (`INVALID_NAMESPACE`).
- Los valores son JSON: se copian vía JSON al escribir (un `Date` pasa a
  string ISO) y cada lectura devuelve una copia nueva. BigInt, funciones,
  símbolos y ciclos rechazan con `INVALID_VALUE`.
- Ids, namespaces y claves se comparan como strings exactos: mayúsculas,
  acentos y espacios al principio o al final cuentan, en todos los stores.

## TTL (modelo Redis)

- Con `ttl`, la **clave de primer nivel** expira `ttl` después de esa
  escritura, aunque el path sea anidado.
- Un `set` de primer nivel sin `ttl` reemplaza el valor y **quita** la
  expiración.
- Una escritura anidada sin `ttl` (incluido `delete('a.b')`) conserva la
  expiración actual.
- El TTL debe ser positivo y finito (si no, `INVALID_TTL`); los
  milisegundos fraccionarios se redondean hacia arriba.
- Una clave expirada se lee como ausente al instante. Se borra físicamente
  con Redis (expiración nativa) o con `bot.purgeExpiredUserData()`, que las
  escrituras disparan como mucho una vez por minuto. Para bots con poco
  tráfico, prográmalo: `bot.every('1h', () => bot.purgeExpiredUserData())`.

## Lotes y concurrencia

- `update()` valida todos los paths, valores, índices de array y el `ttl`
  antes de escribir nada, así que un lote inválido no escribe nada. Todos
  los paths de una misma clave de primer nivel van en una sola escritura.
  El lote completo no es atómico: si el store falla en una clave, otras
  pueden haberse guardado ya; la llamada rechaza solo cuando todas las
  escrituras han terminado.
- La cola FIFO por chat **no** serializa a un usuario que escribe desde
  varios chats, así que `ctx.user` serializa en el proceso todas las
  escrituras de un usuario (`set`/`update`/`delete`/`clear` y el borrado
  de sujeto), en orden de llamada.
- Con varias réplicas sobre un mismo store, las escrituras de primer nivel
  siguen siendo atómicas (gana la última), pero dos réplicas que escriben
  paths anidados de la **misma** clave a la vez pueden perder una
  actualización.
- Las lecturas no esperan a las escrituras: haz `await` de tus escrituras
  antes de volver a leerlas.

## Stores

Los seis stores incluidos lo soportan: `MemoryStore`, `SQLiteStore`,
`RedisStore`, `MongoStore`, `PostgresStore` y `MysqlStore`. En
[Store persistente](./store#tablas-de-datos-de-usuario) están las tablas y
claves que usa cada uno.

Un `IStore` propio sin los métodos opcionales de datos de usuario hace que
`ctx.user` rechace con `UserDataError('UNSUPPORTED_STORE')`; la exportación
y el borrado de sujeto siguen funcionando (`userData: []` / `0`).
`supportsUserData(store)` te dice en qué caso estás. Para implementarlo,
añade `getUserData`, `setUserData`, `deleteUserData`, `listUserData` y
`purgeExpiredUserData` y pasa la suite compartida `runUserDataConformance`
de `test-utils/user-data-conformance.ts`.

## Privacidad: exportación y borrado

```ts
const data = await bot.exportSubject(userId)
data.userData   // entradas vivas de todos los namespaces: { namespace, key, value, expiresAt?, updatedAt }

const result = await bot.deleteSubject(userId)
result.userData // número de entradas borradas
```

El borrado espera a las escrituras en curso de ese usuario, así que una
escritura en cola no puede devolver los datos.

## Errores

`UserDataError` tiene un `code`: `INVALID_PATH`, `INVALID_NAMESPACE`,
`INVALID_VALUE`, `INVALID_TTL`, `INVALID_USER`, `UNSUPPORTED_STORE` o
`UNAVAILABLE`.

## Siguientes pasos

- [Store persistente](./store)
- [Handoff y listas de acceso](./handoff)
