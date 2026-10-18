# Flujos conversacionales

Los flujos son conversaciones multi-paso. `flow(trigger)` te da un DSL
encadenable que compila a una conversación async real por debajo: el bot
pregunta, el usuario responde, el bot guarda la respuesta en `c.state` y
continúa.

## Flujo básico

```ts
import { flow } from '@bot-wa/core'

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
flow('x').say('Pensando…').say('¡Listo!', { delay: '2s' }) // pausa 2 s antes de enviar
```

`{ delay }` (`'500ms'`, `'2s'`, `'1m'` o milisegundos) también funciona en
`ask`, `choose` (cuarto argumento, después de la clave de estado:
`.choose(prompt, opciones, 'choice', { delay: '1s' })`) y `media`. Es una pausa
antes del paso, independiente del
[indicador de escritura](./mensajes#indicador-de-escritura-y-pausas) que
`BotConfig.typing` añade a cada `.say`. Para pausar entre pasos sin enviar nada, usa
`.delay('3s')`. Un delay inválido, o mayor de lo que admite un timer de
Node (2^31 − 1 ms, unos 24 días), lanza un error al construir el flow.
Terminar la conversación (`/reset`, un reemplazo, `bot.stop()`) cancela el
delay pendiente.

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

#### Validación con schema (compatible con zod)

`schema` acepta cualquier objeto con un método `safeParse()`: zod,
adaptadores de valibot o tu propio validador. El core no depende de zod. En
`c.state` se guarda el valor **parseado**, y una respuesta rechazada vuelve
a preguntar con `otherwise` o, si no está definido, con el mensaje del
primer issue del schema (o con el mensaje integrado y traducible
`core.wait.invalid` si el schema no da ninguno, ver
[i18n](./i18n#mensajes-internos)):

```ts
import { z } from 'zod'

flow('registro')
  .ask('¿Cuántos años tienes?', 'edad', { schema: z.coerce.number().min(18, 'Debes ser mayor de edad') })
  .say((_ctx, c) => `El año que viene tendrás ${c.state.edad + 1}`)   // c.state.edad: number
```

`schema` corre después de `validate` y comparte su presupuesto de
`retries`. También funciona en conversaciones: `await c.ask(q, { schema })`
y `await c.waitText({ schema })` resuelven con el valor parseado.

### do — ejecutar una acción, sin mensaje

```ts
flow('x').do((ctx, c) => {
  c.state.registeredAt = Date.now()
})
```

### media — enviar media

```ts
flow('x')
  .media('image', 'https://picsum.photos/400/300', 'Nuestro menú')
  .media('document', './factura.pdf', 'Tu factura', { filename: 'factura.pdf' })
  .media('voice', './saludo.ogg')
  .media('location', { lat: 4.71, lng: -74.07 }, 'Bogotá')
```

`kind` es `image`, `video`, `audio`, `voice`, `document`, `sticker` o
`location`. La fuente puede ser una URL, una ruta, un `Buffer` o una
función `(ctx, c) => fuente` calculada en tiempo de ejecución. El cuarto
argumento acepta `delay` y opciones por tipo (`filename`, `ptv`,
`gifPlayback`, `pack`, `author`). La forma antigua de dos argumentos,
`.media(fuente, caption?)`, sigue enviando una imagen.

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

`then` también puede ser un flow completo (se ejecuta en línea y vuelve,
como `.use()` más abajo). Una opción con `goto` sale del flow actual hacia
otra conversación; así se construye una opción de "volver al menú
principal":

```ts
const menu = flow('menu').choose('Menú principal', { pedidos: 'Pedidos', ayuda: 'Ayuda' })

flow('ayuda').choose('Temas de ayuda', {
  envios: { label: 'Envíos', then: flow('envios').say('Enviamos en 48 h') },
  volver: { label: '⬅️ Volver', goto: menu },
})
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
  provider: new BaileysProvider({ session: 'my-bot' }),
  conversation: { timeoutMessage: '⏰ Session expired due to inactivity.' },
})
```

Un sub-flujo `then:` usa su propio `.timeout()`; **no** hereda el del
flujo padre. Si no tiene, se aplica el `conversation.timeout` del bot (o el
valor por defecto de 5 minutos).

### goto — saltar a otro flow

```ts
flow('a').say('Redirecting you...').goto('b')
```

El destino también tiene que estar registrado (`bot.use(flow('b')...)` o
`bot.conversation('b', ...)`); `bot.lint()` avisa de un `goto` a un flujo
inexistente con `goto-target-missing`.

### use — ejecutar un sub-flow y volver

```ts
const direccion = flow('direccion').ask('¿Calle?', 'calle').ask('¿Ciudad?', 'ciudad')

flow('pedido')
  .say('Datos de envío')
  .use(direccion)
  .say((_ctx, c) => `Envío a ${c.state.calle}, ${c.state.ciudad}`)
```

`.use(subFlow)` ejecuta otro flow en línea y luego sigue con el paso
siguiente. El sub-flow comparte `c.state`, así que lo que captura se ve en
el padre (y con tipos, ver [Estado tipado](#estado-tipado)). El sub-flow se
copia al llamar a `.use()`; los cambios posteriores a su builder no afectan
al padre. Un `c.retry()` en un paso del padre después de `.use()` vuelve a
ejecutar el sub-flow cuando su última espera estaba ahí.

### guard — detener si no se cumple una condición

```ts
flow('admin')
  .guard((ctx) => admins.includes(ctx.sender), '⛔ Este menú es solo para admins')
  .guard(() => esHorarioLaboral(), { redirect: 'fuera-de-horario' })
  .say('Menú de admin')
```

Si el predicado (síncrono o async) devuelve un valor falsy, el flow se
detiene: con un mensaje (un string o `(ctx, c) => string`) lo envía y termina
la conversación; sin mensaje termina en silencio; con `{ redirect, message? }`
envía el mensaje (si lo hay) y salta a otra conversación como `goto` (también
acepta un `FlowBuilder` como destino).
`bot.lint()` revisa los destinos de `redirect` igual que los de `goto`.

### persistent — sobrevive reinicios

```ts
flow('registrar').persistent().ask('Name?', 'name').say('Done')
```

`.persistent()` hace un checkpoint después de cada paso, pero eso solo
sobrevive a un **reinicio del proceso** si el store tiene un archivo detrás:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  storeConfig: { file: './store.json' }, // o un store real — ver la guía de Store
})
```

Un flow necesita un id estable para poder hacer checkpoint. Un trigger de
tipo string ya provee uno; si construiste el flow con un trigger de
regex/predicado, dale un id explícito con `.id('registrar')`.

### scope — restringir a dm / group / all

```ts
flow('soporte').scope('dm').ask('Describe your issue', 'issue')
```

### form — varios campos tipados en un paso

`.form(definicion, opts)` recoge campos de texto, número, email, fecha, selección,
selección múltiple y opt-in con validación. En la Cloud API de WhatsApp se envía
como un WhatsApp Flow nativo; en el resto, el bot pregunta campo por campo. Más
en [Formularios (WhatsApp Flows)](./formularios).

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

### Estado tipado

`.ask()`, `.choose()` y `.use()` añaden al tipo del flow las keys que
capturan, así que `c.state` queda tipado sin casts. Con `schema`, la key
toma el tipo de salida del schema; sin él es `string`, y `.choose()` da la
unión de las keys de las opciones. Declara de antemano el estado que el
flow espera con `flow<S>()`, y obtén el tipo de un builder con
`FlowStateOf<typeof f>`:

```ts
const f = flow<{ plan: 'free' | 'pro' }>('alta')
  .ask('¿Edad?', 'edad', { schema: z.coerce.number() })
  .choose('¿Cómo pagas?', { tarjeta: 'Tarjeta', efectivo: 'Efectivo' }, 'pago')
  .do((_ctx, c) => {
    c.state.edad   // number
    c.state.pago   // 'tarjeta' | 'efectivo'
    c.state.plan   // 'free' | 'pro'
  })
```

Una key que no es un literal de string no se puede seguir; esos valores
quedan accesibles como `unknown`.

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

`c.waitMedia(tipos?, opts?)` espera `image`, `video`, `audio`, `document` o
`sticker` por defecto; las notas de voz, solo si las pides
(`c.waitMedia(['voice'])` o `c.waitMedia(['audio', 'voice'])`). Resuelve con el
mensaje; descarga sus bytes con
[`loadMediaOf()`](./mensajes#acceder-al-contenido-del-media).

## `ctx` en `bot.conversation()` es un `MessageContext` completo

El segundo argumento de un handler de `bot.conversation()` es el
`MessageContext` completo, tipado a través de `DefaultTools`: `ctx.tools`
(incluidas augmentations como `ctx.tools.ai` o `ctx.tools.nlu`),
`ctx.user`, `ctx.handoff()`, `ctx.photo`, `ctx.poll`, `ctx.react`,
`ctx.quote`, `ctx.senderInfo`... Sin casts.

```ts
bot.conversation('foto', async (c, ctx) => {
  const img = await c.waitMedia(['image'], { timeout: '2m' })
  await ctx.react('📸')
  await ctx.reply(`Recibida (${img.type})`)
})
```

El tipo público es `ConversationHandler<TTools = DefaultTools>`; los
handlers tipados con el antiguo `ConversationFn<ConversationControls>`
siguen compilando. En el DSL (`flow().do((ctx, c) => ...)`) `ctx` sigue
siendo un `RuntimeMessage`; ahí usa `userOf(ctx)` y `bot.handoff(ctx.from)`.

## `c.retry()`: repetir la última espera

`c.retry(message?)` repite la espera más reciente (`ask`, `waitText`,
`waitMedia`, `choose`, `waitAny`) con las mismas opciones (`validate`,
`filter`, `timeout`, `otherwise`, `retries`). Antes de esperar reenvía la
pregunta del `ask` o el menú del `choose`, o `message` en su lugar. En
`choose`, `message` solo reemplaza el encabezado; las opciones numeradas se
mantienen. `waitText`/`waitMedia`/`waitAny` no tienen pregunta, así que solo
envían `message` si lo pasas. `c.retry('')` vuelve a esperar sin enviar
nada.

En una conversación async devuelve el valor nuevo:

```ts
bot.conversation('ahorcado', async (c, ctx) => {
  let letra = await c.ask('Escribe una letra')
  while (letra.length !== 1) letra = await c.retry('❌ Solo una letra')
  await ctx.reply(`✅ ${letra}`)
})
```

Para `waitMedia`/`waitAny`, tipa el valor: `await c.retry<RuntimeMessage>('Envía otra foto')`.

En un **paso de flujo** (`.do()` o una acción `then` de `.choose()`) cuya
última espera es de un paso anterior, `c.retry()` rebobina el flujo hasta
ese paso: lo vuelve a preguntar (con `message` en lugar de la pregunta, si
lo pasas), guarda la respuesta nueva en su clave de estado y vuelve a
ejecutar los pasos siguientes, incluido el `.do()` que lo llamó. Lanza una
señal de control síncrona, así que el código posterior del paso no corre
(como con `c.end()`):

```ts
flow('juego')
  .ask('Escribe una letra', 'letra')
  .do((_ctx, c) => {
    if (String(c.state.letra).length !== 1) c.retry('❌ Solo una letra')
  })
  .say((_ctx, c) => `✅ ${c.state.letra}`)
```

- Funciona en sub-flujos (`then: subFlow`, `.use(subFlow)`) y en flujos `.persistent()`
  reanudados tras un reinicio. Si la espera se hizo en el mismo `.do()`
  (`await c.waitText()`), reintenta en el sitio.
- **Límite:** cada `c.retry()` cuenta como un intento inválido de esa
  espera, sumado a los rechazos de `validate`. Al llegar a `retries` (por
  defecto 3) se lanza `RetriesExceeded` y la conversación termina con
  `retriesMessage`. Cada espera nueva empieza en cero. Para reintentos
  ilimitados usa `retries: Infinity`.
- Sin una espera previa falla con `RetryUnavailableError` (va al evento
  `'error'` y se envía `errorMessage`).
- Haz siempre `await` (o `return`). Una conversación tiene un solo hueco de
  espera pendiente: una espera nueva iniciada mientras un retry sin `await`
  sigue esperando falla con `ConcurrentWaitError`.
- No lo llames dentro de `validate` (ahí devuelve un string de error). Si
  envuelves un paso en `try/catch`, relanza `ConversationError`
  (`if (e instanceof ConversationError) throw e`).

## `c.idle()`: inactividad dentro de una conversación

```ts
bot.conversation('juego', async (c, ctx) => {
  c.idle('2m', async () => {
    await ctx.reply('⏰ Te desconecté por inactividad')
    c.end('👋 ¡Hasta luego!')          // termina la conversación (envía la despedida)
  })
  await ctx.reply('Escribe una letra')
  const letra = await c.waitText({ timeout: '10m' })
  c.idleClear()                         // lo desarma cuando respondió
})
```

- El callback corre una vez cuando pasa `duración` (`'30s'`, `'2m'`, `'1h'`,
  `'1d'`, `'10 minutes'` o ms, hasta unos 24,8 días) sin mensajes del
  usuario de la conversación. Cada mensaje entrante lo reprograma, aunque
  la espera pendiente lo filtre; tras dispararse, el siguiente mensaje lo
  vuelve a armar.
- Llamar otra vez a `c.idle()` reemplaza el anterior. Se desarma al
  terminar la conversación, con `/reset` o `bot.abortConversation`, con
  `goto` y con `bot.stop()`, así que no deja temporizadores colgados.
- Dentro del callback: `c.end(despedida?)` o `c.goto('menu')` terminan o
  redirigen la conversación en la espera pendiente. `c.retry(msg?)` reenvía
  la pregunta pendiente como recordatorio y sigue esperando la misma
  respuesta (cuenta para `retries`; para un recordatorio que no cuente, usa
  `ctx.reply`). Si no hay espera pendiente no hace nada. El callback no
  puede iniciar esperas nuevas. Otros errores van al evento `'error'` y la
  conversación sigue.
- Es independiente del `timeout` de la espera, que termina la conversación
  con `timeoutMessage`. Funciona en los `.do()` de un flujo y sigue activo
  entre pasos. Los comandos que atiende el dispatcher no cuentan como
  actividad. No se persiste (no sobrevive a un reinicio ni a un `goto`).

## `bot.onIdle()`: inactividad por chat

```ts
bot.onIdle('10m', async (ctx, { chatId, idleMs, lastActivityAt }) => {
  await ctx.reply('¿Sigues ahí? 👀')       // ctx = el último mensaje procesado de ese chat
})
const off = bot.onIdle('1h', (ctx) => bot.sendText(ctx.from, 'Cerramos tu sesión por inactividad'))
off()                                       // deja de vigilar y cancela sus temporizadores
bot.clearIdle(chatId)                       // cancela los temporizadores de un chat (de todos sin argumento)
```

- Por chat (`ctx.from`); en un grupo cuenta cualquier participante.
- Se dispara una vez por periodo, contado desde el último mensaje entrante
  que el bot terminó de procesar. Cada mensaje nuevo lo reprograma y lo
  vuelve a armar.
- Los mensajes descartados antes de terminar el pipeline (un hook
  `before('message')` que aborta, el filtro `groupMode`) no cuentan como
  actividad.
- `bot.stop()` lo cancela todo; los registros sobreviven a stop/start.
- [Handoff humano](./handoff): los temporizadores de un chat en handoff se
  cancelan y quedan suspendidos (sus mensajes no los rearman) hasta el
  resume, también para los handoffs restaurados del store al arrancar.
- Los errores del handler (síncronos o async) van al evento `'error'` con
  el `ctx`.
- Usa el `Scheduler` del bot. Una duración inválida (≤ 0, no finita o mayor
  que 2^31 − 1 ms) lanza `RangeError`. Dentro de un plugin, pasa el
  unsubscribe devuelto a `ctx.onDispose`.

## Revisar tus flujos

`bot.describe()` dibuja tus flujos como un diagrama Mermaid y `bot.lint()`
avisa de `goto` rotos, pasos inalcanzables, triggers duplicados y más. Ver
[Inspeccionar y validar flujos](./inspeccion-flujos).

## Siguientes pasos

- [Ejemplos de flujos](/es/ejemplos/flujo-registro) — recetas completas
- [Triggers especiales](./triggers) — WELCOME, tipos de mensaje y CALL
- [Hooks](./hooks) — interceptar mensajes
- [Plugins](./plugins) — empaquetar funcionalidad
