---
layout: home

hero:
  name: botmesh
  text: Transport-Agnostic Bot Framework
  tagline: Flows, hooks, plugins and conversations behind one IProvider — WhatsApp (Baileys / Cloud API) and Telegram, plus experimental Messenger, Instagram and Discord. Simple, declarative, TypeScript. Alpha on npm — install with `@alpha`.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Examples
      link: /examples/messages
    - theme: alt
      text: API Reference
      link: /api/

features:
  - title: Transport-agnostic
    details: |
      One engine, many transports. @botmesh/core runs any IProvider:
      @botmesh/baileys (WhatsApp Web), @botmesh/meta (official WhatsApp
      Cloud API), @botmesh/telegram — plus experimental Messenger,
      Instagram and Discord providers.
    icon: 🚆
  - title: Declarative
    details: |
      bot.when('hi', ctx => ctx.reply('Hello! 👋')) — no boilerplate,
      no nested callbacks. Write what you want to happen.
    icon: 💬
  - title: Conversation flows
    details: |
      flow().say().ask().choose() compiles to a real async conversation —
      validation, retries, branching and timeouts, no separate step engine.
    icon: 🔀
  - title: Hooks (middleware)
    details: |
      before / after / onError — intercept any event, just like Express.
      Logging, rate limiting, metrics, anything.
    icon: 🪝
  - title: Plugins
    details: |
      Package and reuse functionality. Includes slashCommandsPlugin
      (/start, /help, /reset, /cancel, /id, /ping) out of the box.
    icon: 🧩
  - title: Dependency injection
    details: |
      bot.provide('db', myDb) — available as ctx.tools.db in any handler.
      No globals, no coupling.
    icon: 🔌
  - title: Built-in scheduler
    details: |
      Cron, intervals and delays with human syntax.
      bot.every('30 seconds', ...) or bot.schedule('0 9 * * 1-5', ...).
    icon: ⏰
  - title: Pluggable stores
    details: |
      MemoryStore by default; @botmesh/sqlite-store and @botmesh/redis-store
      for persistence — or implement the generic IStore for anything else.
    icon: 📦
  - title: Full media support
    details: |
      Photo, video, audio, voice, sticker, file, location, contact,
      poll — all with a single line.
    icon: 📸
  - title: TypeScript native
    details: |
      Types throughout the ecosystem. Autocomplete and type-checking on
      every handler, flow and plugin.
    icon: 🔷
---

::: tip Who is this for?
If you know basic JavaScript, you can build a working WhatsApp bot in
**under 5 minutes**. You don't need TypeScript to get started — the
examples are copy-paste-ready.
:::
