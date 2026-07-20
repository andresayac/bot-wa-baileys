# 📋 Documentación del Proyecto — `bot-wa-baileys`

> Bot de WhatsApp construido con la librería [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys), orientado a ser usado como **provider** por un sistema de bots (estilo `bot-whatsapp` / `@bot-wa`), o de forma standalone.

- **Nombre del paquete:** `@bot-wa/bot-wa-baileys`
- **Versión:** `1.1.5`
- **Autor:** Andres Aya
- **Licencia:** MIT
- **Repo:** https://github.com/andresayac/bot-wa-baileys

---

## 🧰 Stack Tecnológico

| Categoría              | Tecnología / Librería                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| **Lenguaje**           | TypeScript 5.9 (compila a ES2018 / CommonJS)                                                        |
| **Runtime**            | Node.js (≥18 recomendado) — compatible con Bun                                                      |
| **Core WhatsApp**      | `@whiskeysockets/baileys` ^6.7.21 (cliente no oficial de WhatsApp Multi-Device)                     |
| **Gestor de paquetes** | pnpm (lockfile presente) · npm y yarn compatibles                                                   |
| **Logging**            | `pino` 10 (logger modo `fatal` por defecto, `debug` opcional)                                       |
| **Errores**            | `@hapi/boom` (manejo de códigos de desconexión Baileys)                                             |
| **Caché**              | `node-cache` (retry counter de mensajes, signal key store cacheable)                                |
| **Procesamiento media**| `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` (audio/video/OGG → OPUS)                               |
| **Imágenes**           | `sharp` 0.34 (procesado de stickers/imágenes)                                                       |
| **Descargas HTTP**     | `follow-redirects` (descarga de media remota)                                                       |
| **MIME / QR**          | `mime-types`, `qrcode-terminal`, `qr-image` (QR en terminal y como PNG)                             |
| **Autenticación**      | `useMultiFileAuthState` (auth state persistente en `bot_sessions/`)                                 |
| **Almacenamiento**     | Store en memoria con serialización a `baileys_store.json`                                           |

---

## ✨ Características Principales

### 🔌 Conexión y Autenticación
- ✅ Login por **QR Code** (terminal + archivo `qr.png`)
- ✅ Login por **Pairing Code** (número telefónico, sin QR) mediante `usePairingCode: true` + `phoneNumber`
- ✅ Sesión persistente en disco (`bot_sessions/`) con `useMultiFileAuthState`
- ✅ Reconexión automática ante desconexiones (`connectionClosed`, `connectionLost`, `restartRequired`…)
- ✅ Detección y borrado de sesión corrupta en casos `badSession`, `loggedOut`, `multideviceMismatch`
- ✅ Detección automática de la versión más reciente del protocolo de Baileys

### 📨 Envío de Mensajes (API del provider)
Métodos públicos de la clase `BaileysClass` (todos `async`):

| Método                        | Descripción                                                              |
| ----------------------------- | ------------------------------------------------------------------------ |
| `sendText(number, text)`      | Mensaje de texto                                                         |
| `sendMessage(number, msg, o)` | Mensaje extendido (con opciones: media, buttons, quoted…)                |
| `sendMedia(number, url, txt)` | Media por URL o ruta local (detecta tipo automáticamente)               |
| `sendImage(number, file, t)`  | Imagen (URL o path) con caption opcional                                 |
| `sendVideo(number, file, t)`  | Video (URL o path) con caption opcional                                  |
| `sendAudio(number, url)`      | Audio (con conversión automática a OPUS vía ffmpeg)                      |
| `sendFile(number, file)`      | Documento / archivo (PDF, DOCX, etc.)                                    |
| `sendPoll(number, text, poll)`| Encuestas con opciones y multiselect                                     |
| `sendLocation(jid, lat, lng)` | Ubicación por coordenadas                                                |
| `sendContact(jid, num, name)` | Compartir contacto                                                       |
| `sendPresenceUpdate(jid, p)`  | Estados de presencia (`recording`, `composing`, `available`…)            |
| `sendSticker(jid, url, opt)`  | Sticker desde imagen/GIF (procesado con `sharp` + ffmpeg)                |
| `sendReaction(jid, emoji, k)` | Reaccionar a un mensaje                                                  |
| `sendTextWithQuote(n, t, q)`  | Texto citando otro mensaje (reply)                                       |
| ⚠️ `sendButtons`              | *Deprecated* — los botones nativos fueron removidos por WhatsApp         |

### 📥 Recepción de Mensajes y Eventos
Patrón basado en `EventEmitter`. Eventos emitidos por `BaileysClass`:

| Evento          | Payload                                            | Cuándo se empte                                          |
| --------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `qr`            | `string` (payload QR)                              | Se requiere escanear un nuevo QR                         |
| `ready`         | `true`                                             | Conexión abierta y evento bus inicializado               |
| `auth_failure`  | `error`                                            | Fallo de autenticación                                   |
| `pairing_code`  | `string` (código 8 dígitos)                        | Login por pairing code (modo standalone)                 |
| `require_action`| `{ instructions: string[] }`                       | Acción requerida (QR/PIN) cuando se usa como **plugin**  |
| `message`       | `messageCtx + body/from/type/messageType`          | Llegada de mensaje nuevo de texto                        |
| `message`       | `payload con type:'poll'`                          | Cambios de votos en encuestas (`messages.update`)        |
| `reaction`      | `{ from, reaction, key, messageId }`               | Reacción recibida (`messages.reaction`)                  |

El `payload` del evento `message` normaliza el `body` y agrega un campo `type` que detecta:
`text`, `image`, `video`, `voice`, `sticker`, `file`, `location`, `contact`, incluyendo
respuestas de **botones** (`buttonsResponseMessage`) y **listas** (`listResponseMessage`).

### 🧩 Sistema de Flows (Constructores de Conversación)
Builder tipo DSL inspirado en `bot-whatsapp`. Definido en `src/flows.ts`:

```ts
addKeyword(['hola', 'hi', 'hello'])
    .addAnswer(['👋 ¡Hola!', '¿En qué puedo ayudarte?'])
    .addAnswer('Elige una opción:', { delay: 500 })
    .addAnswer('¿Cuál es tu nombre?', { capture: true }, async (ctx, { state }) => {
        state.set('name', ctx.body)
    })
    .addAction(async (ctx, { state, flowDynamic }) => {
        await flowDynamic(`Hola ${state.get('name')}!`)
    })
```

- `addKeyword(string | string[])` — palabras que disparan el flow (no case-sensitive por defecto).
- `.addAnswer(texto | array, options?, action?)` — envía respuesta; soporta `capture`, `delay`, `buttons`.
- `.addAction(fn)` — ejecuta lógica sin enviar mensaje.
- `.toSensitive()` — activa matching case-sensitive.
- **Tools inyectados** en cada acción: `state` (Map por usuario), `flowDynamic`, `gotoFlow`, `endFlow`.
- El `FlowManager` mantiene estado por usuario (`activeFlows`) y orquesta los pasos.
- Cuando un flow está activo, el evento `message` se **suprime** (consume el mensaje).

### 💾 Store Concurrente (`src/store.ts`)
- `ConcurrentStore` extiende `EventEmitter`: chats, mensajes, contactos y groupMetadata en memoria.
- Persistencia a `baileys_store.json` con **auto-save** (cada 60s por defecto).
- **Write locks** y `pendingWrites` para evitar condiciones de carrera durante sync.
- **Backup** antes del histórico inicial para preservar datos (`backupBeforeSync`).
- Opciones de tuning: `maxMessagesPerChat`, `autoSaveInterval`, `batchSize`, `incrementalSave`.

### 🛠️ Utilidades (`src/utils.ts`)
- `formatPhone`, `isValidNumber`, `isUrl`, `generateRefprovider`
- `prepareMedia` — detecta si media es URL o path local y devuelve `{url}` o `{buffer}`
- `generalDownload` — descarga archivos locales o remotos con manejo de redirects y MIME
- Procesamiento de audio/video con ffmpeg y stickers con `sharp`/`qr-image`
- `baileyGenerateImage` — genera `qr.png` a partir del payload QR

---

## 📁 Estructura del Proyecto

```
bot-wa-baileys/
├── src/                       # Código fuente TypeScript
│   ├── baileys.ts             # ⭐ Provider principal: BaileysClass (EventEmitter)
│   ├── flows.ts               # ⭐ Sistema de flows (Flow, FlowManager, addKeyword)
│   ├── store.ts               # Store concurrente en memoria + persistencia JSON
│   └── utils.ts               # Helpers: media, phone, downloads, QR, ffmpeg, sharp
├── examples/
│   └── bot.ts                 # Ejemplo completo con múltiples flows
├── lib/                       # Salida compilada (tsc) — distribuida por npm
├── bot_sessions/              # Auth state + keys + sessions (auto-generada)
│   ├── creds.json
│   ├── pre-key-*.json
│   ├── session-*.json
│   ├── sender-key-*.json
│   └── app-state-sync-*.json
├── baileys_store.json         # Serialización del store en memoria
├── old_project/               # Versiones anteriores (referencia/histórico)
├── package.json               # Metadata + deps (nombre: @bot-wa/bot-wa-baileys)
├── tsconfig.json              # Config TS: ES2018, CommonJS, declaration: true
├── pnpm-lock.yaml             # Lockfile pnpm
├── README.md                  # Doc original de la API
├── LICENSE.md                 # MIT
├── .gitignore / .npmignore    # Archivos a ignorar
└── PROJECT.md                 # 👈 Este documento
```

---

## 🚀 Instalación y Uso

### Como librería (npm)
```bash
npm i @bot-wa/bot-wa-baileys
# o
pnpm add @bot-wa/bot-wa-baileys
```

```ts
import { BaileysClass, addKeyword } from '@bot-wa/bot-wa-baileys'

const bot = new BaileysClass({})

// Eventos de conexión
bot.on('qr',      qr  => console.log('QR:', qr))
bot.on('ready',   ()  => console.log('✅ READY'))
bot.on('auth_failure', e => console.error('Auth error', e))

// Definir flows
const flow = addKeyword('hola')
    .addAnswer('¡Hola! ¿Cómo te llamas?', { capture: true })
    .addAnswer(async (ctx, { flowDynamic }) => {
        await flowDynamic(`Encantado, ${ctx.body}!`)
    })

bot.addFlows([flow])

// Mensajes que no matchean ningún flow
bot.on('message', async (msg) => {
    await bot.sendText(msg.from, 'Recibí: ' + msg.body)
})
```

### Desarrollo local (standalone)
```bash
git clone https://github.com/andresayac/bot-wa-baileys.git
cd bot-wa-baileys
pnpm i
pnpm run example      # tsc && node examples/bot.ts
```
Escanea el QR que aparece en la terminal o en el archivo `*.qr.png`.

### Login por Pairing Code (sin QR)
```ts
new BaileysClass({ usePairingCode: true, phoneNumber: '57300XXXXXXX' })
bot.on('pairing_code', code => console.log('Código:', code))
```

---

## ⚙️ Configuración (`BaileysClass` constructor args)

| Opción            | Tipo      | Default     | Descripción                                           |
| ----------------- | --------- | ----------- | ----------------------------------------------------- |
| `name`            | `string`  | `'bot'`     | Nombre del bot (usado en `bot_sessions/` y `qr.png`)  |
| `dir`             | `string`  | `'./'`      | Directorio base donde crear `{name}_sessions`         |
| `debug`           | `boolean` | `false`     | Activa logs `pino` nivel `debug`                      |
| `usePairingCode`  | `boolean` | `false`     | Login por código en lugar de QR                       |
| `phoneNumber`     | `string?` | `null`      | Requerido si `usePairingCode: true`                   |
| `gifPlayback`     | `boolean` | `false`     | Reproducción de GIFs en stickers animados             |

---

## 🏗️ Detección de modo Plugin

En el constructor, `BaileysClass` analiza el `stack trace`. Si detecta
`createProvider` en la pila (es decir, está siendo instanciada por un framework
tipo `bot-whatsapp`), activa `this.plugin = true` y emite eventos con el shape
`require_action` + `instructions[]` en lugar de `qr`/`pairing_code` directos.

---

## 🔒 Seguridad y Buenas Prácticas
- 🔴 **Nunca** subir `bot_sessions/` (contiene claves privadas Signal) — verificado en `.gitignore`
- 🔴 **Nunca** subir `baileys_store.json` (contiene conversaciones)
- 🔴 **Nunca** subir `*.qr.png` (QRs de emparejamiento)
- La carpeta `bot_sessions/` se **borra automáticamente** ante `loggedOut` o `multideviceMismatch`
- Rotación automática de pre-keys gestionada por Baileys

---

## 🧪 Scripts disponibles

| Script           | Comando                              | Uso                                  |
| ---------------- | ------------------------------------ | ------------------------------------ |
| `build`          | `tsc`                                | Compila `src/` → `lib/` (con `.d.ts`)|
| `example`        | `tsc && node -r ... examples/bot.ts` | Corre el ejemplo completo con flows |

---

## 📦 Publicación a npm

El campo `"files": ["./lib/**/*"]` en `package.json` asegura que solo se
publique el output compilado en `lib/`. El `main` y los `types` apuntan a
`lib/baileys.{js,d.ts}`.

```bash
pnpm build          # compilar
npm publish --access public
```

---

## 🐛 Troubleshooting Común

| Problema                           | Solución                                                              |
| ---------------------------------- | --------------------------------------------------------------------- |
| QR caduca muy rápido               | Es normal (~1 min). Re-escanea; el bot emite `qr` nuevamente          |
| `badSession` al iniciar            | Borra `bot_sessions/` y vuelve a autenticar                           |
| Los audios no se reproducen        | Verifica que `ffmpeg` esté instalado (`@ffmpeg-installer` lo incluye) |
| No recibe mensajes en grupos       | Revisa permisos del grupo y que el número esté participando           |
| `ERR_PNPM_IGNORED_BUILDS`          | Ejecuta `pnpm approve-builds` para `sharp`, `ffmpeg`, etc.            |
| Stickers se ven pixelados          | Usa imágenes cuadradas (512×512) y source PNG/JPEG de buena calidad   |

---

## 📚 Recursos
- **Baileys (docs API):** https://baileys.wiki
- **Repo base referencia:** https://github.com/WhiskeySockets/Baileys
- **Issues del proyecto:** https://github.com/andresayac/bot-wa-baileys/issues

---

*Documento generado automáticamente a partir del análisis del código fuente. Última actualización: 2026-07-17.*
