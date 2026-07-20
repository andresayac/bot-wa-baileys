# Flujo de registro

Un flujo completo de registro con captura, validación y confirmación.

## El flujo

```js
const { Bot, flow } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

const registro = flow('registrar')
  // 1. Saludo
  .say('📝 *Vamos a registrarte*')

  // 2. Pedir nombre (capturar respuesta)
  .say('¿Cuál es tu nombre?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('nombre', ctx.body)
  })

  // 3. Pedir email (con validación)
  .say('¿Cuál es tu email?', { capture: true })
  .validate((body) => {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
    return ok ? true : '❌ Email inválido. Intenta de nuevo.'
  })
  .do(async (ctx, { state }) => {
    state.set('email', ctx.body)
  })

  // 4. Confirmar
  .say(async (ctx, { state }) => {
    return [
      '✅ *Registro completado!*',
      '',
      `👤 Nombre: ${state.get('nombre')}`,
      `📧 Email: ${state.get('email')}`,
    ].join('\n')
  })
  .end()

bot.use(registro)

bot.start()
```

## Cómo funciona

1. El usuario envía "registrar"
2. El bot dice "📝 Vamos a registrarte"
3. El bot pregunta "¿Cuál es tu nombre?" y **espera** la respuesta
4. El `do` guarda el nombre en `state`
5. El bot pregunta "¿Cuál es tu email?" y **espera**
6. El `validate` revisa si es un email válido
   - Si es válido → continúa
   - Si no → envía "❌ Email inválido" y **repite el paso**
7. El `do` guarda el email
8. El bot muestra el resumen con nombre y email

## Añadir más campos

```js
const registro = flow('registrar')
  .say('📝 *Registro*')
  .say('¿Nombre?', { capture: true })
  .do(async (ctx, { state }) => state.set('nombre', ctx.body))
  .say('¿Edad?', { capture: true })
  .validate((body) => {
    const edad = parseInt(body)
    if (isNaN(edad) || edad < 1 || edad > 120) {
      return '❌ Edad inválida. Debe ser un número entre 1 y 120.'
    }
    return true
  })
  .do(async (ctx, { state }) => state.set('edad', parseInt(ctx.body)))
  .say('¿Ciudad?', { capture: true })
  .do(async (ctx, { state }) => state.set('ciudad', ctx.body))
  .say(async (ctx, { state }) => {
    return [
      '✅ *Registro completado!*',
      '',
      `👤 ${state.get('nombre')}, ${state.get('edad')} años`,
      `📍 ${state.get('ciudad')}`,
    ].join('\n')
  })
  .end()
```

## Guardar en base de datos

```js
bot.provide('db', {
  users: new Map(),
  async save(jid, data) {
    this.users.set(jid, data)
  },
})

const registro = flow('registrar')
  .say('¿Nombre?', { capture: true })
  .do(async (ctx, { state }) => state.set('nombre', ctx.body))
  .say('¿Email?', { capture: true })
  .validate((body) => body.includes('@') ? true : '❌ Email inválido')
  .do(async (ctx, { state }) => {
    state.set('email', ctx.body)
    // Guardar en DB
    const db = ctx.tools.db
    await db.save(ctx.from, {
      nombre: state.get('nombre'),
      email: state.get('email'),
    })
  })
  .say('✅ ¡Registrado!')
  .end()
```

## Siguientes pasos

- [Flujo de compra](./flujo-compra) — branching con choose
- [Flujos](/es/guide/flujos) — guía completa del DSL