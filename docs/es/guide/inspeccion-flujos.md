# Inspeccionar y validar flujos

`@bot-wa/core` puede describir los flujos que tiene registrados un bot, como
diagrama Mermaid o como grafo JSON, y revisarlos de forma estática en busca
de errores habituales. No se envía nada y no hace falta arrancar el bot.

## `bot.describe()`: diagrama Mermaid o grafo JSON

```ts
import { writeFileSync } from 'node:fs'
import { Bot, flow, describeFlows } from '@bot-wa/core'

bot.use(
  flow('registrar')
    .timeout('2m')
    .ask('¿Nombre?', 'name')
    .choose('¿Plan?', { pro: 'Pro', free: 'Gratis' })
    .goto('soporte'),
)
bot.conversation('soporte', async (c, ctx) => { /* ... */ })

writeFileSync('flows.mmd', bot.describe())         // Mermaid (por defecto): pégalo en mermaid.live o en un bloque ```mermaid
const graph = bot.describe({ format: 'json' })     // { version: 1, flows, groups, nodes, edges }, datos JSON planos
bot.describe({ direction: 'LR', maxLabelLength: 40 })
describeFlows([flowA, flowB])                       // sin Bot: una lista de FlowBuilder/CompiledFlow
```

Qué dibuja:

- Un `subgraph` por flujo del DSL. El nodo de entrada (▶) lista **todos**
  los triggers que lo arrancan (`bot.use`, `bot.when(trigger, flow)`, el
  trigger de un `bot.conversation`). Con `bot.when(trigger, flow)` el
  trigger propio del flujo no se enruta, y el diagrama lo refleja.
- `say`, `ask` (→ clave de estado, ⏱ si el paso tiene timeout propio,
  `✓schema` si valida con un `schema`), `do` (con el nombre de la función si
  tiene uno: `do: saveUser()`), `media` (con su tipo: `media (document): ...`),
  `choose` (un rombo; las opciones son flechas `1) Etiqueta`, igual que el
  menú que ve el usuario), `form` (sus campos y su clave de estado), `guard`
  (`guard: isAdmin()`, con `✗→ destino` si redirige), `use` (el sub-flujo
  dibujado en línea, que vuelve al paso siguiente), `delay` (pasos `.delay()`;
  la opción `{ delay }` se añade a la etiqueta de su paso), `goto` (flecha
  punteada al flujo destino) y `end`.
- El `then:` de una opción es un nodo propio si es una acción, o un
  subgraph anidado que vuelve al paso siguiente del padre si es un
  sub-flujo. El `goto` de una opción es una flecha a su flujo destino.
- El `.timeout()` y el `.persistent()` del flujo van en el título del
  subgraph.
- Un `goto` a un flujo inexistente se dibuja como un nodo `missing: nombre`.
- Los pasos después de un `goto` incondicional no tienen flecha de entrada
  (código muerto visible).
- Las conversaciones async (`bot.conversation(name, fn)`) son opacas: un
  solo nodo con sus triggers.
- El texto del usuario se escapa con códigos de entidad de Mermaid, así que
  no puede romper una etiqueta ni inyectar directivas `%%{init}%%`. Los ids
  de nodo (`f0_in`, `f0_s3`, `f0_end`...) son estables y los mismos en
  Mermaid, JSON y lint.

## `bot.lint()`: chequeos estáticos

```ts
for (const d of bot.lint({ minSeverity: 'warning' })) {
  bot.logger.warn({ code: d.code, flow: d.flow, path: d.path }, d.message)
}
if (bot.lint().some((d) => d.severity === 'error')) process.exitCode = 1  // gate de CI
bot.lint({ rules: { 'missing-timeout': false } })                          // desactivar una regla
lintFlows([flowA, flowB])                                                    // sin Bot
```

Cada diagnóstico es `{ code, severity, message, flow?, nodeId?, path?, trigger? }`,
ordenados de más a menos grave.

| Código | Severidad | Qué detecta |
| --- | --- | --- |
| `goto-target-missing` | error | `goto('x')`, el `redirect` de un `.guard()` o el `goto` de una opción de `choose` hacia algo no registrado (también `goto(builder)` de un flujo con trigger regex sin `.id()`, cuyo id cambia en cada compilación) |
| `invalid-timeout` | error | un timeout de paso que no se puede interpretar (`'2 minutos'`) |
| `empty-choice` | error | `choose()` sin opciones |
| `unreachable-step` | warning | pasos después de un `goto` incondicional (o de un `choose` cuyas opciones saltan todas) |
| `unreachable-flow` | warning / info | ningún trigger lo arranca y ningún flujo alcanzable salta a él. Info si código alcanzable aún podría entrar con `c.goto()` |
| `empty-trigger` | warning / info | `addKeyword([])` nunca coincide; `''` coincide con mensajes sin texto (o con todo en contains/startsWith/endsWith); un regex vacío. Info si el flujo solo es destino de un `goto` |
| `duplicate-trigger` | warning | una ruta nunca recibe un patrón porque otra anterior en el orden real del dispatcher (especificidad y luego registro) lo atiende; respeta scope y estrategia |
| `flow-id-collision` | warning | dos flujos/conversaciones con el mismo id (p. ej. `flow('hola')` y `flow(['Hola', 'hi'])`): solo corre el último |
| `persistent-memory-store` | warning | `.persistent()` con un `MemoryStore` sin `file` (los checkpoints mueren al reiniciar) |
| `duplicate-choice` | warning | opciones con la misma clave o etiqueta normalizada |
| `ambiguous-choice` | warning | una clave/etiqueta numérica fuera de su posición (`{ 0: 'Cero', 1: 'Uno' }`: escribir 1 elige '0'), o una etiqueta igual a la clave de otra opción |
| `form-state-collision` | warning | un `.form()` guarda sus respuestas en una clave de `c.state` que otro `ask`/`choose`/`form` del mismo flujo también escribe |
| `missing-timeout` | info | `ask`/`choose` sin timeout y sin `conversation.timeout`: se usa el valor por defecto de 5 minutos. También avisa de que los sub-flujos `then:` no heredan el `.timeout()` del padre |
| `wait-never-expires` | info | timeout `0`: la espera nunca expira |

Los chequeos de timeout (`invalid-timeout`, `missing-timeout`,
`wait-never-expires`) también cubren los pasos `.form()`. `missing-timeout`
aparece a propósito en la mayoría de bots pequeños; usa
`minSeverity: 'warning'` para un informe más limpio.

## Helpers de bajo nivel

- `describeFlows(source, options)` y `lintFlows(source, options)` aceptan un
  `Bot`, un `FlowInventory` o un array de flujos.
- `bot.flowInventory()` devuelve la foto sobre la que trabajan (registros,
  rutas, timeout por defecto y si el store es durable) para tus propias
  herramientas. `MemoryStore#durable` es `true` si tiene `file`.
- `describeTrigger(trigger)` devuelve `{ label, patterns, match, scope, predicate }`.

## Siguientes pasos

- [Flujos conversacionales](./flujos)
- [Testing](./testing)
