---
layout: home

hero:
  name: bot-wa-baileys
  text: Framework para bots de WhatsApp
  tagline: Flujos, hooks, plugins y sub-APIs sobre Baileys 7. Simple, declarativo, en TypeScript.
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
  - title: Sub-APIs tipadas
    details: |
      bot.groups, bot.profile, bot.privacy, bot.chats, bot.presence —
      acceso tipado a toda la API de WhatsApp.
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
