# @bot-wa/email

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Transporte **email** para [`@bot-wa/core`](../core): **IMAP IDLE** para recibir (o `ingest()` con el MIME crudo desde un webhook de correo entrante) y **SMTP** para responder. Cada hilo de correo es un chat, así que los flows (`flow().ask()...`) funcionan igual que en WhatsApp o Telegram: el cliente responde al email y el bot continúa la conversación en el mismo hilo.

## Instalación

```bash
pnpm add @bot-wa/core @bot-wa/email
pnpm add imapflow nodemailer   # peers opcionales: IMAP (entrada) y SMTP (salida)
```

`imapflow` y `nodemailer` son `peerDependencies` **opcionales** y se cargan de forma lazy: si solo envías, no necesitas `imapflow`; si solo recibes por `ingest()`, no necesitas ninguno de los dos para recibir.

## Uso

```ts
import { Bot, flow } from '@bot-wa/core'
import { EmailProvider } from '@bot-wa/email'

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
| `chatId` (modo `thread`, por defecto) | `thread:<Message-ID raíz>`: un chat por hilo, resuelto por `In-Reply-To` / `References` (y un índice de los Message-ID que envió el bot, así que funciona aunque el cliente recorte `References`). |
| `chatId` (modo `sender`) | La dirección del remitente: un chat por persona, como un DM. |
| `body` | Texto nuevo de la respuesta: se quitan el historial citado (`On … wrote:`, `El … escribió:`, bloques de Outlook, `>`) y la firma (`-- `). Si el email solo trae HTML se convierte a texto. Si queda vacío se usa el asunto. El texto completo está en `ctx.raw.text`. |
| Adjuntos | `ctx.raw.attachments` (todos) y `media` (el primero no inline); `type` pasa a `image`/`video`/`audio`/`document`. `provider.downloadMedia(ref)` devuelve los bytes (caché en memoria y, si se desalojó, se vuelve a pedir por IMAP). |
| Respuestas | `In-Reply-To`, `References`, `Re: <asunto>` y destinatario `Reply-To` → `From`. |
| `send('persona@x.com', ...)` | Inicia un hilo nuevo con esa dirección (`platformData.subject` para el asunto). |
| Botones / listas / cards | Se degradan a texto numerado. `poll`, `reaction` y `template` lanzan `UnsupportedContentError`. |
| `native` | `{ kind: 'native', provider: 'email', payload: { subject, html, cc, bcc, headers, attachments } }`. |

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

## Persistir los hilos

El estado de los hilos (a quién responder, asunto, cadena `References`) vive en memoria por defecto. Para seguir respondiendo después de un reinicio, guárdalo en cualquier store con cursores:

```ts
import { SQLiteStore } from '@bot-wa/sqlite-store'
import { cursorThreadStore, EmailProvider } from '@bot-wa/email'

const store = new SQLiteStore({ file: './bot.db' })
const provider = new EmailProvider({ ..., threadStore: cursorThreadStore(store) })
const bot = new Bot({ provider, store })
```

## Webhook de correo entrante

Sin IMAP, `ingest()` acepta el MIME crudo (Buffer/string) de SES, Mailgun ("raw MIME"), un pipe de Postfix, etc., y devuelve `{ status, accepted, reason? }`:

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
| `processExisting` | `'unseen'` | Al primer arranque: procesar los no leídos o empezar desde ahora (`'none'`). |
| `markSeen` | `true` | Marcar como leídos los emails procesados. |
| `stripQuotes` | `true` | Quitar historial citado y firma del `body`. |
| `defaultSubject` | `'(no subject)'` | Asunto de hilos nuevos sin asunto. |
| `loopProtection` | activo | `false` o `{ ignore, maxPerSender }`. |
| `autoSubmitted` | `'auto-replied'` | Valor de `Auto-Submitted` saliente, o `false`. |
| `suppressBounced` | `true` | Rechazar envíos a direcciones con rebote permanente. |
| `maxAttachmentBytes` | 25 MiB | Límite de adjuntos por email saliente. |
| `attachmentCacheBytes` | 32 MiB | Caché de adjuntos entrantes para `downloadMedia`. |
| `reconnect` | `{ baseMs: 1000, maxMs: 60000 }` | Backoff de reconexión IMAP. |
| `http` | — | Opciones de `secureFetch` para adjuntos por URL. |
| `createImapClient` / `smtpTransport` | — | Inyectar clientes propios (o fakes en tests). |
