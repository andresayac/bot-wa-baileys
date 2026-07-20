# Dependency Injection

Share tools between handlers, hooks and plugins without globals.

## The problem it solves

```ts
// ❌ Bad: global variable
const db = new Database()

bot.when('visitas', async (ctx) => {
  const user = await db.touch(ctx.from)  // db is global
})
```

```ts
// ✅ Good: injected
bot.provide('db', new Database())

bot.when('visitas', async (ctx) => {
  const user = await ctx.tools.db.touch(ctx.from)  // db is in ctx.tools
})
```

## How it works

### 1. Register a tool

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

`bot.provide(name, value)` returns `this`, so calls can be chained:

```ts
bot
  .provide('db', myDatabase)
  .provide('cache', myCache)
```

### 2. Use it in any handler

```ts
bot.when('visitas', async (ctx) => {
  const db = ctx.tools.db
  const user = await db.touch(ctx.from)
  await ctx.reply(`📊 You have visited ${user.visits} times.`)
})
```

### 3. Available in hooks and plugins too

```ts
bot.before('message', async (ctx, next) => {
  const db = ctx.tools.db
  await db.touch(ctx.from)
  await next()
})
```

A plugin's `install(ctx)` also receives `ctx.tools`, so plugins can consume
tools registered elsewhere (or register their own with `bot.provide`).

## Multiple tools

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

## Next steps

- [Plugins](./plugins) — access tools from a plugin
- [Scheduler](./scheduler) — scheduled tasks
