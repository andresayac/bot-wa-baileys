# @bot-wa/voice

> **Experimental — aún no publicado en npm.** Implementación real y probada, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Voz para bots de [`@bot-wa/core`](../core): **speech-to-text** (STT) de las notas de voz entrantes y **text-to-speech** (TTS) para responder con audio. Es un plugin, no un provider: funciona igual con WhatsApp (Baileys o Cloud API), Telegram o cualquier canal que entregue `voice`/`audio`.

- STT: OpenAI (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` y cualquier servidor compatible) y Deepgram (`nova-3`).
- TTS: OpenAI (`gpt-4o-mini-tts`, `tts-1`) y ElevenLabs.
- Sin SDKs: llamadas HTTPS con `secureFetch` de [`@bot-wa/http`](../http) (anti-SSRF, timeouts, límite de tamaño).
- `install()` síncrono; los adapters se resuelven en el primer uso y un `warmup()` no fatal avisa al arrancar si falta una api key.

Dentro del monorepo, decláralo como dependencia del workspace (todavía no se puede instalar desde npm):

```json
{ "dependencies": { "@bot-wa/voice": "workspace:*" } }
```

## Inicio rápido

```ts
import { VOICE_NOTE } from '@bot-wa/core'
import { voicePlugin } from '@bot-wa/voice'

bot.plug(voicePlugin({
  stt: { provider: 'openai', model: 'whisper-1', apiKey: process.env.OPENAI_API_KEY, language: 'es' },
  tts: { provider: 'openai', voice: 'nova', apiKey: process.env.OPENAI_API_KEY },
}))

// Una nota de voz que dice "Hola." también dispara este trigger:
bot.when('hola', (ctx) => ctx.reply('¡Hola! 👋'))

// Los triggers de tipo siguen funcionando, ahora con la transcripción a mano:
bot.when(VOICE_NOTE, async (ctx) => {
  await ctx.reply(`Dijiste: ${ctx.transcript}`)
  await ctx.voice(await ctx.tools.voice.synthesize('¡Entendido!'))
})
```

## Cómo funciona

### `autoTranscribe` (activo por defecto si hay `stt`)

Un hook `before('message')` (prioridad 100) descarga cada nota de voz, la transcribe y deja:

- `ctx.transcript`: el texto tal cual lo devolvió el servicio (`''` si no se dijo nada).
- `ctx.body`: el mismo texto sin la puntuación de los extremos (`¡Hola!` → `Hola`), para que los triggers por igualdad, `c.ask()`, la NLU y la IA "oigan" el audio.
- `ctx.media`: el audio descargado (no se vuelve a descargar).
- `ctx.transcriptError`: el error, si la transcripción falló. El mensaje **se sigue enrutando** (sin transcripción) y se registra un `warn`.
- `ctx.type`: sigue siendo `'voice'`, así que `VOICE_NOTE` sigue disparando. Con el modo por defecto `asText: 'auto'` pasa a `'text'` **solo mientras una conversación activa de ese usuario espera texto** (`c.ask()`, `c.waitText()`), para que la nota de voz responda a la pregunta. Si la conversación espera audio (`c.waitMedia(['voice'])`), un menú (`c.choose()`, que lee `body`) o cualquier mensaje (`c.waitAny()`), la nota llega como `'voice'` con su transcripción.

| Opción | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `types` | `('voice' \| 'audio')[]` | `['voice']` | Qué tipos transcribir. Añade `'audio'` para archivos de audio. |
| `setBody` | `boolean` | `true` | Escribe la transcripción en `ctx.body`. |
| `asText` | `boolean \| 'auto'` | `'auto'` | `true`: siempre `ctx.type = 'text'` (el autoresponder de `@bot-wa/ai` contesta audios, pero `VOICE_NOTE` deja de coincidir). `false`: nunca. |
| `trimPunctuation` | `boolean` | `true` | Quita la puntuación de los extremos del `body`. |
| `language` / `prompt` | `string` | — | Pistas para el STT en cada mensaje. Sin `language`, se usa el idioma que el i18n resolvió (`ctx.lang`, código base: `en-gb` → `en`) si viene de una señal real (preferencia, provider o `detect`), nunca el valor por defecto; si no, el servicio lo detecta. |
| `useContextLanguage` | `boolean` | `true` | `false` ignora `ctx.lang` como pista. |
| `filter` | `(ctx) => boolean` | — | Devuelve `false` para no transcribir (grupos grandes, usuarios sin plan…). |
| `priority` | `number` | `100` | Prioridad del hook. |
| `onError` | `(err, ctx) => void` | log `warn` | Qué hacer si falla la transcripción. |

`autoTranscribe: false` desactiva el hook; `ctx.tools.voice.transcribe(ctx)` sigue disponible a demanda.

### `autoReplyWithVoice` (desactivado por defecto)

Mientras el **último mensaje entrante** de un chat sea una nota de voz, el texto saliente hacia ese chat se sintetiza y se envía como nota de voz. Es un hook `before('send')`, así que cubre `ctx.reply`, `flow().say`, `c.say` y el autoresponder de IA. Si el usuario vuelve a escribir texto, el chat vuelve a texto. La salida de `ctx.stream()` (borradores, ediciones en vivo, trozos y mensaje final; payload `stream` en el hook) y las ediciones de `ctx.edit` **siempre se quedan en texto**.

| Opción | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `alsoText` | `boolean` | `false` | Envía la nota de voz y, después, el texto. |
| `maxChars` | `number` | `limits.maxTextChars` | Los textos más largos se quedan como texto. |
| `voice` / `instructions` | `string` | — | Voz y estilo para las respuestas. |
| `triggerTypes` | `('voice' \| 'audio')[]` | `['voice']` | Qué entrantes activan el modo voz. |
| `filter` | `(chatId, text) => boolean` | — | Devuelve `false` para mantener un texto como texto (p. ej. respuestas de un agente humano). |

Si la síntesis falla o el canal no admite `voice` (`capabilities.contentKinds`), se envía el texto original.

## `ctx.tools.voice`

| Método | Devuelve | Descripción |
| --- | --- | --- |
| `transcribe(source, opts?)` | `Promise<string>` | `source`: `ctx`, `ctx.media`, un `Buffer` o `{ buffer, mimetype?, filename?, durationSec? }`. |
| `transcribeDetailed(source, opts?)` | `Promise<Transcription>` | `{ text, language?, durationSec?, provider }`. |
| `synthesize(text, opts?)` | `Promise<Buffer>` | Audio listo para `ctx.voice(buffer)`. |
| `synthesizeDetailed(text, opts?)` | `Promise<SynthesizedAudio>` | `{ buffer, mimetype, format, provider }`. |
| `speak(ctx, text, opts?)` | `Promise<SentMessage>` | Sintetiza y envía con `ctx.voice()`. |
| `warmup()` | `Promise<void>` | Resuelve los adapters; rechaza con `VoiceConfigError`. |
| `hasStt` / `hasTts` / `limits` | — | Configuración efectiva. |

## Proveedores

```ts
// STT
{ provider: 'openai', apiKey, model: 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe', language, prompt, temperature, baseUrl }
{ provider: 'deepgram', apiKey, model: 'nova-3', language, smartFormat: true, query: { keyterm: 'BotWA' }, baseUrl }

// TTS
{ provider: 'openai', apiKey, model: 'gpt-4o-mini-tts', voice: 'alloy', format: 'opus', instructions, speed, baseUrl }
{ provider: 'elevenlabs', apiKey, voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_multilingual_v2', outputFormat: 'mp3_44100_128', voiceSettings, languageCode }
```

Las api keys caen a `OPENAI_API_KEY`, `DEEPGRAM_API_KEY` y `ELEVENLABS_API_KEY`. Todos aceptan `timeoutMs` (solo puede acortar `limits.timeoutMs`), `maxResponseBytes` y, para servidores propios en una red de confianza, `allowHttp` / `allowPrivateHosts` (p. ej. `faster-whisper-server` en `http://127.0.0.1:8000/v1`).

También puedes pasar un adapter propio (un modelo local, otro servicio):

```ts
import type { SttAdapter } from '@bot-wa/voice'

const local: SttAdapter = {
  name: 'local-whisper',
  async transcribe(audio, opts) {
    return { text: await myWhisper(audio.buffer, opts?.language), provider: 'local-whisper' }
  },
}
bot.plug(voicePlugin({ stt: local }))
```

## Formatos de audio

- **Entrada:** las notas de voz de WhatsApp y Telegram llegan en OGG/Opus, que Whisper, `gpt-4o-*-transcribe` y Deepgram aceptan directamente. Si el canal no informa el mimetype, se detecta por los primeros bytes (OGG, WAV, MP3, MP4/M4A, WebM, FLAC, AMR) y, si no, se asume OGG.
- **Salida para WhatsApp:** una nota de voz (PTT) debe ser **OGG/Opus**. `@bot-wa/baileys` transcodifica `kind: 'voice'` a OGG/Opus por su cuenta (con el binario de `ffmpeg` que incluye vía `@ffmpeg-installer/ffmpeg`), así que cualquier formato vale. Para Cloud API y Telegram pide OGG/Opus al TTS: es el valor por defecto en OpenAI (`format: 'opus'`); en ElevenLabs usa `outputFormat: 'opus_48000_64'` si tu plan lo ofrece (por defecto es `mp3_44100_128`, que Telegram y Cloud API aceptan como audio pero no siempre como nota de voz).
- No hay transcodificación dentro de este paquete (no depende de `ffmpeg`).

## Límites

```ts
voicePlugin({
  stt, tts,
  limits: {
    maxInputBytes: 25 * 1024 * 1024, // tamaño máximo del audio; corta la descarga en cuanto se pasa (límite de OpenAI)
    maxDurationSec: 300,             // duración máxima; se lee del último page OGG antes de llamar al servicio
    maxTextChars: 4096,              // caracteres máximos por síntesis
    timeoutMs: 60_000,               // tiempo máximo por llamada STT/TTS; también es el timeout HTTP de los adapters
  },
})
```

La duración se comprueba **antes** de pagar la transcripción cuando se conoce (`durationSec` explícito o un OGG). Para otros contenedores no se estima.

## Errores

Todos extienden `VoiceError` y llevan un `code` estable:

| Clase | `code` | Cuándo |
| --- | --- | --- |
| `VoiceConfigError` | `CONFIG` | Falta api key, proveedor desconocido, STT/TTS sin configurar. |
| `VoiceError` | `NO_MEDIA` | El mensaje no tiene audio / el texto está vacío. |
| `AudioTooLargeError` | `AUDIO_TOO_LARGE` | Supera `maxInputBytes`. |
| `AudioTooLongError` | `AUDIO_TOO_LONG` | Supera `maxDurationSec`. |
| `TextTooLongError` | `TEXT_TOO_LONG` | Supera `maxTextChars`. |
| `VoiceTimeoutError` | `TIMEOUT` | Se agotó `timeoutMs`. |
| `VoiceHttpError` | `HTTP` | Respuesta no 2xx (`status`, detalle del servicio). |
| `VoiceRateLimitedError` | `RATE_LIMITED` | HTTP 429 (`retryAfterMs`). |
| `VoiceError` | `NETWORK` / `BAD_RESPONSE` | Fallo de red (también al descargar el audio del mensaje), URL insegura o respuesta inesperada. |

Los mensajes de error y los logs nunca incluyen api keys, audio ni transcripciones.

## Tests

```ts
import { createTestBot } from '@bot-wa/core/testing'
import { voicePlugin } from '@bot-wa/voice'

const { bot, chat, provider } = await createTestBot()
provider.downloadMedia = async () => Buffer.from('OggS...')
bot.plug(voicePlugin({
  stt: { name: 'fake', transcribe: async () => ({ text: 'hola', provider: 'fake' }) },
}))
bot.when('hola', (ctx) => ctx.reply('👋'))

await chat.send('', { type: 'voice' })
await chat.expectReply('👋')
```

Los adapters HTTP aceptan `fetch` y `resolver` inyectados para probarlos sin red.

## Licencia

MIT
