# Dependency Injection

Share tools between handlers, hooks and plugins without globals.

## The problem it solves

```js
// ❌ Bad: global variable
const db = new Database()

bot.when('visits', async (ctx) => {
  const user = await db.touch(ctx.from)  // db is global
})
```

```js
// ✅ Good: injected
bot.provide('db', new Database())

bot.when('visits', async (ctx) => {
  const user = await ctx.tools.db.touch(ctx.from)  // db is in ctx
})
```

## How it works

### 1. Register a tool

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

### 2. Use it in any handler

```js
bot.when('visits', async (ctx) => {
  const db = ctx.tools.db
  const user = await db.touch(ctx.from)
  await ctx.reply(`📊 You have visited ${user.visits} times.`)
})
```

### 3. Available in hooks and plugins too

```js
bot.before('message', async (ctx, next) => {
  const db = ctx.tools.db
  await db.touch(ctx.from)
  await next()
})
```

## Multiple tools

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

## Next steps

- [Plugins](./plugins) — access tools from a plugin
- [Scheduler](./scheduler) — scheduled tasks