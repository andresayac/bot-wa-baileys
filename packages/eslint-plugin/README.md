# eslint-plugin-bot-wa

> **Privado (no se publica en npm todavía).** Vive en el monorepo de `@bot-wa`.

Reglas de ESLint específicas de `@bot-wa`: detectan en el código fuente los errores que ningún linter genérico conoce
(API v1 que ya no existe, `runtime.enter()` bloqueante, `install()` async, triggers vacíos, esperas sin timeout y estado
por usuario en variables globales). Complementa a `bot.lint()` / `lintFlows()` del core, que revisan los flujos en
tiempo de ejecución (gotos rotos, pasos inalcanzables, triggers duplicados…).

Requiere ESLint 9 o superior (flat config) y Node >= 22.

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

Para TypeScript, combínalo con `typescript-eslint` (las reglas son sintácticas: no necesitan información de tipos).

## Presets

| Preset | Contenido |
| --- | --- |
| `configs.recommended` | Errores: `no-v1-api`, `no-await-runtime-enter`, `no-async-plugin-install`, `no-empty-trigger`. Avisos: `require-timeout-on-ask`, `prefer-ctx-user-over-global-state`. |
| `configs.strict` | Todo como error; `require-timeout-on-ask` revisa también `waitText`, `waitMedia`, `choose` y `waitAny`. |

## Reglas

### `bot-wa/no-v1-api`

Marca la API v1 / builderbot que no existe en v2: `.addAnswer()`, `.addAction()`, `{ capture: true }`,
`flowDynamic()`, `gotoFlow()` y `endFlow()`. El mensaje indica el reemplazo (`flow().say/.ask/.do`, `ctx.reply`,
`.goto`, `c.end`).

```js
addKeyword('hola').addAnswer('¿Nombre?', { capture: true })   // ❌
flow('hola').ask('¿Nombre?', 'name', { timeout: '5m' })         // ✅
```

### `bot-wa/no-await-runtime-enter`

`ConversationRuntime.enter()` resuelve cuando la conversación **termina**: hacerle `await` (o devolver su promesa desde
el handler, o `await runtime.enter().catch()`) bloquea la cola FIFO del chat y el mensaje que la conversación espera
nunca llega. Lánzala sin esperarla.

```js
await runtime.enter(handle, msg)                               // ❌
void runtime.enter(handle, msg).catch((err) => log.error({ err }))   // ✅
```

Opción: `{ receiverPattern: string }` (regex del nombre del receptor; por defecto `runtime$`, sin distinguir mayúsculas).

### `bot-wa/no-async-plugin-install`

`Plugin.install()` debe ser síncrono: `bot.plug()` no lo espera, el bot sigue antes de que termine y su rechazo solo
llega al evento `'error'`. TypeScript ya lo rechaza al compilar (`PluginSpec.install` devuelve `void | SyncInstallError`);
la regla cubre JavaScript y los escapes con `as any`. Revisa el objeto de `definePlugin({...})`, cualquier objeto literal
con `name` + `install`, y clases con `install` que declaran `name` o `implements Plugin`. Para inicialización async usa el
patrón lazy (como `LazyProvider` en `@bot-wa/ai`).

### `bot-wa/no-empty-trigger`

Un trigger vacío (`''`, `'   '`, `[]`, `['']`, `{ pattern: '' }`) no coincide con nada (o, con `contains`, con todo).
Se revisa en `flow()` / `addKeyword()`, `bot.when()` y el `trigger` de `bot.conversation(name, fn, { trigger })`.

### `bot-wa/require-timeout-on-ask`

Toda espera de respuesta debe tener timeout para que una conversación abandonada termine.

- En flujos: `.ask(texto, clave, { timeout })` o un `.timeout(...)` en la misma cadena.
- En conversaciones: `c.ask(texto, { timeout })` (y, si se configuran, `c.waitText`, `c.waitMedia`, `c.choose`, `c.waitAny`).
- Si las opciones no son un objeto literal (una variable, un spread), la regla no puede verlas y no avisa.

Opciones: `{ methods?: ('ask' | 'waitText' | 'waitMedia' | 'choose' | 'waitAny')[], allowFlowTimeout?: boolean }`
(por defecto `['ask']` y `true`).

### `bot-wa/prefer-ctx-user-over-global-state`

Marca `globalState` (v1) y los `Map`/objetos **de módulo** indexados por `ctx.from`, `ctx.sender` o `ctx.senderId`
(`users.set(ctx.from, …)`, `scores[ctx.sender]`): se pierden al reiniciar y no se comparten entre réplicas. Usa
`ctx.user` (`await ctx.user.ns('feature').set(clave, valor)`).

Opción: `{ contextNames: string[] }` (nombres del parámetro de contexto; por defecto `['ctx']`).

## API

```ts
import botWa, { rules, configs, PLUGIN_NAMESPACE } from 'eslint-plugin-bot-wa'
botWa.meta     // { name: 'eslint-plugin-bot-wa', version, namespace: 'bot-wa' }
botWa.rules    // las seis reglas
botWa.configs  // { recommended, strict } (flat config)
```

## Desarrollo

```bash
pnpm --filter eslint-plugin-bot-wa build
pnpm --filter eslint-plugin-bot-wa test       # RuleTester sobre vitest
pnpm --filter eslint-plugin-bot-wa typecheck
```
