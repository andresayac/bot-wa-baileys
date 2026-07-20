# Inyección de dependencias

La inyección de dependencias (DI) te permite compartir herramientas entre
handlers, hooks y plugins sin usar variables globales.

## El problema que resuelve

Sin DI, tendrías que usar globales o pasar todo manualmente:

```js
// ❌ Mal: variable global
const db = new Database()

bot.when('visitas', async (ctx) => {
  const user = await db.touch(ctx.from)  // db es global
})
```

Con DI, la herramienta vive en `ctx.tools`:

```js
// ✅ Bien: inyectada
bot.provide('db', new Database())

bot.when('visitas', async (ctx) => {
  const user = await ctx.tools.db.touch(ctx.from)  // db está en ctx
})
```

## Cómo funciona

### 1. Registrar una herramienta

```js
bot.provide('db', {
  users: new Map(),
  async touch(jid) {
    const u = this.users.get(jid) ?? { visits: 0 }
    u.visits++
    this.users.set(jid, u)
    return u
  },
})
```

### 2. Usarla en cualquier handler

```js
bot.when('visitas', async (ctx) => {
  const db = ctx.tools.db
  const user = await db.touch(ctx.from)
  await ctx.reply(`📊 Has visitado este bot ${user.visits} veces.`)
})
```

### 3. Disponible en hooks y plugins también

```js
bot.before('message', async (ctx, next) => {
  const db = ctx.tools.db
  await db.touch(ctx.from)  // contar visita en cada mensaje
  await next()
})
```

## Ejemplo: base de datos real

```js
const { Database } = require('quickmongo')
const db = new Database('mongodb://localhost/bot')

bot.provide('db', {
  async getUser(jid) {
    return await db.get(`user.${jid}`)
  },
  async setUser(jid, data) {
    await db.set(`user.${jid}`, data)
  },
  async addPoints(jid, points) {
    const user = await this.getUser(jid) ?? { points: 0 }
    user.points += points
    await this.setUser(jid, user)
    return user
  },
})

bot.when('puntos', async (ctx) => {
  const db = ctx.tools.db
  const user = await db.addPoints(ctx.from, 1)
  await ctx.reply(`🏆 Tienes ${user.points} puntos`)
})
```

## Múltiples herramientas

```js
bot.provide('db', myDatabase)
bot.provide('cache', myCache)
bot.provide('api', myApiClient)

bot.when('test', async (ctx) => {
  await ctx.tools.db.query(...)
  await ctx.tools.cache.get(...)
  await ctx.tools.api.fetch(...)
})
```

## Siguientes pasos

- [Plugins](./plugins) — cómo acceder a tools desde un plugin
- [Scheduler](./scheduler) — tareas programadas