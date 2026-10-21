# Voz (`@botmesh/voice`)

`@botmesh/voice` añade **speech-to-text** (STT) para las notas de voz
entrantes y **text-to-speech** (TTS) para responder con audio. Es un plugin,
no un canal: funciona igual en WhatsApp (Baileys o Cloud API), Telegram o
cualquier provider que entregue mensajes `voice` / `audio`.

::: warning Experimental — no está en npm
`@botmesh/voice` es un paquete real y probado, pero es **privado**: no forma
parte de la primera alpha y su API puede cambiar. Úsalo desde el monorepo
(`workspace:*`).
:::

- STT: OpenAI (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` y
  servidores compatibles) y Deepgram (`nova-3`).
- TTS: OpenAI (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`) y ElevenLabs.
- Sin SDKs: HTTPS directo con `secureFetch` de `@botmesh/http` (anti-SSRF,
  timeouts, límites de tamaño).
- `install()` es síncrono y nunca toca la red: los adapters se resuelven en el
  primer uso y un warmup no fatal registra al arrancar una configuración mala
  (falta la API key, proveedor desconocido).

## Inicio rápido

```ts
import { VOICE_NOTE } from '@botmesh/core'
import { voicePlugin } from '@botmesh/voice'

bot.plug(voicePlugin({
  stt: { provider: 'openai', model: 'whisper-1', apiKey: process.env.OPENAI_API_KEY },
  tts: { provider: 'openai', voice: 'nova', apiKey: process.env.OPENAI_API_KEY },
}))

// A voice note saying "Hola." also fires this text trigger
bot.when('hola', (ctx) => ctx.reply('¡Hola!'))

// Type triggers still work, now with the transcript at hand
bot.when(VOICE_NOTE, async (ctx) => {
  await ctx.reply(`Dijiste: ${ctx.transcript}`)
  await ctx.voice(await ctx.tools.voice.synthesize('¡Entendido!'))
})
```

| Opción | Por defecto | Descripción |
|---|---|---|
| `stt` | — | `{ provider: 'openai' \| 'deepgram', ... }` o tu propio `SttAdapter`. |
| `tts` | — | `{ provider: 'openai' \| 'elevenlabs', ... }` o tu propio `TtsAdapter`. |
| `limits` | ver [Límites](#limites) | Límites de tamaño, duración, texto y tiempo. |
| `autoTranscribe` | `true` si hay `stt` | Transcribe las notas de voz antes de enrutarlas. `true` o un objeto de opciones. |
| `autoReplyWithVoice` | `false` | Responde a la voz con voz. `true` o un objeto de opciones. Requiere `tts`. |

`autoTranscribe` sin `stt`, o `autoReplyWithVoice` sin `tts`, lanza un
`VoiceConfigError` al instalar el plugin.

## Transcribir notas de voz (`autoTranscribe`)

Un hook `before('message')` (prioridad `100`, así que corre antes que la
mayoría) descarga cada nota de voz, la transcribe y deja:

- `ctx.transcript`: el texto tal cual lo devolvió el servicio (`''` si no se
  dijo nada).
- `ctx.body`: el mismo texto sin la puntuación de los extremos (`¡Hola!` pasa a
  `Hola`), para que los triggers por igualdad, `c.ask()`, la NLU y los
  handlers de IA "oigan" el audio.
- `ctx.media`: el audio descargado (no se vuelve a descargar).
- `ctx.transcriptError`: el error, si la transcripción falló. El mensaje **se
  sigue enrutando** (sin transcripción) y se registra un aviso.
- `ctx.type`: sigue siendo `'voice'`, así que los triggers `VOICE_NOTE` siguen
  disparando. Con el modo por defecto `asText: 'auto'` pasa a `'text'` **solo
  mientras una conversación de ese usuario espera texto** (`c.ask()`,
  `c.waitText()`), para que la nota de voz responda a la pregunta. Si la
  conversación espera audio (`c.waitMedia(['voice'])`), un menú (`c.choose()`,
  que lee `body`) o cualquier mensaje (`c.waitAny()`), la nota llega como
  `'voice'` con su transcripción.

| Opción | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `types` | `('voice' \| 'audio')[]` | `['voice']` | Qué tipos entrantes transcribir. Añade `'audio'` para archivos de audio. |
| `setBody` | `boolean` | `true` | Escribe la transcripción en `ctx.body`. |
| `asText` | `boolean \| 'auto'` | `'auto'` | `true`: siempre `ctx.type = 'text'` (los handlers de solo texto contestan audios, pero los triggers `VOICE_NOTE` / `AUDIO` dejan de coincidir). `false`: nunca. |
| `trimPunctuation` | `boolean` | `true` | Quita la puntuación de los extremos de `ctx.body` (`ctx.transcript` conserva el texto crudo). |
| `language` | `string` | — | Pista de idioma para cada transcripción (p. ej. `'es'`). |
| `useContextLanguage` | `boolean` | `true` | Usa `ctx.lang` como pista si no hay `language` (ver [i18n](#idioma-e-i18n)). |
| `prompt` | `string` | — | Pista de prompt / vocabulario para cada transcripción. |
| `filter` | `(ctx) => boolean` | — | Devuelve `false` para no transcribir un mensaje (grupos grandes, usuarios sin plan). |
| `priority` | `number` | `100` | Prioridad del hook `before('message')`. |
| `onError` | `(error, ctx) => void` | registra un aviso | Se llama cuando falla una transcripción. |

`autoTranscribe: false` desactiva el hook; `ctx.tools.voice.transcribe(ctx)`
sigue disponible a demanda.

### Con el autoresponder de IA

El autoresponder de [`@botmesh/ai`](/es/guide/ai) solo contesta mensajes de
**texto**. Con el modo por defecto `asText: 'auto'`, una nota de voz enviada
fuera de una conversación sigue siendo `'voice'`, así que la IA no la
contesta. Para que la IA conteste notas de voz, usa `asText: true`:

```ts
bot.plug(voicePlugin({
  stt: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
  tts: { provider: 'openai', voice: 'nova' },
  autoTranscribe: { asText: true },
  autoReplyWithVoice: true, // the AI's answer goes back as a voice note
}))
bot.plug(aiPlugin({ provider: 'anthropic', persona }))
```

### Idioma e i18n

La pista de idioma para el servicio de STT es, en este orden:

1. `autoTranscribe.language`, si está definida.
2. El idioma que el [i18n](/es/guide/i18n) resolvió para el remitente
   (`ctx.lang`, código base: `en-gb` pasa a `en`), solo si viene de una señal
   real (preferencia guardada, provider o detector), nunca del valor por
   defecto a secas. Se desactiva con `useContextLanguage: false`.
3. Si no, ninguna: el servicio detecta el idioma.

Después de que el hook escribe la transcripción en `ctx.body`, el core vuelve
a resolver el idioma si venía del detector o del valor por defecto, así que
una función `detect` del i18n ve el texto hablado. Un `ctx.lang` fijado por
un hook se respeta.

## Responder con voz (`autoReplyWithVoice`)

Mientras el **último mensaje entrante** de un chat sea una nota de voz, el
texto saliente hacia ese chat se sintetiza y se envía como nota de voz. Es un
hook `before('send')`, así que cubre `ctx.reply`, los pasos `say` de los
flujos, `c.say` y el autoresponder de IA. Cuando el usuario vuelve a escribir
texto, el chat vuelve a texto.

| Opción | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `alsoText` | `boolean` | `false` | Envía la nota de voz y después también el texto. |
| `maxChars` | `number` | `limits.maxTextChars` | Los textos más largos se quedan como texto. |
| `voice` | `string` | — | Voz de las respuestas. |
| `instructions` | `string` | — | Instrucciones de estilo (OpenAI `gpt-4o-mini-tts`). |
| `triggerTypes` | `('voice' \| 'audio')[]` | `['voice']` | Tipos entrantes que pasan el chat a respuestas de voz. |
| `filter` | `(chatId, text) => boolean` | — | Devuelve `false` para mantener un texto como texto (p. ej. las respuestas de un agente humano). |

Siempre se quedan en texto:

- Todo lo que envía [`ctx.stream()`](/es/guide/streaming): borradores,
  ediciones en vivo, trozos y el mensaje final (el payload de envío lleva
  `stream`). Una respuesta en streaming debe seguir siendo un único texto
  editable.
- Las ediciones en el sitio de `ctx.edit`.
- Las respuestas a un canal cuyo `capabilities.contentKinds` no incluye
  `'voice'`.

Si la síntesis falla, se envía el texto original.

## `ctx.tools.voice`

El plugin inyecta un `VoiceClient` como `ctx.tools.voice` (tipado por
*module augmentation*, sin casts):

| Método | Devuelve | Descripción |
|---|---|---|
| `transcribe(source, opts?)` | `Promise<string>` | `source`: `ctx`, `ctx.media`, un `Buffer` o `{ buffer, mimetype?, filename?, durationSec? }`. |
| `transcribeDetailed(source, opts?)` | `Promise<Transcription>` | `{ text, language?, durationSec?, provider }`. |
| `synthesize(text, opts?)` | `Promise<Buffer>` | Audio listo para `ctx.voice(buffer)`. |
| `synthesizeDetailed(text, opts?)` | `Promise<SynthesizedAudio>` | `{ buffer, mimetype, format, provider }`. |
| `speak(ctx, text, opts?)` | `Promise<SentMessage>` | Sintetiza y envía con `ctx.voice()`. |
| `warmup()` | `Promise<void>` | Resuelve los adapters ya; rechaza con `VoiceConfigError`. |
| `hasStt` / `hasTts` / `limits` | — | Configuración efectiva. |

Opciones de transcripción: `language`, `prompt`, `signal`. Opciones de
síntesis: `voice`, `instructions`, `signal`.

```ts
bot.when(VOICE_NOTE, async (ctx) => {
  const { text, language } = await ctx.tools.voice.transcribeDetailed(ctx)
  await ctx.tools.voice.speak(ctx, `Oí ${text.length} caracteres en ${language ?? 'un idioma desconocido'}.`)
})
```

## Adapters

```ts
// STT
{ provider: 'openai', apiKey, model: 'whisper-1', language, prompt, temperature, baseUrl, organization }
{ provider: 'deepgram', apiKey, model: 'nova-3', language, smartFormat: true, query: { keyterm: 'BotWA' }, baseUrl }

// TTS
{ provider: 'openai', apiKey, model: 'gpt-4o-mini-tts', voice: 'alloy', format: 'opus', instructions, speed, baseUrl, organization }
{ provider: 'elevenlabs', apiKey, voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_multilingual_v2', outputFormat: 'mp3_44100_128', voiceSettings, languageCode, baseUrl }
```

| Adapter | Modelo por defecto | API key por defecto |
|---|---|---|
| OpenAI STT | `whisper-1` | `OPENAI_API_KEY` |
| Deepgram STT | `nova-3` (detecta el idioma si no hay pista) | `DEEPGRAM_API_KEY` |
| OpenAI TTS | `gpt-4o-mini-tts`, voz `alloy`, formato `opus` | `OPENAI_API_KEY` |
| ElevenLabs TTS | `eleven_multilingual_v2`, formato `mp3_44100_128` (necesita un `voiceId`) | `ELEVENLABS_API_KEY` |

Todos los adapters incluidos aceptan además `timeoutMs` (solo puede acortar
`limits.timeoutMs`), `maxResponseBytes` y, para servidores propios en una red
de confianza, `allowHttp` / `allowPrivateHosts` (por ejemplo un servidor
compatible con Whisper en `http://127.0.0.1:8000/v1`).

También puedes pasar un adapter propio (un modelo local, otro servicio):

```ts
import type { SttAdapter } from '@botmesh/voice'

const local: SttAdapter = {
  name: 'local-whisper',
  async transcribe(audio, opts) {
    return { text: await myWhisper(audio.buffer, opts?.language), provider: 'local-whisper' }
  },
}
bot.plug(voicePlugin({ stt: local }))
```

## Formatos de audio

- **Entrada**: las notas de voz de WhatsApp y Telegram llegan en OGG/Opus, que
  Whisper, `gpt-4o-*-transcribe` y Deepgram aceptan directamente. Si el canal
  no informa el mimetype, se detecta por los primeros bytes (OGG, WAV, MP3,
  MP4/M4A, WebM, FLAC, AMR) y, si no, se asume OGG.
- **Salida en WhatsApp**: una nota de voz debe ser OGG/Opus. `@botmesh/baileys`
  transcodifica `kind: 'voice'` a OGG/Opus por su cuenta (con el binario de
  `ffmpeg` que incluye vía `@ffmpeg-installer/ffmpeg`), así que cualquier
  formato vale. Para Cloud API y Telegram pide OGG/Opus al
  TTS: es el valor por defecto de OpenAI (`format: 'opus'`); en ElevenLabs usa
  `outputFormat: 'opus_48000_64'` si tu plan lo ofrece.
- Este paquete no transcodifica nada (no depende de `ffmpeg`).

## Límites

```ts
voicePlugin({
  stt, tts,
  limits: {
    maxInputBytes: 25 * 1024 * 1024, // max audio size; the download is cut as soon as it goes over
    maxDurationSec: 300,             // max duration; read from the last OGG page before calling the service
    maxTextChars: 4096,              // max characters per synthesis
    timeoutMs: 60_000,               // max time per STT/TTS call; also the adapters' HTTP timeout
  },
})
```

La duración se comprueba **antes** de pagar la transcripción cuando se conoce
(un `durationSec` explícito o un archivo OGG). Para otros contenedores no se
estima.

## Errores

Todos extienden `VoiceError` y llevan un `code` estable:

| Clase | `code` | Cuándo |
|---|---|---|
| `VoiceConfigError` | `CONFIG` | Falta la API key, proveedor desconocido, STT/TTS sin configurar. |
| `VoiceError` | `NO_MEDIA` | El mensaje no tiene audio o el texto a sintetizar está vacío. |
| `AudioTooLargeError` | `AUDIO_TOO_LARGE` | Supera `maxInputBytes`. |
| `AudioTooLongError` | `AUDIO_TOO_LONG` | Supera `maxDurationSec`. |
| `TextTooLongError` | `TEXT_TOO_LONG` | Supera `maxTextChars`. |
| `VoiceTimeoutError` | `TIMEOUT` | Supera `timeoutMs`. |
| `VoiceHttpError` | `HTTP` | Respuesta no 2xx (`status`). |
| `VoiceRateLimitedError` | `RATE_LIMITED` | HTTP 429 (`retryAfterMs` sacado de `Retry-After`). |
| `VoiceError` | `NETWORK` / `BAD_RESPONSE` | Fallo de transporte (también al descargar el audio del mensaje), URL insegura o respuesta inesperada. |

Los mensajes de error y los logs nunca incluyen API keys, audio ni
transcripciones.

## Testing

```ts
import { createTestBot } from '@botmesh/core/testing'
import { voicePlugin } from '@botmesh/voice'

const { bot, chat, provider } = await createTestBot()
provider.downloadMedia = async () => Buffer.from('OggS...')
bot.plug(voicePlugin({
  stt: { name: 'fake', transcribe: async () => ({ text: 'hola', provider: 'fake' }) },
}))
bot.when('hola', (ctx) => ctx.reply('¡Hola!'))

await chat.send('', { type: 'voice' })
await chat.expectReply('¡Hola!')
```

Los adapters HTTP aceptan `fetch` y `resolver` inyectados para probarlos sin
red. Más en el
[README de `@botmesh/voice`](https://github.com/andresayac/botmesh/tree/main/packages/voice).

## Siguientes pasos

- [Plugin de IA](/es/guide/ai) — contesta con IA las notas de voz transcritas
- [Respuestas en streaming](/es/guide/streaming) — por qué la salida en streaming se queda en texto
- [Internacionalización (i18n)](/es/guide/i18n) — de dónde sale `ctx.lang`
- [Mensajes y media](/es/guide/mensajes) — `ctx.voice()` y recibir media
