# Seguridad

Qué verifica el framework por ti en cada superficie no confiable, qué tienes
que configurar tú y qué riesgos quedan. La sección siguiente es el resultado de
la auditoría de octubre de 2026 de las superficies nuevas (ingress de webhooks,
API REST del manager, canales y plugins nuevos). Para reportar una
vulnerabilidad, sigue [`SECURITY.md`](https://github.com/andresayac/bot-wa-baileys/blob/main/SECURITY.md).

## Auditoría de seguridad (2026-10)

**Alcance:** `@bot-wa/server`, `twilio`, `gohighlevel`, `gupshup`, `evolution`,
`wppconnect`, `email`, `tiktok`, `chatwoot`, `voice`, `rag`, `manager` (REST
`/v1` y el antiguo `createManagerApi`), `dialogflow`, `moderation`, los webhooks
de `meta`/`messenger`/`instagram` (`@bot-wa/graph-core`) y `telegram`, más el
cliente HTTP compartido `@bot-wa/http`.

Cada problema corregido en la auditoría tiene su test de regresión (busca
`security-audit` en los tests del paquete).

### Autenticación de webhooks

| Canal | Mecanismo | Bytes crudos | Tiempo constante | Ventana anti-replay |
| --- | --- | --- | --- | --- |
| Meta (Cloud API, Messenger, Instagram) | HMAC-SHA256 `X-Hub-Signature-256` con `appSecret`; handshake `GET` con `verifyToken` | sí (un body ya parseado se rechaza) | sí (también el token del handshake) | Meta no firma un timestamp: dedupe por id de mensaje |
| Telegram | `X-Telegram-Bot-Api-Secret-Token` (`webhookSecret`) | n/a (secreto compartido) | sí | la plataforma no la ofrece |
| Twilio | HMAC-SHA1 `X-Twilio-Signature` sobre la URL exacta + parámetros ordenados; bodies JSON vía `bodySHA256` | sí | sí | la plataforma no la ofrece |
| TikTok | `TikTok-Signature: t=…,s=…` HMAC-SHA256 sobre `t.rawBody` | sí | sí | **sí**, ±300 s (`signatureToleranceSec`) |
| HighLevel | Ed25519 `X-GHL-Signature` (RSA heredado `X-WH-Signature` solo si configuras su clave) | sí | n/a (verificación de firma) | no se aplica; ver riesgos residuales |
| Gupshup, WPPConnect | token compartido en la URL del callback o en una cabecera (no firman) | n/a | sí | ninguna |
| Evolution | secreto en cabecera o JWT HS256 (`exp` obligatorio, ±30 s de desfase) | n/a | sí | el `exp` del JWT |
| Chatwoot | token compartido y/o HMAC-SHA256 (`x-chatwoot-signature`, `x-chatwoot-timestamp` opcional ±300 s) | sí | sí | solo si llega la cabecera de timestamp |

Ningún provider arranca sin credenciales salvo que pongas
`allowUnsignedWebhooks: true` (o `insecureNoWebhookAuth` en Chatwoot), y en ese
caso registra un aviso. El core deduplica los ids de entrada (`chatId` + id de
mensaje), lo que también absorbe la repetición de un mensaje ya visto mientras
siga en la ventana de dedupe.

### Verificado

- **Firmas sobre el body crudo.** Las firmas se calculan sobre los bytes
  recibidos, nunca sobre JSON re-serializado. `@bot-wa/server` lee el body
  crudo él mismo y responde `500` si un body parser lo consumió antes.
- **Límites del ingress** (`@bot-wa/server`): tamaño del body (`413`, por
  `Content-Length` y durante la lectura), timeouts de body e ingest
  (`408`/`503`), tope de concurrencia (`503` + `Retry-After`), cabeceras de
  respuesta a salvo de inyección (se rechazan CR/LF/NUL) y logs solo con
  metadatos (sin bodies ni mensajes de error que puedan citar un body).
- **SSRF saliente.** Todo fetch a una URL que llega de un webhook o de un
  usuario (descargas de media, adjuntos, STT/TTS, embeddings, Dialogflow) pasa
  por `secureFetch`: solo HTTPS por defecto, sin credenciales en la URL,
  respuestas DNS comprobadas contra rangos privados y socket fijado a la IP
  comprobada (sin DNS rebinding), cada redirección revalidada, timeouts y
  límites de tamaño.
- **REST `/v1` del manager.** Tokens obligatorios (≥ 16 caracteres, comparados
  como digests SHA-256 sin salida temprana), scopes por ruta, aislamiento por
  tenant (los bots de otro tenant responden `404`), rate limiting por token
  bucket, límite de `1 MiB` de JSON, `415` si no es JSON, campos en lista
  blanca, strings con longitud máxima, secretos redactados en la configuración
  devuelta y mensajes `500` genéricos. Los ids de bot y de tenant se limitan a
  `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` (sin `..`) antes de usarse como nombres de
  archivo.
- **Expresiones de flujos JSON.** Un parser descendente recursivo: sin
  `eval`/`Function`, sin regex, solo funciones en lista blanca,
  `__proto__`/`prototype`/`constructor` rechazados, solo rutas de propiedades
  propias, como mucho 1000 caracteres / 256 tokens / profundidad 32. Las
  plantillas (`{{ ruta }}`) solo resuelven rutas.
- **Email.** Las `headers` nativas deben ser de una línea y no pueden pisar las
  del provider (`From`, `To`, `Message-ID`, protección anti-bucles...); los
  adjuntos nativos deben estar en memoria (nada de `path`/`href` que nodemailer
  leería o descargaría por su cuenta).
- **Loaders de RAG**: solo leen rutas que da el operador, se saltan symlinks y
  archivos ocultos al recorrer directorios y limitan cada archivo (20 MiB).
- **Logs.** Revisadas todas las llamadas `logger.*` de los paquetes auditados:
  sin tokens, payloads de QR, cuerpos de mensaje ni direcciones; los errores se
  registran por clase o por el motivo que reporta el provider.

### Corregido en la auditoría

- **`@bot-wa/http`: bypass de SSRF por IPv6.** `isPrivateAddress` no entendía
  las IPv6 que embeben una IPv4: `https://[::ffff:7f00:1]/` (la forma a la que
  `URL` normaliza `::ffff:127.0.0.1`), `::127.0.0.1`, NAT64 (`64:ff9b::/96`),
  6to4 (`2002::/16`) y Teredo llegaban a direcciones internas. Ahora expande la
  IPv6 y juzga la IPv4 embebida; un literal que no se puede parsear se bloquea.
- **`@bot-wa/http`: redirecciones.** Al cambiar de origen también se quitan las
  cabeceras con pinta de credencial (`apikey`, `x-api-key`, `xi-api-key`,
  `x-auth-token`...), no solo `Authorization`/`Cookie`; un `303` (y un
  `301`/`302` tras un `POST`) sigue como `GET` sin body, como hace `fetch`.
- **`@bot-wa/manager`: SSRF vía `send`.** `POST /v1/bots/{id}/send` aceptaba
  cualquier URL `https` de media, y transportes como Baileys descargan los
  `{ url }` por su cuenta (fuera de `secureFetch`). Ahora se rechazan con `400`
  los hosts que son o resuelven a direcciones internas
  (`allowPrivateMediaHosts: true` para desactivarlo, `mediaHostResolver` para
  tests).
- **`@bot-wa/baileys`: SSRF por redirecciones.** Baileys descargaba los
  `{ url }` con `fetch` sin más, que sigue las redirecciones sin comprobarlas,
  así que una URL pública que respondía `302` hacia `http://169.254.169.254/…`
  se saltaba la comprobación de host de la API REST. Ahora el provider descarga
  la media remota él mismo con `@bot-wa/http` (cada salto revalidado, socket
  fijado a la dirección comprobada, límites de 64 MiB y 60 s) y le pasa un
  Buffer a Baileys. Se ajusta con `remoteMedia` (`maxBytes`, `timeoutMs`,
  `allowHttp`); `remoteMedia.allowPrivateHosts: true` recupera el paso directo
  anterior para media servida desde tu propia red.
- **`@bot-wa/manager`: fuga de errores.** El antiguo `createManagerApi`
  devolvía el mensaje del error en los `500`; ahora responde
  `"start failed"`/`"stop failed"` y entrega el error a `onError`.
- **`@bot-wa/graph-core`: verify token.** El handshake `GET` comparaba el token
  con `===` y aceptaba un token configurado vacío; ahora es en tiempo
  constante, no vacío y solo strings.
- **`@bot-wa/email`: inyección de cabeceras.** Asuntos y nombres visibles
  decodificados de RFC 2047 podían meter CR/LF en el `Subject`/`To` de la
  respuesta; se reducen a una línea. Los `cc`/`bcc` nativos deben ser
  direcciones simples.
- **`@bot-wa/gohighlevel`: replay entre locations.** HighLevel firma los
  webhooks de todas las apps con una sola clave de plataforma, así que un body
  firmado para otra location también verificaba aquí; los eventos sin
  `locationId` (o con otro) se ignoran.
- **`@bot-wa/chatwoot`: adjuntos de agentes.** Solo se reenvían URLs `http(s)`
  absolutas (Baileys lee de disco cualquier otro `{ url }`), los nombres de
  archivo pierden los separadores de ruta y un `%` mal formado ya no descarta
  el mensaje entero.
- **`@bot-wa/moderation`: escaneo cuadrático de enlaces.** `findLinks`
  comparaba cada invitación suelta con cada enlace (≈2,5 s con un mensaje de
  200 KB); ahora es lineal.

### Riesgos residuales

- **Sin ventana anti-replay de la plataforma** en Meta, Telegram, Twilio,
  HighLevel, Gupshup y WPPConnect: no firman un timestamp (o el de HighLevel no
  se aplica, porque sus reintentos pueden reutilizarlo). Una petición válida
  capturada se puede repetir; el dedupe por id del core solo cubre su ventana
  en memoria. Sirve los webhooks por HTTPS para que no se puedan capturar.
- **Tokens en la URL** (Gupshup, WPPConnect, Chatwoot `?token=`) acaban en los
  logs del proxy inverso y de acceso. Usa la cabecera cuando la plataforma lo
  permita y limpia los query strings de tus logs.
- **Reconstrucción de la URL en Twilio.** Sin `webhookUrl`, la URL firmada se
  reconstruye desde `X-Forwarded-Host`/`Host`. Pon `webhookUrl` (o usa
  `ingestRequest` con la URL exacta) detrás de proxies que no controlas.
- **Regex escritas por el operador.** Los filtros de palabras y los patrones de
  invitación de `moderation` aceptan `RegExp` y se ejecutan con cada mensaje:
  un patrón con backtracking catastrófico es un ReDoS. Usa strings, o solo
  patrones lineales.
- **Las fuentes de media string son rutas locales.** En `ctx.send`/`bot.sendTo`
  una fuente string o `{ path }` se lee de disco, y Baileys también lee de disco
  un `{ url }` que no sea `http`. Nunca pases texto del usuario como fuente de
  media; la API REST y Chatwoot ya lo limitan a URLs `http(s)`.
- **Transportes que descargan por su cuenta.** Evolution y WPPConnect pasan los
  `{ url }` a su propio servidor, que los descarga (y sigue redirecciones) desde
  su red; Cloud API, Messenger, Instagram, Twilio, Gupshup y HighLevel le dan el
  enlace a la plataforma. La API REST comprueba el primer host, pero una
  redirección la resuelve ese otro servidor, fuera de `secureFetch`. Despliega
  esos servidores donde un destino interno no sea alcanzable, o envía Buffers.
  Baileys está cubierto (descarga con `@bot-wa/http`) salvo que pongas
  `remoteMedia.allowPrivateHosts: true`.
- **El estado en memoria crece con los contactos**: los mapas de identidad
  LID/PN (Evolution, WPPConnect, Baileys), los contadores de avisos de
  moderación y la lista de supresión de email no tienen tope. El resto de
  mapas por chat están acotados.
- **Texto de error de terceros.** Los errores de STT/TTS/Dialogflow incluyen el
  mensaje corto del proveedor (≤ 200 caracteres); los proveedores enmascaran
  las claves, pero es texto de terceros.
- **El antiguo `createManagerApi`** no tiene autenticación salvo que pases
  `auth` (avisa una vez). Mejor `createRestApi`.
- **Nombres de dispositivo de Windows.** Ids de bot como `con` o `nul` pasan el
  patrón; evítalos si persistes bots en Windows.
