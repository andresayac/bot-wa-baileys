# Flujos conversacionales

Los flujos son conversaciones multi-paso. El bot pregunta, el usuario
responde, el bot guarda la respuesta y continúa. Son la forma más poderosa
de crear conversaciones estructuradas.

## Flujo básico

```js
const { flow } = require('@bot-wa/bot-wa-baileys')

const saludo = flow('hola')
  .say('👋 ¡Hola! ¿Cómo te llamas?', { capture: true })
  .say(async (ctx, { state }) => {
    return `¡Mucho gusto, ${state.get('name')}!`
  })
  .do(async (ctx, { state }) => {
    state.set('name', ctx.body)
  })
  .end()

bot.use(saludo)
```

Cuando alguien envía "hola", el flujo se activa:
1. El bot dice "👋 ¡Hola! ¿Cómo te llamas?"
2. `capture: true` espera la respuesta del usuario
3. El `do` guarda el nombre en `state`
4. El bot responde con el nombre

## Los métodos del DSL

### say — enviar un mensaje

```js
flow.say('texto')                              // texto fijo
flow.say('texto', { capture: true })           // esperar respuesta
flow.say(async (ctx, { state }) => `Hola`)    // texto dinámico
flow.say([{ media: url, caption: 'foto' }])    // media
```

### do — ejecutar una acción

```js
flow.do(async (ctx, { state }) => {
  state.set('clave', ctx.body)    // guardar en state
  // cualquier lógica: llamar API, validar, etc.
})
```

### validate — validar la entrada

```js
flow
  .say('¿Email?', { capture: true })
  .validate((body) => {
    if (body.includes('@')) return true
    return '❌ Email inválido, intenta de nuevo'
  })
```

Si la validación falla, el bot envía el mensaje de error y **repite el paso**.

### choose — branching (menú)

```js
flow
  .say('¿Qué quieres comprar?\n1️⃣ Electrónica\n2️⃣ Ropa', { capture: true })
  .choose({
    '1': flow().say('📱 iPhone 15 — $999').end(),
    '2': flow().say('👕 Camiseta — $25').end(),
  })
```

El usuario escribe "1" o "2" y el flujo toma ese camino.

### timeout — expiración por inactividad

```js
flow
  .say('Describe tu problema', { capture: true })
  .timeout(60000, '⏰ Tu sesión caducó por inactividad')
```

Si el usuario no responde en 60 segundos, el flujo termina con ese mensaje.

### fallback — cuando no entiende

```js
flow
  .say('Describe tu problema', { capture: true })
  .fallback(async (ctx) => {
    await ctx.reply('🤔 No entendí eso. Por favor describe tu problema.')
  })
```

Si el usuario envía algo que no coincide con lo esperado, se ejecuta el fallback.

### persistent — sobrevive reinicios

```js
flow.persistent()
```

El estado del flujo se guarda en el store. Si el bot se reinicia, el flujo
continúa donde quedó (requiere un store persistente).

## State — memoria entre pasos

Cada flujo tiene un `state` (estado) por usuario. Puedes guardar y leer datos:

```js
flow
  .say('¿Nombre?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('nombre', ctx.body)
  })
  .say('¿Email?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('email', ctx.body)
  })
  .say(async (ctx, { state }) => {
    return `✅ ${state.get('nombre')} <${state.get('email')}>`
  })
```

### Métodos de state

```js
state.set('clave', valor)      // guardar
state.get('clave')              // leer
state.has('clave')             // ¿existe?
state.delete('clave')          // borrar
state.clear()                  // limpiar todo
state.all()                    // todo como objeto
```

## Ejemplo completo: registro

```js
const registro = flow('registrar')
  .say('📝 *Vamos a registrarte*')
  .say('¿Cuál es tu nombre?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('nombre', ctx.body)
  })
  .say('¿Cuál es tu email?', { capture: true })
  .validate((body) => {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
    return ok ? true : '❌ Email inválido. Intenta de nuevo.'
  })
  .do(async (ctx, { state }) => {
    state.set('email', ctx.body)
  })
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
```

## Siguientes pasos

- [Ejemplos de flujos](/es/ejemplos/flujo-registro) — recetas completas
- [Hooks](./hooks) — interceptar mensajes
- [Plugins](./plugins) — empaquetar funcionalidad