# Inyección de dependencias

Comparte herramientas entre handlers, hooks y plugins sin usar globales.

## El problema que resuelve

```ts
// ❌ Mal: variable global
const db = new Database()

bot.when('visitas', async (ctx) => {
  const user = await db.touch(ctx.from)  // db es global
})
```

```ts
// ✅ Bien: inyectada
bot.provide('db', new Database())

bot.when('visitas', async (ctx) => {
  const user = await ctx.tools.db.touch(ctx.from)  // db está en ctx.tools
})
```

## Cómo funciona

### 1. Registrar una herramienta

```ts
bot.provide('db', {
  users: new Map(),
  async touch(jid: string) {
    const u = this.users.get(jid) ?? { visits: 0 }
    u.visits++
    this.users.set(jid, u)
    return u
  },
})
```

`bot.provide(name, value)` devuelve `this`, así que las llamadas se pueden
encadenar:

```ts
bot
  .provide('db', myDatabase)
  .provide('cache', myCache)
```

### 2. Usarla en cualquier handler

```ts
bot.when('visitas', async (ctx) => {
  const db = ctx.tools.db
  const user = await db.touch(ctx.from)
  await ctx.reply(`📊 You have visited ${user.visits} times.`)
})
```

### 3. También disponible en hooks y plugins

```ts
bot.before('message', async (ctx, next) => {
  const db = ctx.tools.db
  await db.touch(ctx.from)
  await next()
})
```

El `install(ctx)` de un plugin también recibe `ctx.tools`, así que los
plugins pueden consumir herramientas registradas en otro lugar (o
registrar las suyas con `bot.provide`).

## Múltiples herramientas

```ts
bot.provide('db', myDatabase)
bot.provide('cache', myCache)
bot.provide('api', myApiClient)

bot.when('test', async (ctx) => {
  await ctx.tools.db.query(/* ... */)
  await ctx.tools.cache.get(/* ... */)
  await ctx.tools.api.fetch(/* ... */)
})
```

## Siguientes pasos

- [Plugins](./plugins) — accede a herramientas desde un plugin
- [Scheduler](./scheduler) — tareas programadas
