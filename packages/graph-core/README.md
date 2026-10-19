# @bot-wa/graph-core

Helpers compartidos de **Meta Graph** para los transportes de Meta de [`@bot-wa/core`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core):
[`@bot-wa/meta`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/meta-provider) (WhatsApp Cloud API), [`@bot-wa/messenger`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/messenger-provider) e
[`@bot-wa/instagram`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/instagram-provider). Las tres plataformas verifican el webhook igual, firman igual y
devuelven los mismos códigos de error de Graph; este paquete reúne esa lógica en un solo sitio para que no se
duplique en cada provider.

> **Paquete interno.** Lo usan los providers; para montar un bot no necesitas importarlo. Forma parte de la
> primera alpha como dependencia de `@bot-wa/meta`, y todavía no está en npm.

## Instalación

```bash
pnpm add @bot-wa/graph-core
```

Cero dependencias extra: solo `@bot-wa/core` y `crypto` nativo de Node ≥ 22.

## Qué incluye

| Export | Para qué sirve |
|---|---|
| `verifyChallenge(query, verifyToken)` | Handshake `GET` del webhook. Devuelve el `hub.challenge` a responder (HTTP 200) o `null` si el token no coincide (responde 403). |
| `verifySignature(rawBody, header, appSecret)` | Verifica `X-Hub-Signature-256` = HMAC-SHA256 del body con el app secret, en tiempo constante. `false` si falta el secret, el header o no coincide. |
| `checkGraphSignature(body, headers, appSecret, logger?)` | Guard de ingest: `{ ok: true }` o `{ ok: false, status }`. Con `appSecret` exige el body **crudo** (`string`/`Buffer`) y rechaza uno ya parseado con `400`; una firma inválida da `403`. |
| `parseGraphBody<T>(body)` | Convierte el body (string, `Buffer` u objeto ya parseado) en `T`. |
| `toGraphError(err, { chatId?, retryAfterMs?, contentKind? })` | Traduce un error de Graph a las subclases de `ProviderError` del core. |

## Uso

Así lo usa un provider en su `ingest()`:

```ts
import { checkGraphSignature, parseGraphBody, verifyChallenge } from '@bot-wa/graph-core'

// GET /webhook: handshake de suscripción
const challenge = verifyChallenge(query, process.env.META_VERIFY_TOKEN!)
// challenge === null → 403

// POST /webhook: verificar la firma y parsear
const sig = checkGraphSignature(rawBody, headers, process.env.META_APP_SECRET, logger)
if (!sig.ok) return sig.status // 400 (body no crudo) o 403 (firma inválida)
const payload = parseGraphBody<MyWebhookBody>(rawBody)
```

> **Firma sobre los bytes crudos.** Meta firma exactamente los bytes que envía. Si re-serializas el JSON
> (p. ej. con `express.json()` sin guardar el body original), la firma deja de cuadrar. Pasa siempre el body
> crudo: `express.raw()`, o el `Buffer` que acumulas con `node:http`.

Sin `appSecret`, `checkGraphSignature` deja pasar la petición. Por eso los providers exigen `appSecret` y solo
aceptan omitirlo con un opt-in explícito para desarrollo local (`allowUnsignedWebhooks: true` en
`CloudAPIProvider`).

## Mapeo de errores

`toGraphError` cubre tanto los códigos de negocio de WhatsApp como los rate limits genéricos de
Facebook/Instagram:

| Código Graph | Error del core |
|---|---|
| `131047`: fuera de la ventana de 24 h (WhatsApp) | `OutsideSessionWindowError` (envía una plantilla, `kind: 'template'`) |
| `131026`: destinatario no puede recibir | `RecipientUnreachableError` |
| `131051`: tipo de mensaje no soportado | `UnsupportedContentError` (`kind`: el `contentKind` del envío, o `'native'`) |
| `131062`: el destinatario BSUID no admite este mensaje (WhatsApp; plantillas de autenticación *one-tap*, *zero-tap* y *copy code*) | `UnsupportedContentError` (`kind`: el `contentKind` del envío, o `'template'`); envíalo al teléfono (`wa_id`) |
| `4`, `613`, `80007`, `36003`: rate limit | `RateLimitedError` (`retryAfterMs` o 60 s por defecto) |
| cualquier otro (incluidos `147001`–`147005` de la API de nombres de usuario) | `ProviderError` |

`contentKind` es el `kind` del `OutboundContent` que falló. Pásalo si lo conoces: así
`UnsupportedContentError.kind` dice qué contenido rechazó Graph en vez del valor por defecto de cada código.

```ts
import { toGraphError } from '@bot-wa/graph-core'

const err = toGraphError({ code: 131047, message: 'Re-engagement message' }, { chatId })
// err instanceof OutsideSessionWindowError
```
