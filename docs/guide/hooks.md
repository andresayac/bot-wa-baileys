# Hooks (Middleware)

Hooks are functions that run **before** or **after** an event. Like Express
middleware: intercept, modify, decide whether to continue.

## The 3 types

```mermaid
flowchart LR
    A[Event] --> B[before hooks]
    B --> C[Handler / Flow / Send]
    C --> D[after hooks]
    C -.->|error| E[onError hooks]
```

### before — before processing

```ts
bot.before('message', async (ctx, next) => {
  console.log('📥', ctx.from, ':', ctx.body)
  await next()  // ← important: call next() to continue
})
```

::: warning Don't forget next()
If you don't call `next()` (or call `ctx.abort()`), the message **is not
processed further**. Useful for blocking messages (rate limiting, filters).
:::

### after — after processing

```ts
bot.after('message', async (ctx) => {
  console.log('📤 processed:', ctx.type)
})
```

### onError — when something fails

```ts
bot.onError('message', async (ctx, error) => {
  console.error('💥 error:', error)
  if (ctx) await ctx.reply('😅 An error occurred. Try again.')
})
```

There's also a generic `bot.hook(event, phase, handler, priority?)` if you
need to register a phase dynamically instead of calling `before`/`after`/
`onError` directly.

## Use cases

### Logging

```ts
bot.before('message', async (ctx, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${ctx.from}: ${ctx.body}`)
  await next()
})
```

### Rate limiting

```ts
const counts = new Map()

bot.before('message', async (ctx, next) => {
  const now = Date.now()
  let entry = counts.get(ctx.from)

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + 60000 }
    counts.set(ctx.from, entry)
  }

  entry.count++
  if (entry.count > 10) {
    await ctx.reply('⏳ Too many messages. Wait a minute.')
    ctx.abort()
    return
  }

  await next()
})
```

### Filter groups

```ts
bot.before('message', async (ctx, next) => {
  if (ctx.isGroup) return
  await next()
})
```

### Block users

```ts
const blocked = new Set(['57300XXXXXXX@s.whatsapp.net'])

bot.before('message', async (ctx, next) => {
  if (blocked.has(ctx.from)) {
    ctx.abort()
    return
  }
  await next()
})
```

## Transform or block outgoing messages

`'send'` fires on **every** outbound send, whether it comes from
`ctx.reply`/`ctx.photo`/... or from `bot.send`/`bot.sendText`. The payload
is `{ chatId, content, options }` — `content` is the transport-neutral
`OutboundContent` (`{ kind: 'text', text }`, `{ kind: 'image', media,
caption }`, ...); mutate it to transform a message, or abort to skip the
send entirely:

```ts
bot.before('send', async (payload, next) => {
  console.log('📤 sending to', payload.chatId, payload.content)
  await next()
})
```

## abort() — stop the pipeline

```ts
bot.before('message', async (ctx, next) => {
  if (someCondition) {
    ctx.abort()
    return
  }
  await next()
})
```

## Priority

```ts
bot.before('message', handler, 10)  // higher = runs first
bot.before('message', handler, 0)   // default
```

## Available events

| Event | When |
|---|---|
| `message` | The main pipeline — an incoming message being processed |
| `send` | Any outbound message, from a `ctx` reply helper or `bot.send*` |

Provider-level connection events (`qr`, `ready`, `connection`, ...) are
plain `bot.on(...)` listeners, not hook phases — see [Core concepts](./concepts).

## Next steps

- [Plugins](./plugins) — package hooks for reuse
- [Example: rate limiter](/examples/rate-limiter) — full plugin
