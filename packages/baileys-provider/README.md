# @bot-wa/baileys

Transporte **WhatsApp vía [Baileys 7](https://github.com/WhiskeySockets/Baileys)** ([`IProvider` v2](https://github.com/andresayac/bot-wa-baileys/blob/main/packages/core/src/core/provider.ts)) para [`@bot-wa/core`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core). Vincula el bot como un dispositivo de WhatsApp Web (QR o código de emparejamiento) y abre un WebSocket propio: no hace falta servidor público ni webhook.

> **Cliente no oficial.** Baileys implementa el protocolo de WhatsApp Web por ingeniería inversa; ni WhatsApp ni Meta lo respaldan. Automatizar una cuenta puede infringir los [Términos de servicio de WhatsApp](https://www.whatsapp.com/legal/terms-of-service) y acabar en **bloqueo del número**. Usa un número dedicado, escribe solo a quien te lo pidió (opt-in), no hagas envíos masivos y deja el rate limiter activado. Si necesitas una vía oficial y sin riesgo de baneo, usa [`@bot-wa/meta`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/meta-provider) (WhatsApp Cloud API).

- **Ingress:** socket propio con reconexión y backoff; los eventos de Baileys se traducen a `InboundEvent` neutros: mensajes, reacciones, votos de encuestas (descifrados por el provider), cambios de grupo, llamadas y presencia.
- **Outbound:** texto, imagen, video, audio, nota de voz (transcodifica a Opus), documento, sticker (conversión con `sharp`), ubicación, contacto, **encuestas nativas** y reacciones. Botones, listas y tarjetas se degradan a texto numerado.
- **Acciones:** confirmaciones de lectura, typing/recording, borrar mensajes y descarga de media entrante.
- **Identidad estable:** el provider resuelve la dualidad LID/PN de WhatsApp antes de emitir cada evento, así que el core siempre ve el mismo `senderId` para la misma persona.

## Requisitos

- **Node ≥ 22** (ESM-only).
- **`@whiskeysockets/baileys` 7.0.0-rc14 o superior.** Desde finales de julio de 2026, WhatsApp cierra con `428 Connection Terminated` las conexiones de clientes con el handshake anterior, antes incluso de mostrar el QR. La rc14 trae el handshake actualizado (entre otras cosas, la versión de WhatsApp Web incluida en el paquete). Si tu lockfile resuelve una rc anterior, actualízala.
- Salida de red hacia `wss://web.whatsapp.com` y, al arrancar, hacia `raw.githubusercontent.com`: el provider consulta la versión de WhatsApp Web más reciente publicada por Baileys. Si no hay acceso, usa la versión incluida en la release instalada, que por eso tiene que ser ≥ rc14.

## Instalación

En el monorepo el paquete ya está disponible como workspace. Desde una app:

```bash
pnpm add @bot-wa/core @bot-wa/baileys
```

`ffmpeg` viene incluido (`@ffmpeg-installer/ffmpeg`) para las notas de voz, y `sharp` para los stickers.

## Quickstart

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({ provider: new BaileysProvider({ session: 'mi-bot' }) })

bot.on('ready', () => console.log('✅ Conectado'))
bot.when('hola', (ctx) => ctx.reply('👋 ¡Hola!'))

await bot.start()   // la primera vez imprime el QR en la terminal: escanéalo desde WhatsApp → Dispositivos vinculados
```

La sesión queda guardada en `./sessions/mi-bot`; los siguientes arranques reconectan sin QR. Hay un ejemplo completo (comandos, flows, media, hooks, DI y scheduler) en [`examples/bot.ts`](https://github.com/andresayac/bot-wa-baileys/blob/main/packages/baileys-provider/examples/bot.ts) (`pnpm --filter @bot-wa/baileys example`).

## Configuración

```ts
interface BaileysProviderConfig {
  session?: string            // id de la sesión, por defecto 'default'
  sessionsDir?: string        // carpeta raíz de las sesiones, por defecto './sessions'
  pairingCode?: string        // número en formato internacional: emparejar con código en vez de QR
  qr?: QrConfig               // cómo mostrar el QR (por defecto: terminal, tamaño pequeño)
  rateLimit?: RateLimitConfig // ritmo de envío anti-baneo (activado por defecto)
  reconnect?: boolean         // por defecto true
  browser?: BrowserConfig     // identidad del dispositivo; mejor no tocarla (ver abajo)
  markOnlineOnConnect?: boolean // por defecto false: el teléfono sigue recibiendo notificaciones
  syncFullHistory?: boolean     // por defecto false
  ignoreBroadcasts?: boolean    // por defecto true (status@broadcast se ignora siempre)
  ignoreNewsletters?: boolean   // por defecto true
  pollStore?: PollStore         // persistencia de encuestas para leer votos tras un reinicio (ver Encuestas y votos)
  debug?: boolean               // nivel 'debug' en el logger por defecto (si no, 'error')
  logger?: Logger               // logger compatible con pino
}
```

### Sesión

Cada sesión vive en `<sessionsDir>/<session>` y contiene las credenciales del dispositivo vinculado. Para varios números, usa un `session` distinto por número. Las reglas de validación están en [Seguridad de la sesión](#seguridad-de-la-sesión).

### QR o código de emparejamiento

Por defecto el provider emite un QR. Si el servidor no tiene cámara ni terminal a mano, pide un **código de emparejamiento**:

```ts
const provider = new BaileysProvider({
  session: 'mi-bot',
  pairingCode: '+57 300 123 4567',   // solo cuentan los dígitos
  qr: { terminal: false },
})
const bot = new Bot({ provider })
bot.on('qr', (artifact) => {
  // Por aquí llegan tanto los QR (cadenas largas) como el código de 8 caracteres.
  if (artifact.length === 8) notificarAlOperador(artifact)
})
await bot.start()
```

En el teléfono: **Dispositivos vinculados → Vincular con el número de teléfono** e introduce el código. El código se pide una sola vez por arranque, con el primer QR. Si la petición falla, el provider lo registra en el log y sigue ofreciendo el QR. QR y código llegan también en el evento `connection`, como `authPayload`.

### Renderizado del QR

```ts
interface QrConfig {
  terminal?: boolean        // dibuja el QR en stdout
  small?: boolean           // QR compacto (por defecto true)
  file?: boolean | string   // PNG: true → '<session>.qr.png' en el CWD; un string fija la ruta
  handler?: (qr: string) => void | Promise<void>  // tu propio render (web, Slack…)
}
```

Sin `qr`, se dibuja en la terminal. Si pasas un objeto `qr`, solo se activa lo que indiques. Los errores al escribir el PNG se registran en el log, nunca se lanzan.

> El QR y el código de emparejamiento dan acceso a la cuenta mientras están vigentes. No los registres en logs ni los envíes por canales sin cifrar, y borra el PNG cuando ya no lo necesites.

### Identidad del navegador (`browser`)

**Déjalo sin definir.** El provider entonces no envía la opción y Baileys usa su identidad por defecto (`Browsers.macOS('Chrome')`), que es la que valida el handshake de la rc14. Los presets `'macOS' | 'ubuntu' | 'windows' | 'appropriate'` anuncian **Chrome** en ese sistema operativo. Una tupla propia `[os, navegador, versión]` se pasa tal cual y deja un aviso en el log: con identidades no estándar (p. ej. `'Desktop'` o un nombre inventado), WhatsApp puede cerrar la conexión con `428` antes del QR.

### Rate limiter (anti-baneo)

Todo `send()` pasa por un token bucket antes de llegar al socket. Los envíos que superan el límite **se encolan, no se descartan**, y un chat bloqueado no frena a los demás.

```ts
new BaileysProvider({
  session: 'mi-bot',
  rateLimit: {
    perChat: { max: 5, window: '10s' },   // por defecto
    global: { max: 50, window: '60s' },   // por defecto
    jitter: { min: 500, max: 1500 },      // pausa "humana" entre envíos (desactivada por defecto)
    maxWait: '30s',                       // pasado este tiempo en cola, el envío falla con RateLimiterTimeout (un RateLimitedError)
    // enabled: false                     // desactivarlo del todo (no recomendado)
  },
})
```

Más detalle en la guía [Rate limiting](https://github.com/andresayac/bot-wa-baileys/blob/main/docs/es/guide/rate-limiting.md).

### Reconexión y backoff

Cuando el socket se cierra, el provider emite `connection` con `state: 'closed'` y decide según el código de Baileys:

| Código | Significado | Qué hace el provider | `reason` |
| --- | --- | --- | --- |
| 401 `loggedOut`, 500 `badSession`, 411 `multideviceMismatch` | La sesión ya no vale | Borra **solo** la carpeta de esa sesión y arranca de nuevo (QR nuevo) | `sessionInvalid` |
| 440 `connectionReplaced`, 403 `forbidden` | Otra instancia usa la sesión, o prohibido | **No reconecta** (pelear con la otra instancia arriesga el número) | `sessionTakenOver` |
| 515 `restartRequired` | Reinicio normal tras emparejar | Reconecta al instante | `transient` |
| El resto (428, 408, 503…) | Corte transitorio | Backoff exponencial: 1 s, 2 s, 4 s… hasta 30 s, máximo 10 intentos | `transient` |

Si `start()` falla durante una reconexión (por ejemplo, sin red), se reintenta con el mismo backoff y el mismo tope. Al agotarlo, emite un `closed` final con `detail.message: 'reconnect exhausted'`. Con `reconnect: false` no se reintenta nunca. El contador vuelve a cero cada vez que la conexión abre.

## Identidad: LID y PN

WhatsApp identifica a cada usuario de dos formas: el número de teléfono (**PN**, `573001234567@s.whatsapp.net`) y un identificador opaco (**LID**, `…@lid`). Un mismo contacto puede llegar como PN, como LID con el PN al lado (`remoteJidAlt`/`participantAlt`) o como LID a secas, y la forma puede cambiar de un mensaje a otro. Si el bot usara el `remoteJid` crudo, una misma persona quedaría partida en dos claves y los flows se romperían (el `ask` nunca recibe la respuesta).

El provider lo resuelve con un `IdentityStore` **antes** de emitir cada evento:

- Aprende el par LID↔PN cuando lo ve: en la clave del mensaje, en los eventos `lid-mapping.update` y consultando el almacén de mapeos de Baileys (que se guarda en la carpeta de la sesión y sobrevive a reinicios).
- Canonicaliza: si conoce el PN de un LID, `chatId` y `senderId` usan el **PN**. Si no, usan el **LID**. Siempre normalizados, sin sufijo de dispositivo (`:12`).
- En grupos, `chatId` es el grupo (`…@g.us`) y `senderId` el participante canonicalizado.
- `ctx.senderInfo.platformData` lleva `{ phoneNumber?, lid? }`: el PN si se conoce y el LID crudo tal como llegó.
- Los demás eventos pasan por la **misma** canonicalización, así que una persona tiene el mismo id en todos: el autor de una reacción o de un voto, los participantes y el autor (`actor`) de un cambio de grupo, quien llama (`call.from`) y el chat y las claves de `presences`. El provider aprovecha el PN que Baileys trae en cada evento (`participantAlt`, `authorPn`, `callerPn`, `phoneNumber` del participante) y, si no lo trae, consulta el almacén de mapeos.
- En una reacción, `senderId` es **quien reacciona** y `ref.id` el mensaje reaccionado (antes se informaba, por error, el autor de ese mensaje).
- Las menciones (`mentions`) y el autor del mensaje citado (`quoted.senderId`) también son canónicos: en un grupo direccionado por LID, WhatsApp menciona y cita con LIDs, y el provider los cambia por el PN si lo conoce (consultando el almacén de mapeos si hace falta). Así, `ctx.quoted?.senderId === provider.selfId` detecta una respuesta a un mensaje del bot. La cita y las menciones se leen también de los pies de foto, video y documento, y `quoted.ref` apunta al mensaje citado (sirve como `quoted` para responder en hilo).
- Los mensajes envueltos (modo temporal, *ver una vez*, documento con pie de foto) se desenvuelven antes de clasificarlos, así que llegan con su `type`, `body` y `media` reales.
- `provider.selfId` es el PN normalizado del bot (`573000000000@s.whatsapp.net`, sin el sufijo de dispositivo `:12` que guarda `creds.me.id`), el mismo id que llevan sus propias reacciones y votos. Con `groupMode: 'mentions'`, el core compara las menciones con `selfId`, así que el bot responde tanto si lo mencionan por su número como por su LID.
- En `group`, el provider traduce la acción `modify` de Baileys (cambio de número) a `action: 'update'`, pero la rc14 no llega a emitirla: al procesar el cambio de número, Baileys intenta `JSON.parse` sobre los JID crudos del aviso y lanza antes de emitir el evento. En la práctica, con la rc14 un cambio de número no produce ningún evento `group`.
- Al enviar a un LID, el provider usa el PN si lo conoce y, si no, envía directamente al LID.

Para casos avanzados se exportan `IdentityStore`, `provider.getPNForLID(lid)` y los helpers de JID (`isPn`, `isLid`, `normalizeJid`, `sameUser`…).

### Contactos con nombre de usuario (2026)

Con los nombres de usuario de WhatsApp, algunos contactos **nunca** exponen su número: llegan siempre como `@lid`, sin PN al lado ni mapeo conocido. Para ellos la identidad es **estable sobre el LID**: todos sus mensajes producen el mismo `chatId`/`senderId`, `platformData.phoneNumber` queda `undefined` y los envíos van al LID. No des por hecho que `senderId` es un teléfono: compruébalo con `isPn()` antes de usarlo como tal.

**Comportamiento residual:** si el mapeo LID→PN se aprende **más tarde** (llega un mensaje con el PN al lado o un `lid-mapping.update`), desde ese momento la persona pasa a identificarse por su PN. Una conversación que empezó bajo el LID sigue esperando en la clave del LID y no verá los mensajes siguientes, que llegan con el PN. En la práctica:

- Pon `.timeout()` en los flows (o `timeout` en `c.ask`/`c.waitText`) para que una conversación huérfana se cierre sola. El usuario la reinicia con el disparador o con un comando como `/reset`.
- Si guardas datos por persona (CRM, preferencias), guarda también `platformData.phoneNumber` y `platformData.lid` para poder reconciliar los dos registros.

## Encuestas y votos

`ctx.poll(pregunta, opciones, multiSelect?)` envía una encuesta nativa. Los votos llegan al bot como evento `poll`, ya descifrados y con el recuento completo:

```ts
await ctx.poll('¿Pizza o sushi?', ['Pizza', 'Sushi'])

bot.on('poll', (vote) => {
  // vote.ref.id      → id de la encuesta (vote.ref.native es el mensaje de la encuesta)
  // vote.ref.chatId  → chat donde se votó, el mismo chatId que usan sus mensajes
  // vote.senderId    → quien acaba de votar, con la identidad canónica de sus mensajes
  // vote.options     → recuento actual: [{ name, votes, voters }]
  const elegidas = vote.options.filter((o) => o.voters?.includes(vote.senderId)).map((o) => o.name)
  console.log(elegidas.length ? `Eligió: ${elegidas.join(', ')}` : 'Retiró su voto')
})
```

WhatsApp cifra cada voto de extremo a extremo con una clave derivada del secreto de la encuesta (`messageSecret`), su id y los JID del creador y del votante. Baileys 7 trae ese descifrado comentado, así que el provider lo hace por su cuenta:

- **Recuerda las encuestas que ve:** las que envía el bot (el resultado de `send()` y el eco `append` que emite Baileys) y las que crean otros en los chats que el provider escucha. Las de chats ignorados (estados, listas de difusión, canales; ver `ignoreBroadcasts`/`ignoreNewsletters`) no ocupan sitio, salvo las del propio bot. Guarda en memoria las **500** más recientes; una encuesta que recibe votos se mantiene entre las recientes.
- **Ata cada voto a su encuesta:** un voto solo nombra la encuesta por su id, y cualquier miembro de un chat conoce el id y el secreto de sus encuestas. Por eso el provider exige que el voto llegue por el **mismo chat** que la encuesta (contando las formas LID y PN de un mismo chat) y que nombre al **mismo creador**. Otra encuesta que reutilice el id (los ids los elige el cliente que envía) no puede sumar votos a la que ya está en memoria. Los votos que no cumplen se descartan con un log de nivel `debug`.
- **Descifra probando las formas LID y PN** del creador y del votante. En un grupo direccionado por LID el voto se firma con los LID; en un chat por PN, con los números. Un par incorrecto no pasa la autenticación de AES-GCM, así que probarlos no produce falsos positivos.
- **Guarda el último voto de cada persona:** un voto nuevo reemplaza al anterior, una selección vacía lo retira y un voto más antiguo que el guardado se descarta. Una persona cuenta una sola vez aunque vote primero como LID y luego aparezca con su PN.
- **Cada voto se cuenta una vez:** Baileys vuelve a entregar como `append` los mensajes recibidos sin conexión, así que el provider recuerda los ids de los últimos 5000 votos contados y no vuelve a emitir uno repetido. Un voto distinto de la misma persona con la misma marca de tiempo sí actualiza el recuento.
- El voto cifrado ya **no** llega como mensaje de tipo `poll`. `bot.onPoll` se dispara solo con las encuestas que crea otra persona, con la pregunta en `body`.

Limitaciones:

- Sin `pollStore`, solo se descifran los votos de encuestas que **este proceso** vio. Tras un reinicio la memoria empieza vacía, así que los votos de encuestas anteriores (o desalojadas de la caché) se descartan con un log de nivel `debug`. Para conservarlas, configura un [`pollStore`](#persistir-encuestas-pollstore). Un voto que no se descifra deja un `warn` con el id de la encuesta, sin JID ni contenido.
- **El bot no puede votar.** Baileys 7 no tiene API para construir un voto cifrado (ni contenido de voto en `sendMessage` ni un equivalente de `decryptPollVote` para cifrar); habría que reimplementar el cifrado y enviarlo con `relayMessage`. Por eso no hay `ctx.vote()`.

### Persistir encuestas (`pollStore`)

Para descifrar los votos que llegan **después de un reinicio**, pasa un `pollStore`: una interfaz async mínima, con clave el id del mensaje de la encuesta, que puedes respaldar con Redis, SQL o un archivo.

```ts
import type { PollStore, StoredPoll } from '@bot-wa/baileys'

const pollStore: PollStore = {
  get: async (id) => {
    const raw = await redis.get(`poll:${id}`)
    return raw ? (JSON.parse(raw) as StoredPoll) : undefined
  },
  set: async (id, poll) => { await redis.set(`poll:${id}`, JSON.stringify(poll), 'EX', 30 * 24 * 3600) },
  delete: async (id) => { await redis.del(`poll:${id}`) },
}

new BaileysProvider({ session: 'mi-bot', pollStore })
```

- `StoredPoll` es JSON plano: la clave de la encuesta (chat y creador, con sus formas LID/PN), la pregunta, el `messageSecret` en base64, las opciones con su hash y el último voto de cada persona. No guarda otros mensajes.
- El provider llama a `set` al ver una encuesta nueva y tras cada voto contado; a `get` cuando llega un voto de una encuesta que no está en memoria (o una encuesta nueva reutiliza un id); y a `delete` si una entrada está mal formada. La caché en memoria de 500 encuestas sigue delante del store.
- Tras un reinicio, el recuento continúa donde se quedó y se mantienen las mismas reglas: el voto tiene que llegar por el mismo chat y nombrar al mismo creador, y una encuesta posterior con el mismo id no sobrescribe la guardada.
- La retención (TTL, limpieza) la decides tú. Si el store falla, el provider lo registra como `warn` y sigue con la caché en memoria: nunca rompe un envío ni la recepción.
- **La entrada contiene el secreto de la encuesta**, con el que se descifran sus votos: trata el store con el mismo cuidado que la carpeta de la sesión.

`vote.ref.native` de una encuesta cargada del store es un mensaje de encuesta reconstruido (clave, pregunta, opciones y secreto), suficiente para citarla.

## Seguridad de la sesión

La carpeta de la sesión (`creds.json` y las claves Signal) **es** la cuenta: quien la copie puede leer y enviar mensajes como tu número.

- **Contención de rutas.** `session` es un id opaco: de 1 a 128 caracteres entre letras, dígitos, `.`, `_` y `-`, empezando por letra o dígito. No admite separadores ni `..`. Se valida en el constructor, antes de tocar el disco. `sessionsDir` no puede ser la raíz del sistema de archivos. Antes de leer, escribir o borrar, el provider rechaza una carpeta de sesión que sea un enlace simbólico y comprueba con la ruta real que sigue dentro de `sessionsDir`.
- **`stop()` vs `logoutAndDeleteSession()`.** `stop()` cierra el socket y **conserva** la sesión: el siguiente `start()` reconecta sin QR. `logoutAndDeleteSession()` desvincula el dispositivo en WhatsApp y borra **solo** la carpeta de esa sesión, así que el siguiente arranque pide un QR nuevo. Úsalo solo cuando quieras desvincular de verdad.
- **Borrado automático.** Con 401/500/411 (sesión inválida) el provider borra la carpeta de la sesión por su cuenta para poder emparejar de nuevo.
- Añade `sessions/` a `.gitignore`, restringe los permisos de la carpeta (p. ej. `chmod 700`) y no ejecutes dos instancias con la misma sesión: WhatsApp cerraría una con `440 conflict`.
- El provider no registra QR, códigos ni cuerpos de mensaje. Con `debug: true` el log de Baileys es muy verboso; no lo dejes activado en producción.

## Capacidades

| Capability | Valor | Notas |
| --- | --- | --- |
| `buttons` | ❌ | se degradan a texto numerado |
| `lists` | ❌ | se degradan a texto numerado |
| `polls` | ✅ | envío de encuestas nativas y lectura de votos con el evento `poll` (ver [Encuestas y votos](#encuestas-y-votos)) |
| `reactions` | ✅ | enviar y recibir; `senderId` es quien reacciona |
| `edit` | ❌ | |
| `typing` | ✅ | `composing` / `recording` / `paused` |
| `presence` | ✅ | eventos `presence` |
| `readReceipts` | ✅ | `markRead` |
| `groups` | ✅ | mensajes de grupo y eventos de participantes |
| `templates` | ❌ | requieren la Cloud API (`@bot-wa/meta`) |
| `interactionsRequireAck` | ❌ | |
| `pushIngress` | ❌ | el provider mantiene su propio socket |

## Mapeo de errores

`send()` solo rechaza con subclases de `ProviderError` de `@bot-wa/core`. Los fallos de `sock.sendMessage`, del rate limiter y de la preparación del contenido se convierten así:

| Causa | Se convierte en |
| --- | --- |
| 429 de Baileys | `RateLimitedError` (`retryAfterMs` sale de `retry-after`, por defecto 1 s) |
| 413 o *too large* | `PayloadTooLargeError` |
| 401 / 403, *forbidden*, *not-authorized*, *blocked* | `RecipientUnreachableError` |
| `kind: 'template'` o `'native'` | `UnsupportedContentError` |
| espera en la cola del rate limiter mayor que `maxWait` | `RateLimiterTimeout`, subclase de `RateLimitedError` |
| `stop()` con envíos todavía en cola | `ProviderError('RateLimiter reset')` |
| sin socket conectado | `ProviderError('Provider not connected')` |
| cualquier otro | `ProviderError`, con el error original en `cause` |

`RateLimiterTimeout` conserva su `name` y sus campos `chatId` y `waitedMs`, así que el código que ya lo capturaba sigue funcionando. Como es un `RateLimitedError`, también lo atrapa un `catch (e instanceof RateLimitedError)` portable entre transportes; su `retryAfterMs` es el tiempo que falta para que el bucket que lo bloquea recupere un token.

## Limitaciones

- **Sin botones ni listas nativos.** WhatsApp Web dejó de soportarlos para clientes no oficiales. Usa menús numerados con `choose()` (en el DSL `flow().choose(...)` o en conversaciones `c.choose(...)`) o una encuesta nativa con `ctx.poll(pregunta, opciones)`. `ctx.buttons(...)` y el contenido `list` siguen funcionando, pero llegan como texto numerado.
- **Votos de encuestas:** sin `pollStore`, solo se leen los de encuestas que el proceso vio desde que arrancó, y el bot no puede votar (ver [Encuestas y votos](#encuestas-y-votos)). Si la respuesta tiene que sobrevivir a un reinicio, configura un `pollStore` o usa `choose()`.
- Sin plantillas ni ventana de 24 h: eso es de la Cloud API.
- No se pueden editar mensajes enviados (`edit: false`).

## Notas

- ESM only (`"type": "module"`); los imports relativos llevan extensión `.js`.
- Para responder a las peticiones de reenvío de WhatsApp (`getMessage`), el provider guarda en memoria los últimos 2000 mensajes de los chats que escucha y los del propio bot. Los de chats ignorados (estados, listas de difusión, canales) no ocupan sitio.
- Los errores se registran bajo la clave `err` de pino, así que el log muestra mensaje y stack. Si inyectas tu propio `logger`, mantén el serializer de errores de pino.
- `provider.socket` expone el socket de Baileys para operaciones que el `IProvider` no cubre (grupos, perfil…). Úsalo con cuidado: lo que hagas ahí se salta el rate limiter y el mapeo de errores.
