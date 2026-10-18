# Persistent user data (`ctx.user`)

`ctx.user` is a key/value profile **per user** that survives across
conversations and, with a persistent store, across restarts. Use it for
preferences, a name you asked for once, a game board, an opt-in flag...

```ts
bot.when('hola', async (ctx) => {
  const name = await ctx.user.get<string>('name')               // undefined if missing or expired
  await ctx.user.set('name', 'Juan')
  await ctx.user.set('address.city', 'Bogotá')                   // dot paths
  await ctx.user.update({ lang: 'es', 'address.zip': '110111' }) // each key is a path
  await ctx.user.delete('address.zip')
  const profile = await ctx.user.all()                           // { name, lang, address: {...} }

  // Namespaces per feature or plugin
  await ctx.user.ns('game').set('board', board, { ttl: '30m' })  // TTL: '90s', '30m', '12h', '7d', '2w' or ms
  await ctx.user.ns('game').clear()                              // only that namespace
})
```

## Who the profile belongs to

- The key is the canonical sender (`ctx.sender`, the `senderId` the
  provider resolved), so the same person sees the same data in their DM and
  in every group.
- It lives inside the bot's store namespace (tenant / environment / bot /
  provider / connection): two bots sharing one backend never see each
  other's profiles.

## Outside handlers and inside flows

```ts
// Jobs, webhooks, admin endpoints
await bot.user('5491122334455').ns('billing').set('plan', 'pro')

// Inside flow steps ctx is a RuntimeMessage: use userOf()
import { userOf } from '@bot-wa/core'

flow('idioma')
  .ask('Language?', 'lang')
  .do(async (ctx, c) => { await userOf(ctx).set('lang', c.state.lang) })
```

`userOf(ctx)` rejects with `UserDataError('UNAVAILABLE')` when the context
was not built by a bot. In `bot.conversation(name, async (c, ctx) => ...)`
the `ctx` is a full `MessageContext`, so `ctx.user` works directly.

## API

| Method | What it does |
| --- | --- |
| `get<T>(path)` | Value at `path`, or `undefined` when missing or expired. `T` is an unchecked cast. |
| `all()` | Every live top-level key of the namespace as an object (`{}` when empty). |
| `set(path, value, { ttl? })` | Writes `value`. `set(path, undefined)` is the same as `delete(path)`. |
| `update(values, { ttl? })` | Several writes; each property of `values` is a path. |
| `delete(path)` | Removes a top-level key or a nested member. Missing paths are a no-op. |
| `clear()` | Removes every key of **this** namespace for this user. |
| `ns(name)` | Same API scoped to namespace `name` (flat: `ns('a').ns('b')` is `'b'`). |

`ctx.user` is the `'default'` namespace (`DEFAULT_USER_NAMESPACE`).

## Paths and values

- A path splits on every dot. The **first segment is the top-level key**,
  the unit the store persists atomically; deeper segments live inside its
  JSON value. Arrays are indexed (`'items.0'`) and can only grow at the end
  (index ≤ length).
- Rejected with `UserDataError('INVALID_PATH')`: empty segments,
  `__proto__`/`prototype`/`constructor`, control characters and keys longer
  than 255 characters. Namespaces are 1–128 characters with no control
  characters (`INVALID_NAMESPACE`).
- Values are JSON: they are copied through JSON on write (a `Date` becomes
  an ISO string) and every read returns a fresh copy. BigInt, functions,
  symbols and cycles reject with `INVALID_VALUE`.
- Ids, namespaces and keys are compared as exact strings: case, accents and
  leading or trailing spaces matter, in every store.

## TTL (Redis model)

- With `ttl`, the **top-level key** expires `ttl` after that write, even if
  the path is nested.
- A top-level `set` without `ttl` replaces the value and **removes** any
  expiry.
- A nested write without `ttl` (including `delete('a.b')`) keeps the current
  expiry.
- The TTL must be positive and finite (`INVALID_TTL` otherwise); fractional
  milliseconds are rounded up.
- An expired key reads as absent right away. It is removed physically by
  Redis (native expiry) or by `bot.purgeExpiredUserData()`, which writes
  trigger at most once a minute. For quiet bots, schedule it:
  `bot.every('1h', () => bot.purgeExpiredUserData())`.

## Batches and concurrency

- `update()` validates every path, value, array index and the `ttl` before
  writing anything, so an invalid batch writes nothing. All the paths under
  one top-level key become one store write. The batch as a whole is not
  atomic: if the store fails one key, others may already be written; the
  call rejects only after every write has settled.
- The per-chat FIFO does **not** serialize one user writing from several
  chats, so `ctx.user` serializes every write of a user inside the process
  (`set`/`update`/`delete`/`clear` and subject deletion), in call order.
- With several replicas on one store, top-level writes stay atomic (last
  writer wins), but two replicas writing nested paths of the **same**
  top-level key at the same time can lose an update.
- Reads do not wait for writes: `await` your writes before reading them
  back.

## Stores

All six bundled stores support it: `MemoryStore`, `SQLiteStore`,
`RedisStore`, `MongoStore`, `PostgresStore` and `MysqlStore`. See
[Persistent store](./store#user-data-tables) for the tables and keys they
use.

A custom `IStore` without the optional user-data methods makes `ctx.user`
reject with `UserDataError('UNSUPPORTED_STORE')`; subject export and
deletion keep working (`userData: []` / `0`). `supportsUserData(store)`
tells you which case you are in. To implement it, add `getUserData`,
`setUserData`, `deleteUserData`, `listUserData` and `purgeExpiredUserData`
and pass the shared suite `runUserDataConformance` from
`test-utils/user-data-conformance.ts`.

## Privacy: export and erasure

```ts
const data = await bot.exportSubject(userId)
data.userData   // live entries of every namespace: { namespace, key, value, expiresAt?, updatedAt }

const result = await bot.deleteSubject(userId)
result.userData // number of entries deleted
```

Deletion waits for that user's in-flight writes, so a queued write cannot
bring the data back.

## Errors

`UserDataError` has a `code`: `INVALID_PATH`, `INVALID_NAMESPACE`,
`INVALID_VALUE`, `INVALID_TTL`, `INVALID_USER`, `UNSUPPORTED_STORE` or
`UNAVAILABLE`.

## Next steps

- [Persistent store](./store)
- [Handoff & access lists](./handoff)
