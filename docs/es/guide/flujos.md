# Flujos conversacionales

Los flujos son conversaciones multi-paso. `flow(trigger)` te da un DSL
encadenable que compila a una conversación async real por debajo: el bot
pregunta, el usuario responde, el bot guarda la respuesta en `c.state` y
continúa.

## Flujo básico

```ts
import { flow } from '@bot-wa/bot-wa-baileys'

const greet = flow('hola')
  .ask('👋 Hello! What is your name?', 'name')
  .say((_ctx, c) => `Nice to meet you, ${c.state.name}!`)

bot.use(greet)
```

## Métodos del DSL

### say — enviar un mensaje

```ts
flow('x').say('text')                                // texto fijo
flow('x').say((_ctx, c) => `Hi ${c.state.name}`)      // dinámico, lee c.state
```

### ask — enviar un mensaje y esperar la respuesta

```ts
flow('x').ask('What is your name?', 'name')  // guarda la respuesta en c.state.name

flow('x').ask('Email?', 'email', {
  validate: (body) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email, try again',
  retries: 2,
  timeout: '2m',
})
```

Si `validate` devuelve un string de error, el bot lo envía de vuelta y
vuelve a preguntar (hasta `retries`, por defecto 3, antes de lanzar
`RetriesExceeded`).

### do — ejecutar una acción, sin mensaje

```ts
flow('x').do((ctx, c) => {
  c.state.registeredAt = Date.now()
})
```

### media — enviar media

```ts
flow('x').media('https://picsum.photos/400/300', 'caption')
```

### choose — branching (menú numerado)

```ts
flow('confirmar')
  .choose('Confirm your order?', { si: 'Yes', no: 'No' })
  .say((_ctx, c) => c.state.choice === 'si' ? '✅ Confirmed' : '❌ Cancelled')
```

`choose` envía un menú numerado construido a partir de `options`
(`Record<string, string>`, key → label) y guarda la **key** elegida en
`c.state.choice` — o en la key que le pases como tercer argumento:
`.choose(prompt, options, 'answer')`.

Cada opción puede en cambio llevar un sub-flow `then` que se ejecuta justo
después de elegirla; el control vuelve al flow padre después:

```ts
flow('menu')
  .choose('What are you interested in?', {
    ofertas: { label: 'Offers 🏷️', then: (_ctx, c) => { c.state.interest = 'ofertas' } },
    soporte: { label: 'Support 🛠️', then: (_ctx, c) => { c.state.interest = 'soporte' } },
  })
  .say((_ctx, c) => `Got it: ${c.state.interest}`)
```

### timeout — expiración por inactividad

```ts
flow('soporte')
  .timeout('60s')
  .ask('Describe your issue', 'issue')
```

`.timeout()` solo define la duración de espera — no recibe un argumento de
mensaje. El texto que se envía cuando expira se configura una sola vez, de
forma global, en el bot:

```ts
const bot = new Bot({
  conversation: { timeoutMessage: '⏰ Session expired due to inactivity.' },
})
```

### goto — saltar a otro flow

```ts
flow('a').say('Redirecting you...').goto('b')
```

### persistent — sobrevive reinicios

```ts
flow('registrar').persistent().ask('Name?', 'name').say('Done')
```

`.persistent()` hace un checkpoint después de cada paso, pero eso solo
sobrevive a un **reinicio del proceso** si el store tiene un archivo detrás:

```ts
const bot = new Bot({ storeConfig: { file: './store.json' } })
```

Un flow necesita un id estable para poder hacer checkpoint. Un trigger de
tipo string ya provee uno; si construiste el flow con un trigger de
regex/predicado, dale un id explícito con `.id('registrar')`.

### scope — restringir a dm / group / all

```ts
flow('soporte').scope('dm').ask('Describe your issue', 'issue')
```

## `c.state` — memoria entre pasos

`c.state` es un objeto plano y mutable, con alcance al flow en ejecución.
`.ask` y `.choose` escriben en él automáticamente; `.do` y la forma función
de `.say` lo leen y escriben directamente:

```ts
flow('x')
  .ask('Name?', 'name')
  .do((_ctx, c) => { c.state.name = c.state.name.trim() })
  .say((_ctx, c) => `Hi ${c.state.name}`)
```

## Ejemplo completo: registro

```ts
const register = flow('registrar')
  .say('📝 *Let us register you*')
  .ask('Name?', 'name')
  .ask('Email?', 'email', {
    validate: (body) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email',
  })
  .say((_ctx, c) => `✅ ${c.state.name} <${c.state.email}>`)

bot.use(register)
```

## Más allá del DSL

Para control de flujo arbitrario — loops, branching personalizado, llamar a
una API externa a mitad de la conversación — sáltate el DSL y escribe la
conversación directamente con `bot.conversation(name, async (c, ctx) =>
{...})`, usando `c.ask`/`c.waitText`/`c.waitMedia`/`c.choose`/`c.goto`/`c.end`.
Los flows construidos con `flow()` compilan exactamente a este runtime.

## Siguientes pasos

- [Ejemplos de flujos](/es/ejemplos/flujo-registro) — recetas completas
- [Hooks](./hooks) — interceptar mensajes
- [Plugins](./plugins) — empaquetar funcionalidad
