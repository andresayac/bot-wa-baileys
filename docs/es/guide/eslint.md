# Plugin de ESLint

::: warning Experimental — aún no publicado en npm
`eslint-plugin-bot-wa` es privado: no está en npm y sus reglas pueden cambiar.
Úsalo desde el monorepo (`"eslint-plugin-bot-wa": "workspace:*"` en tus
`devDependencies`).
:::

`eslint-plugin-bot-wa` detecta en el código fuente los errores que ningún
linter genérico conoce: API v1 que ya no existe, un `runtime.enter()`
bloqueante, un `install()` de plugin async, triggers vacíos, esperas sin
timeout y estado por usuario en variables de módulo. Complementa a
[`bot.lint()` / `lintFlows()`](/es/guide/inspeccion-flujos) en tiempo de
ejecución, que revisan los flujos registrados (gotos rotos, pasos
inalcanzables, triggers duplicados).

Necesita **ESLint 9 o superior** (flat config) y Node >= 22. El `src/bot.js`
de cada plantilla de [`create-bot-wa`](/es/guide/inicio#crear-un-proyecto-con-create-bot-wa)
pasa el preset `strict` sin avisos (lo comprueban los tests del plugin).

## Uso

```js
// eslint.config.js
import botWa from 'eslint-plugin-bot-wa'

export default [
  botWa.configs.recommended,
]
```

O regla por regla:

```js
import botWa from 'eslint-plugin-bot-wa'

export default [
  {
    plugins: { 'bot-wa': botWa },
    rules: {
      'bot-wa/no-v1-api': 'error',
      'bot-wa/require-timeout-on-ask': ['error', { methods: ['ask', 'choose'], allowFlowTimeout: true }],
    },
  },
]
```

Las reglas son sintácticas y no necesitan información de tipos. Para archivos
TypeScript, combina el plugin con `typescript-eslint` (su parser).

## Presets

| Preset | Reglas |
| --- | --- |
| `configs.recommended` | Errores: `no-v1-api`, `no-await-runtime-enter`, `no-async-plugin-install`, `no-empty-trigger`. Avisos: `require-timeout-on-ask`, `prefer-ctx-user-over-global-state`. |
| `configs.strict` | Todas las reglas como error; `require-timeout-on-ask` revisa también `waitText`, `waitMedia`, `choose` y `waitAny`. |

## Reglas

### `bot-wa/no-v1-api`

Marca la API v1 / builderbot que no existe en v2 e indica el reemplazo en el
mensaje:

| v1 | Usa en su lugar |
| --- | --- |
| `.addAnswer()` | `flow(...).say(text)` / `.ask(text, 'stateKey')` |
| `.addAction()` | `.do(async (ctx, c) => { ... })` |
| `{ capture: true }` | `.ask(text, 'stateKey')` en un flujo o `await c.ask(text)` en una conversación |
| `flowDynamic()` | `ctx.reply(...)` o un paso `.say((ctx, c) => ...)` |
| `gotoFlow()` | `.goto('flowName')` o `c.goto('flowName')` |
| `endFlow()` | volver del paso, o `c.end(message)` |

```js
addKeyword('hola').addAnswer('¿Tu nombre?', { capture: true })   // reported
flow('hola').ask('¿Tu nombre?', 'name', { timeout: '5m' })         // ok
```

Sin opciones.

### `bot-wa/no-await-runtime-enter`

`ConversationRuntime.enter()` resuelve cuando la conversación **termina**.
Hacerle `await` en un handler bloquea la cola FIFO del chat, así que el mensaje
que espera la conversación nunca se despacha. La regla marca
`await runtime.enter(...)`, `return runtime.enter(...)` (el dispatcher espera
la promesa devuelta), una arrow function cuyo cuerpo es `runtime.enter(...)` y
`await runtime.enter(...).catch(...)` (también `.then` / `.finally`).

```js
await runtime.enter(handle, msg)                                     // reported
void runtime.enter(handle, msg).catch((err) => log.error({ err }))   // ok
```

Opción: `{ receiverPattern: string }`, el código de una regex que debe cumplir
el nombre del receptor (por defecto `runtime$`, sin distinguir mayúsculas).

### `bot-wa/no-async-plugin-install`

`Plugin.install()` debe ser síncrono: `bot.plug()` no lo espera, así que el
bot arranca antes de que un `install` async termine y su rechazo solo llega al
evento `'error'` (en versiones anteriores del core era un unhandled rejection
que tumbaba el proceso). TypeScript ya rechaza un `install` async al compilar
(`PluginSpec.install` devuelve `void | SyncInstallError`); la regla cubre
JavaScript y los escapes con `as any`. Revisa el objeto que se pasa a `definePlugin(...)`, cualquier
objeto literal con `name` e `install`, y las clases con un método `install`
que declaran un campo `name` o `implements Plugin`. Para inicialización async
usa el patrón lazy (resolver en el primer uso y reportar los errores de
configuración desde un warmup no fatal), como `LazyProvider` en `@bot-wa/ai`.

Sin opciones.

### `bot-wa/no-empty-trigger`

Un trigger vacío (`''`, `'   '`, un template literal vacío, `[]`, `['']`,
`{ pattern: '' }`) no coincide con ningún mensaje real o, con `contains`,
coincide con todos. Se revisa en `flow(...)` / `addKeyword(...)`,
`bot.when(...)` y la opción `trigger` de `bot.conversation(name, fn, { trigger })`.

Sin opciones.

### `bot-wa/require-timeout-on-ask`

Toda espera de respuesta debería tener timeout, para que una conversación
abandonada no se quede abierta (capturando los mensajes de ese usuario) para
siempre.

- DSL de flujos: `.ask(text, key, { timeout })`, o un `.timeout(...)` en
  cualquier punto de la misma cadena `flow(...)` (salvo con
  `allowFlowTimeout: false`). El `.choose(...)` de un flujo no tiene opciones
  por paso, así que necesita el `.timeout()` de la cadena.
- Conversaciones: `c.ask(text, { timeout })` y, si están en `methods`,
  `c.waitText({ timeout })`, `c.waitMedia(types, { timeout })`,
  `c.choose(prompt, options, { timeout })` y `c.waitAny({ timeout })`.
- Si el argumento de opciones no es un objeto literal (una variable, una
  llamada) o contiene un spread, la regla no puede ver su contenido y no avisa.

Opciones: `{ methods?: ('ask' | 'waitText' | 'waitMedia' | 'choose' | 'waitAny')[], allowFlowTimeout?: boolean }`
(por defecto `['ask']` y `true`).

### `bot-wa/prefer-ctx-user-over-global-state`

Marca el `globalState` de v1 y los `Map` u objetos **de módulo** indexados por
`ctx.from`, `ctx.sender` o `ctx.senderId`
(`users.get/set/has/delete(ctx.from)`, `scores[ctx.sender]`). Ese estado se
pierde al reiniciar, crece sin límite y no se comparte entre réplicas. Usa
[`ctx.user`](/es/guide/datos-usuario)
(`await ctx.user.ns('feature').set(key, value)`) para los datos por usuario y
`c.state` para los datos de la conversación.

Opción: `{ contextNames: string[] }`, los nombres del parámetro de contexto
del handler (por defecto `['ctx']`).

## API

```ts
import botWa, { rules, configs, PLUGIN_NAMESPACE } from 'eslint-plugin-bot-wa'

botWa.meta      // { name: 'eslint-plugin-bot-wa', version, namespace: 'bot-wa' }
botWa.rules     // the six rules, by name without the 'bot-wa/' prefix
botWa.configs   // { recommended, strict } (flat configs)
```

Los módulos de las reglas también son exports con nombre: `noV1Api`,
`noAwaitRuntimeEnter`, `noAsyncPluginInstall`, `noEmptyTrigger`,
`requireTimeoutOnAsk` y `preferCtxUser`.

## Ver también

- [Inspeccionar y validar flujos](/es/guide/inspeccion-flujos)
- [Testing](/es/guide/testing)
- [README de `eslint-plugin-bot-wa`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/eslint-plugin)
