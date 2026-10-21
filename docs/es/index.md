---
layout: home

hero:
  name: botmesh
  text: Framework de bots agnóstico de transporte
  tagline: Flujos, hooks, plugins y conversaciones detrás de un mismo IProvider — WhatsApp (Baileys / Cloud API) y Telegram, más Messenger, Instagram y Discord experimentales. Simple, declarativo, en TypeScript. En alpha, aún sin publicar en npm.
  actions:
    - theme: brand
      text: Empezar
      link: /es/guide/inicio
    - theme: alt
      text: Ver ejemplos
      link: /es/ejemplos/mensajes
    - theme: alt
      text: API Reference
      link: /api/

features:
  - title: Agnóstico de transporte
    details: |
      Un motor, muchos transportes. @botmesh/core corre cualquier IProvider:
      @botmesh/baileys (WhatsApp Web), @botmesh/meta (Cloud API oficial de
      WhatsApp), @botmesh/telegram — más providers experimentales de
      Messenger, Instagram y Discord.
    icon: 🚆
  - title: Declarativo
    details: |
      bot.when('hola', ctx => ctx.reply('¡Hola! 👋')) — sin boilerplate,
      sin callbacks anidados. Escribe lo que quieres que pase.
    icon: 💬
  - title: Flujos conversacionales
    details: |
      flow().say().ask().choose() compila a una conversación async real —
      validación, reintentos, branching y timeouts, sin un motor de pasos
      aparte.
    icon: 🔀
  - title: Hooks (middleware)
    details: |
      before / after / onError — intercepta cualquier evento, igual que
      Express. Logging, rate limiting, métricas, lo que quieras.
    icon: 🪝
  - title: Plugins
    details: |
      Empaqueta y reutiliza funcionalidad. Incluye slashCommandsPlugin
      listo para usar (/start, /help, /reset, /cancel, /id, /ping).
    icon: 🧩
  - title: Inyección de dependencias
    details: |
      bot.provide('db', myDb) — disponible como ctx.tools.db en cualquier
      handler. Sin globales, sin acoplamiento.
    icon: 🔌
  - title: Scheduler integrado
    details: |
      Cron, intervalos y delays con sintaxis humana.
      bot.every('30 seconds', ...) o bot.schedule('0 9 * * 1-5', ...).
    icon: ⏰
  - title: Stores conectables
    details: |
      MemoryStore por defecto; @botmesh/sqlite-store y @botmesh/redis-store
      para persistencia — o implementa el IStore genérico para lo que sea.
    icon: 📦
  - title: Media completo
    details: |
      Foto, video, audio, voz, sticker, archivo, ubicación, contacto,
      encuesta — todo con una sola línea.
    icon: 📸
  - title: TypeScript nativo
    details: |
      Tipos en todo el ecosistema. Autocompletado y type-checking en
      cada handler, flow y plugin.
    icon: 🔷
---

::: tip ¿Para quién es esto?
Si sabes JavaScript básico puedes crear un bot de WhatsApp funcional en
**menos de 5 minutos**. No necesitas saber TypeScript para empezar —
los ejemplos son copia-pega-listos.
:::
