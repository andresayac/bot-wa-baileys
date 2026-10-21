# @botmesh/email

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: su API puede cambiar. Úsalo desde este monorepo (`workspace:*`); el `pnpm add @botmesh/email` de abajo funcionará cuando se publique.

Transporte **email** para [`@botmesh/core`](../core): **IMAP IDLE** para recibir (o `ingest()` con el MIME crudo desde un webhook de correo entrante) y **SMTP** para responder. Cada hilo de correo es un chat, así que los flows (`flow().ask()...`) funcionan igual que en WhatsApp o Telegram: el cliente responde al email y el bot continúa la conversación en el mismo hilo.

## Instalación

```bash
pnpm add @botmesh/core @botmesh/email
pnpm add imapflow nodemailer   # peers opcionales: IMAP (entrada) y SMTP (salida)
```

`imapflow` y `nodemailer` son `peerDependencies` **opcionales** y se cargan de forma lazy: si solo envías, no necesitas `imapflow`; si solo recibes por `ingest()`, no necesitas ninguno de los dos para recibir.

## Uso

```ts
import { Bot, flow } from '@botmesh/core'
import { EmailProvider } from '@botmesh/email'

const provider = new EmailProvider({
  address: 'soporte@acme.com',
  fromName: 'Soporte Acme',
  imap: { host: 'imap.gmail.com', port: 993, user: 'soporte@acme.com', pass: process.env.IMAP_PASS! },
  smtp: { host: 'smtp.gmail.com', port: 465, user: 'soporte@acme.com', pass: process.env.SMTP_PASS! },
})

const bot = new Bot({ provider })
bot.use(
  flow('cotizar')
    .ask('¿Cuántas unidades necesitas?', 'qty')
    .say((_ctx, c) => `Perfecto, preparo la cotización por ${c.state.qty} unidades.`),
)
await bot.start()
```

Con Gmail o Microsoft 365 usa una contraseña de aplicación o OAuth2 (`accessToken` en lugar de `pass`).

## Cómo se mapea el email

| Concepto | Email |
| --- | --- |
| `senderId` | Dirección `From` normalizada (minúsculas, sin `<>`). La misma persona → el mismo id. |
| `chatId` (modo `thread`, por defecto) | `thread:<Message-ID raíz>`: un chat por hilo, resuelto por `In-Reply-To` / `References` (y un índice de los Message-ID que envió el bot, así que funciona aunque el cliente recorte `References`). El chat pertenece a quien abrió el hilo: si otra dirección responde en él (un "responder a todos" o un `In-Reply-To` falsificado), recibe su propio chat. |
| `chatId` (modo `sender`) | La dirección del remitente: un chat por persona, como un DM. |
| `body` | Texto nuevo de la respuesta: se quitan el historial citado (`On … wrote:`, `El … escribió:`, bloques de Outlook, `>`) y la firma (`-- `). Si el email solo trae HTML se convierte a texto. Si queda vacío se usa el asunto. El texto completo está en `ctx.raw.text`. |
| Adjuntos | `ctx.raw.attachments` (todos) y `media` (el primero no inline); `type` pasa a `image`/`video`/`audio`/`document`. `provider.downloadMedia(ref)` devuelve los bytes (caché en memoria y, si se desalojó, se vuelve a pedir por IMAP solo si el UID sigue siendo el mismo mensaje). |
| Respuestas | `In-Reply-To`, `References`, `Re: <asunto>` y destinatario `From` (o `Reply-To` si es del mismo dominio; ver `replyTo`). |
| `send('persona@x.com', ...)` | Inicia un hilo nuevo con esa dirección (`platformData.subject` para el asunto). |
| Botones / listas / cards | Se degradan a texto numerado. `poll`, `reaction` y `template` lanzan `UnsupportedContentError`. |
| `native` | `{ kind: 'native', provider: 'email', payload: { subject, text, html, cc, bcc, headers, attachments } }`. Los adjuntos solo aceptan `{ filename, content: Buffer \| Uint8Array, contentType, cid }` (para archivos o URLs usa `image`/`document`, que pasan por `secureFetch`); las cabeceras de hilo y de protección contra bucles no se pueden sobrescribir. |

`options.platformData` en `send()` acepta `subject` y `html`.

## Protección contra bucles

Un bot que responde emails termina hablando con otro robot. Por defecto:

- No se procesan emails automáticos (RFC 3834): `Auto-Submitted` distinto de `no`, `List-Id`/`List-Unsubscribe`, `Precedence: bulk|junk|list`, `X-Autoreply`/`X-Autorespond`, `X-Auto-Response-Suppress`, `Return-Path: <>` y remitentes de sistema (`mailer-daemon`, `postmaster`, `no-reply`).
- Se ignoran los emails del propio bot.
- Tope por remitente: 30 mensajes por hora (`loopProtection.maxPerSender`).
- Todo lo que envía el bot lleva `Auto-Submitted: auto-replied` y `X-Auto-Response-Suppress: All` (desactivable con `autoSubmitted: false`).

```ts
new EmailProvider({ ..., loopProtection: { ignore: ['mailing-list'], maxPerSender: { max: 10, windowMs: 600_000 } } })
```

## Rebotes

Los informes de no entrega (DSN `multipart/report`, y rebotes "legacy" con `X-Failed-Recipients`) **no** llegan a los handlers: se emiten como evento `status` con `status: 'failed'`, el `ref` del email original, `recipient` y `error: { code: '5.1.1', message }`. Las direcciones con rebote permanente quedan suprimidas: `send()` a ellas lanza `RecipientUnreachableError` hasta `provider.unsuppress(address)` (`suppressBounced: false` lo desactiva).

Un rebote solo cuenta si se refiere a un email que **envió el bot** (su Message-ID está en el índice de salida) y el destinatario fallido es el de ese hilo; los rebotes legacy además tienen que venir de `MAILER-DAEMON`/`postmaster`. Así nadie puede bloquear una dirección enviando un rebote falso.

## Seguridad: el remitente no está autenticado

El email no autentica `From`: cualquiera puede escribir al bot haciéndose pasar por otra dirección. Por eso:

- Un hilo pertenece a quien lo abrió; otra dirección que responda en él recibe su propio chat y no ve ni redirige la conversación.
- `Reply-To` solo cambia el destinatario si es del mismo dominio que `From` (`replyTo: 'always'` para confiar siempre, `'never'` para ignorarlo).
- Con `requireAuthentication: { authservId: 'mx.tu-dominio.com' }` solo se aceptan emails con `dmarc=pass` (o `dkim=pass` alineado con el dominio de `From`) en una cabecera `Authentication-Results` escrita por **tu** MTA; las demás se ignoran, porque el remitente puede añadir las que quiera. El resto se descarta con `reason: 'unauthenticated'`.

Sin `requireAuthentication`, trata `senderId` como una dirección declarada, no verificada: no reveles datos de un usuario (`ctx.user`, CRM) solo porque escribe "desde" su dirección. El tope por remitente también se puede agotar con remitentes falsificados.

## Persistir los hilos

El estado de los hilos (a quién responder, asunto, cadena `References`) vive en memoria por defecto. Para seguir respondiendo después de un reinicio, guárdalo en cualquier store con cursores:

```ts
import { Bot } from '@botmesh/core'
import { SQLiteStore } from '@botmesh/sqlite-store'
import { cursorThreadStore, EmailProvider } from '@botmesh/email'

const store = new SQLiteStore({ file: './bot.db' })
const provider = new EmailProvider({ ..., threadStore: cursorThreadStore(store) })
const bot = new Bot({ provider, store })
```

`cursorThreadStore` guarda también el **cursor de UID** del buzón (`getMailboxCursor`/`setMailboxCursor`, opcionales en `EmailThreadStore`): tras un reinicio el bot sigue después del último UID que procesó, así que con `markSeen: false` no vuelve a entregar nada, y un correo que llegó con el bot parado y que alguien ya leyó en su cliente se procesa igual. Si el `UIDVALIDITY` del buzón cambió, el cursor no vale y el bot empieza desde `UIDNEXT`. Sin cursor guardado se aplica `processExisting`. Entre `stop()` y `start()` de la misma instancia el cursor se conserva siempre.

## IMAP IDLE

El bot selecciona el buzón y queda en IDLE: el servidor avisa de cada correo nuevo y el bot lo descarga por UID. `imapflow` entra en IDLE tras un periodo sin comandos; el provider lo baja a 1 s (`autoIdleDelay: 1000`, el valor de `imapflow` es 15 s) para que el correo nuevo llegue enseguida. Se puede cambiar con `imap.options.autoIdleDelay`.

## Webhook de correo entrante

Sin IMAP, `ingest()` acepta el MIME crudo (Buffer/string) de SES, Mailgun ("raw MIME"), un pipe de Postfix, etc., y devuelve `{ status, accepted, reason? }` (`413` si supera `maxInboundBytes`; limita también el body en tu servidor HTTP):

```ts
app.post('/inbound-email', async (req, res) => {
  const result = await provider.ingest(req.rawBody)
  res.sendStatus(result.status)
})
```

## Errores tipados

| SMTP | Error |
| --- | --- |
| 550/551/553, `5.1.x`, destinatario rechazado | `RecipientUnreachableError` |
| 552, `5.3.4`, adjuntos > `maxAttachmentBytes` (25 MiB) | `PayloadTooLargeError` |
| 4xx (421, 450, 451, 452) | `RateLimitedError` (`retryAfterMs` 60 s) |
| Autenticación (`EAUTH`, 535) y el resto | `ProviderError` |

## Opciones

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `address` | `smtp.user`/`imap.user` si son direcciones | Dirección del bot (`From` y `selfId`). |
| `fromName` | — | Nombre visible en `From`. |
| `imap` | — | `{ host, port=993, secure, user, pass \| accessToken, mailbox='INBOX', options }`. |
| `smtp` | — | `{ host, port=465, secure, user, pass \| accessToken, verify=false, options }`. |
| `threading` | `'thread'` | `'thread'` o `'sender'`. |
| `threadStore` | memoria | `MemoryThreadStore` o `cursorThreadStore(store)`. |
| `processExisting` | `'unseen'` | Al primer arranque (sin cursor de UID guardado): procesar los no leídos o empezar desde ahora (`'none'`). |
| `markSeen` | `true` | Marcar como leídos los emails procesados. |
| `stripQuotes` | `true` | Quitar historial citado y firma del `body`. |
| `defaultSubject` | `'(no subject)'` | Asunto de hilos nuevos sin asunto. |
| `loopProtection` | activo | `false` o `{ ignore, maxPerSender }`. |
| `autoSubmitted` | `'auto-replied'` | Valor de `Auto-Submitted` saliente, o `false`. |
| `suppressBounced` | `true` | Rechazar envíos a direcciones con rebote permanente. |
| `maxAttachmentBytes` | 25 MiB | Límite de adjuntos por email saliente. |
| `attachmentCacheBytes` | 32 MiB | Caché de adjuntos entrantes para `downloadMedia`. |
| `maxInboundBytes` | 40 MiB | Tamaño máximo de un email entrante. Por IMAP se descarta sin descargarlo (y se marca como leído si `markSeen`); `ingest()` responde `413`. |
| `replyTo` | `'same-domain'` | Cuándo responder a `Reply-To` en vez de a `From`: `'same-domain'`, `'always'` o `'never'`. |
| `requireAuthentication` | — | `{ authservId }`: aceptar solo emails autenticados por tu MTA (`Authentication-Results`). |
| `reconnect` | `{ baseMs: 1000, maxMs: 60000 }` | Backoff de reconexión IMAP. |
| `http` | — | Opciones de `secureFetch` para adjuntos por URL. |
| `createImapClient` / `smtpTransport` | — | Inyectar clientes propios (o fakes en tests). |

## Tests de integración

Los tests de `tests/*.test.ts` son herméticos: IMAP y SMTP falsos en memoria. `tests/integration.test.ts` carga los peers reales (`imapflow` y `nodemailer`, `devDependencies` del paquete) y habla IMAP IDLE + SMTP con un servidor de verdad, [GreenMail](https://greenmail-mail-test.github.io/greenmail/), en Docker. Se salta si no defines `BOTWA_TEST_EMAIL`:

```bash
docker run -d --name botwa-it-greenmail \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  -p 127.0.0.1:3025:3025 -p 127.0.0.1:3143:3143 greenmail/standalone:2.1.3

BOTWA_TEST_EMAIL=1 pnpm --filter @botmesh/email test

docker rm -f botwa-it-greenmail
```

En PowerShell: `$env:BOTWA_TEST_EMAIL = '1'`. El host y los puertos se cambian con `BOTWA_TEST_EMAIL_HOST` (`127.0.0.1`), `BOTWA_TEST_EMAIL_SMTP_PORT` (`3025`) y `BOTWA_TEST_EMAIL_IMAP_PORT` (`3143`), los puertos sin TLS de GreenMail. Con `greenmail.auth.disabled` cualquier login vale y los buzones se crean al vuelo; cada test usa direcciones nuevas, así que se puede repetir contra el mismo contenedor.

Qué cubre: entrada por IMAP IDLE con `chatId`/`senderId` estables; hilos por `Message-ID`/`In-Reply-To`/`References`; respuestas que llegan al buzón del usuario con `In-Reply-To`, `References`, `Re:` y `Auto-Submitted`; adjuntos como `MediaRef` y `downloadMedia` (desde la caché y volviendo a pedirlos por IMAP); HTML a texto; descarte de respuestas automáticas, listas y `Precedence: bulk`; reinicios sin volver a entregar correo (con `markSeen` y con el cursor de UID persistido), y un flujo `ask()` del `Bot` contestado por email.
