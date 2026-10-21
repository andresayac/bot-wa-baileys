# Transcripciones doradas

Una transcripción dorada (golden transcript) es una conversación grabada (lo
que enviaron los usuarios y lo que respondió el bot) guardada como un archivo
JSON versionado. La commiteas junto a tus tests y la reproduces contra el bot:
si un cambio altera una respuesta, la reproducción muestra el mensaje esperado
y el real lado a lado.

El flujo de trabajo:

1. **Grabar** una conversación (en tests o en producción) o construirla a
   partir del log de mensajes del store.
2. **Redactarla** para que ningún dato personal acabe en el repositorio.
3. **Guardarla** como JSON.
4. **Reproducirla** en un test (o en un gate de despliegue) y fallar ante
   cualquier diferencia.

| Función | Se importa de | Para qué |
| --- | --- | --- |
| `recordTranscript`, `RecordingProvider` | `@botmesh/core` o `@botmesh/core/testing` | Grabar tráfico real con un wrapper del provider |
| `transcriptFromStore`, `transcriptFromMessages` | `@botmesh/core` o `@botmesh/core/testing` | Construir una transcripción desde el log de mensajes del store |
| `redactTranscript`, `createRedactionMap` | `@botmesh/core` o `@botmesh/core/testing` | Sustituir datos personales por marcadores estables |
| `parseTranscript`, `serializeTranscript`, `createTranscript` | `@botmesh/core` o `@botmesh/core/testing` | Leer, escribir y escribir a mano transcripciones |
| `replayTranscript`, `assertTranscript`, `REPLAY_MASKS` | solo `@botmesh/core/testing` | Reproducir y comparar |

## Grabar una conversación

`recordTranscript(provider, options?)` envuelve cualquier `IProvider` (un
transporte real o un `MockProvider`) en un `RecordingProvider` transparente.
Pasa `recorder.provider` al bot; graba los mensajes e interacciones entrantes y
cada envío correcto.

```ts
import { Bot } from '@botmesh/core'
import { MockProvider, recordTranscript, redactTranscript, serializeTranscript } from '@botmesh/core/testing'
import { writeFileSync } from 'node:fs'

const recorder = recordTranscript(new MockProvider())
const bot = new Bot({ provider: recorder.provider })
// ... register handlers, start the bot, drive the conversation ...

const golden = redactTranscript(recorder.transcript({ name: 'checkout' }))
writeFileSync('tests/golden/checkout.json', serializeTranscript(golden))
```

El handle expone `transcript({ name?, description? })` (un snapshot),
`clear()`, `pause()` y `resume()`.
En un test creado con `createTestBot`, `chat.transcript()` devuelve esa misma forma
directamente desde el mock (ver [Snapshots de conversación](/es/guide/testing#snapshots-de-conversacion)).

| Opción | Por defecto | Notas |
| --- | --- | --- |
| `maxTurns` | `10000` (`DEFAULT_MAX_TURNS`) | Se descartan primero los turnos más antiguos. `Infinity` quita el límite. |
| `includeFromMe` | `false` | Graba también los ecos de los mensajes del propio bot marcados `fromMe`. |
| `now` | `Date.now` | Reloj de los offsets `t`. |

Los envíos fallidos u omitidos no se graban. La grabación también funciona en
producción (por eso se exporta desde `@botmesh/core`), pero el buffer guarda en
RAM los cuerpos de los mensajes, los nombres visibles y los ids **sin
redactar**: mantén `maxTurns` acotado y llama a `clear()` en cuanto hayas
sacado una transcripción.

## Desde el log de mensajes del store

`transcriptFromStore(source, chatIds, options?)` lee uno o más chats con
`getMessagesByChat` y los une en una transcripción ordenada por timestamp.
Pasa el **bot** (o `bot.getStore()`): un `Bot` escribe en una vista con
namespace del store que recibe, así que el store crudo no encuentra nada con
los ids de chat sin más.

```ts
import { transcriptFromStore } from '@botmesh/core'

const transcript = await transcriptFromStore(bot, [chatId], { name: 'support-123', limit: 500 })
```

Opciones: `name`, `limit` (por chat, por defecto `1000`), `includeFailed`
(conserva los mensajes salientes con estado `failed`, por defecto `false`) e
`isGroup` (un booleano o `(chatId) => boolean`; si se omite,
`transcriptFromStore` lee el tipo de chat del store).
`transcriptFromMessages(messages, options?)` hace lo mismo con un array de
`StoredMessage`.

El store no guarda el contenido saliente completo ni los nombres visibles, así
que estas transcripciones solo comparan `kind` y `text`, y las reproducciones
usan el push name por defecto del mock.

## El formato del archivo

```json
{
  "format": "botmesh/transcript",
  "version": 1,
  "name": "checkout",
  "source": "recorder",
  "redacted": true,
  "turns": [
    { "dir": "in", "chatId": "<user:1>", "senderId": "<user:1>", "type": "text", "text": "hola", "displayName": "<name:1>", "id": "<msg:1>", "t": 0 },
    { "dir": "out", "chatId": "<user:1>", "kind": "text", "text": "¡Hola <name:1>! ¿Tu email?", "content": { "kind": "text", "text": "¡Hola <name:1>! ¿Tu email?" }, "t": 12 }
  ]
}
```

- Turnos entrantes (`dir: 'in'`): `chatId`, `senderId`, `type`, `text` y,
  opcionalmente, `event` (`'message'` o `'interaction'`, donde `text` lleva los
  datos del botón o la lista), `isGroup`, `displayName`, `id` y `t`.
- Turnos salientes (`dir: 'out'`): `chatId`, `kind`, `text` (texto, caption,
  pregunta...) y, opcionalmente, `content` (el contenido completo apto para
  JSON, solo al grabar en vivo; los binarios pasan a
  `{ $binary: { bytes, sha256 } }`), `id` y `t`.
- `t` son milisegundos desde el primer turno; `startedAt` (epoch ms) es
  opcional y la redacción lo elimina.
- Los ids son strings opacos: nada los parsea.

`serializeTranscript(t)` escribe JSON estable y cómodo para diffs (indentación
de 2 espacios y salto de línea final). `parseTranscript(input)` (un string JSON o un
objeto ya parseado) valida la forma y la versión y, si no cuadran, lanza `TranscriptFormatError`.
`createTranscript(turns, meta?)` construye una a mano.

## Redacción

`redactTranscript(transcript, options?)` devuelve una copia redactada con
marcadores estables numerados por orden de aparición, así que el resultado es
determinista y redactar dos veces no cambia nada.

- Los ids pasan a `<user:N>`, `<chat:N>` (chats de grupo) y `<msg:N>`. Los ids
  de usuario y de chat de 4 o más caracteres también se sustituyen dentro de
  los textos (los ids de mensaje, solo como campo completo).
- Los nombres visibles pasan a `<name:N>`, en el campo y dentro de cualquier
  texto (así también se redacta una respuesta que saluda al usuario por su
  nombre). Al reproducir, el marcador se envía como push name, de modo que la
  respuesta sigue coincidiendo.
- Los emails y teléfonos (7 o más dígitos) de los textos **entrantes** pasan a
  `<email:N>` / `<phone:N>`. Los textos salientes solo reciben los valores ya
  aprendidos del lado entrante (datos que el bot repite): precios, fechas o
  números de pedido que imprime el bot por su cuenta se quedan como están,
  porque la reproducción los compara con los valores reales.

| Opción | Por defecto | Notas |
| --- | --- | --- |
| `emails` / `phones` | `true` | Patrones incluidos. |
| `ids` | `true` | Sustituye los ids de chat, remitente y mensaje. |
| `displayNames` | `'placeholder'` | `'drop'` quita el campo pero sigue redactando el nombre en los textos; `'keep'` lo deja. |
| `outboundPatterns` | `false` | Aplica también los patrones a los textos salientes. Reproduce esa transcripción con la opción `redact` de la reproducción. |
| `surrogates` | `false` | Usa valores con formato válido (`email1@redacted.invalid`, `+10000000001`) para que los pasos de validación acepten la entrada redactada al reproducir. |
| `dropStartedAt` | `true` | Quita la hora de inicio real. |
| `rules` | `[]` | Reglas extra `{ name, pattern }` (`name` cumple `[a-z0-9_-]+`); las coincidencias pasan a `<name:N>`. |
| `allow` | `[]` | Valores que nunca se redactan (un teléfono de soporte que imprime el bot). |
| `map` | nuevo | Un `RedactionMap` (`createRedactionMap()`) compartido entre llamadas mantiene los marcadores estables entre transcripciones. |

```ts
const golden = redactTranscript(raw, {
  rules: [{ name: 'order', pattern: /ORD-\d+/ }],
  allow: ['+57 601 555 0100'],
})
```

## Reproducir y comprobar

`replayTranscript(transcript, createBot, options?)` construye un bot nuevo
sobre un `MockProvider` en memoria, le pasa los turnos entrantes uno a uno y
compara lo que envía con los turnos salientes grabados. `createBot` recibe el
provider y debe devolver el bot **sin arrancarlo**; la reproducción lo arranca
y lo detiene.

```ts
import { readFileSync } from 'node:fs'
import { Bot, type IProvider } from '@botmesh/core'
import { assertTranscript, parseTranscript, REPLAY_MASKS } from '@botmesh/core/testing'
import { registerFlows } from '../src/flows.js'

function buildBot(provider: IProvider) {
  const bot = new Bot({ provider })
  registerFlows(bot)
  return bot
}

it('checkout still answers the same', async () => {
  const golden = parseTranscript(readFileSync('tests/golden/checkout.json', 'utf8'))
  await assertTranscript(golden, buildBot, { masks: [REPLAY_MASKS.isoDate] })
})
```

`assertTranscript` lanza un `TranscriptMismatchError` (con `.result`) cuyo
mensaje es el informe. `replayTranscript`, en cambio, devuelve un
`ReplayResult`: `{ ok, diffs, expected, actual, report() }`, donde `actual` es
la conversación que produjo el bot. Cada `TranscriptDiff` tiene un `kind`
(`'missing'`, `'unexpected'`, `'mismatch'` o `'timing'`), el `step` (índice del
turno entrante, `-1` antes del primero), `chatId`, `position`, los turnos
`expected` y `actual`, el primer `field` distinto (`'kind'`, `'text'`,
`'content.buttons.0.text'`, `'t'`, `'id'`) y un `message`.
`formatReplayReport(transcript, diffs)` genera el mismo informe.

Tras cada turno entrante, la reproducción espera a que el bot haya enviado al
menos tantos mensajes como los esperados y luego a que pase `settleMs` sin
actividad, así detecta tanto las respuestas que faltan como las que sobran.

### Opciones de tolerancia

| Opción | Por defecto | Notas |
| --- | --- | --- |
| `settleMs` | `30` | Periodo sin actividad que cierra un paso cuando ya llegaron las respuestas esperadas. |
| `stepTimeoutMs` | `2000` | Espera máxima por las respuestas de un paso. |
| `order` | `'per-chat'` | Compara en orden las respuestas de cada chat y tolera que se intercalen entre chats; `'strict'` compara el orden global (y el `chatId`). |
| `timestamps` | `'ignore'` | `{ toleranceMs }` marca una respuesta cuyo retraso respecto a su turno entrante difiere del grabado en más de `toleranceMs`. |
| `compareIds` | `false` | Compara los ids de los mensajes salientes (volátiles por defecto). |
| `compareContent` | `true` | Compara el `content` completo cuando la transcripción lo tiene; `false` compara solo `kind` + `text`. |
| `ignoreContentFields` | `[]` | Rutas con puntos dentro de `content` que se ignoran (`'media'`, `'target.id'`). |
| `masks` | `[]` | `RegExp` o `{ pattern, replace? }` aplicados a cada string de ambos lados (las coincidencias pasan a `'<*>'` por defecto). |
| `redact` | ninguno | `{ emails?, phones?, rules? }` para transcripciones hechas con `outboundPatterns: true`: las coincidencias y marcadores de esas categorías pasan a `<category:*>` en ambos lados. |
| `normalizeWhitespace` | `true` | Colapsa los espacios repetidos y recorta. |
| `normalizeText` | ninguno | Normalizador propio, aplicado después de las máscaras. |
| `now` | `Date.now` | Reloj de los offsets `t` reales. |

`REPLAY_MASKS` trae máscaras listas: `isoDate`, `time`, `uuid` y `number`.

## Gate de publicación (`@botmesh/deployments`)

::: warning Experimental — aún no publicado en npm
`@botmesh/deployments` es privado (no está en npm) y su API puede cambiar. Es
persistente: `MemoryDeploymentStore` es la referencia y `KvDeploymentStore`
persiste sobre cualquier `DurableKv` (SQLite, PostgreSQL, Redis, archivo). Los
gate runs se guardan en un log de auditoría.
:::

`DeploymentRegistry` guarda versiones inmutables por tenant y bot con una única
versión activa (`publish`, `active`, `rollback`, `list`).
`publish(tenantId, botId, version, artifact, { gate })` ejecuta el gate
**antes** de activar la versión:

- si pasa, la versión se guarda y se activa con
  `deployment.gate = { passed: true, checkedAt, summary? }`;
- si falla o lanza, `publish` rechaza con un `DeploymentGateError`
  (`candidate`, `result`) y no se guarda nada, así que la misma versión se
  puede corregir y volver a publicar.

Con gate, `publish` devuelve una `Promise`, y la versión queda reservada
mientras el gate corre (un publish duplicado falla con `deployment version
already exists`). Un gate es cualquier función `(candidate) => boolean |
GateResult`, síncrona o async; `GateResult` es
`{ ok, reason?, summary?, details? }`.

`goldenTranscriptGate(options)` reproduce transcripciones doradas contra el
candidato y solo pasa si todas coinciden. Cada transcripción corre contra un
bot nuevo.

```ts
import { readFileSync } from 'node:fs'
import { MemoryKv } from '@botmesh/core'
import { parseTranscript, REPLAY_MASKS } from '@botmesh/core/testing'
import { DeploymentGateError, DeploymentRegistry, KvDeploymentStore, goldenTranscriptGate } from '@botmesh/deployments'

const registry = new DeploymentRegistry(new KvDeploymentStore(new MemoryKv()))
const gate = goldenTranscriptGate({
  transcripts: [parseTranscript(readFileSync('golden/checkout.json', 'utf8'))],
  createBot: (candidate) => loadBotFactory(candidate.artifact),   // returns (provider) => Bot, not started
  replay: { masks: [REPLAY_MASKS.isoDate] },
})

try {
  await registry.publish('acme', 'support', '1.4.0', 'sha256:...', { gate })
} catch (error) {
  if (error instanceof DeploymentGateError) console.error(error.message)   // includes the expected vs actual report
}
```

| Opción | Notas |
| --- | --- |
| `transcripts` | Un array, o `(candidate) => Transcript[]` (síncrona o async) para cargar los archivos de esa versión. |
| `createBot` | `(candidate) => ReplayBotFactory` (síncrona o async). |
| `replay` | `ReplayOptions` que se pasan a `replayTranscript`. |
| `allowEmpty` | Por defecto `false`: sin transcripciones, o con una transcripción sin turnos entrantes o sin respuestas esperadas (un pase vacío), el gate falla. |

Si falla, `error.result.details.results` lista `{ name, ok, diffs, report }`
por transcripción.

## Ver también

- [Testing](/es/guide/testing)
- [Control plane](/es/guide/control-plane)
- [README de `@botmesh/deployments`](https://github.com/andresayac/botmesh/tree/main/packages/deployments)
