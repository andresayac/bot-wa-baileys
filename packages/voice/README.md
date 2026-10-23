# @botmesh/voice

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`).

Voice for [`@botmesh/core`](../core) bots: **speech-to-text** (STT) for inbound voice notes and **text-to-speech** (TTS) to reply with audio. It is a plugin, not a provider: it works the same on WhatsApp (Baileys or Cloud API), Telegram or any channel that delivers `voice`/`audio`.

- STT: OpenAI (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and any compatible server) and Deepgram (`nova-3`).
- TTS: OpenAI (`gpt-4o-mini-tts`, `tts-1`) and ElevenLabs.
- No SDKs: HTTPS calls with [`@botmesh/http`](../http)'s `secureFetch` (anti-SSRF, timeouts, size limit).
- Synchronous `install()`; adapters resolve on first use and a non-fatal `warmup()` warns at startup when an API key is missing.

Inside the monorepo, declare it as a workspace dependency (it cannot be installed from npm yet):

```json
{ "dependencies": { "@botmesh/voice": "workspace:*" } }
```

## Quick start

```ts
import { VOICE_NOTE } from '@botmesh/core'
import { voicePlugin } from '@botmesh/voice'

bot.plug(voicePlugin({
  stt: { provider: 'openai', model: 'whisper-1', apiKey: process.env.OPENAI_API_KEY, language: 'en' },
  tts: { provider: 'openai', voice: 'nova', apiKey: process.env.OPENAI_API_KEY },
}))

// A voice note saying "Hello." also triggers this:
bot.when('hello', (ctx) => ctx.reply('Hello! 👋'))

// Type triggers still work, now with the transcript at hand:
bot.when(VOICE_NOTE, async (ctx) => {
  await ctx.reply(`You said: ${ctx.transcript}`)
  await ctx.voice(await ctx.tools.voice.synthesize('Got it!'))
})
```

## How it works

### `autoTranscribe` (enabled by default when `stt` is set)

A `before('message')` hook (priority 100) downloads every voice note, transcribes it and leaves:

- `ctx.transcript`: the text exactly as the service returned it (`''` when nothing was said).
- `ctx.body`: the same text without leading/trailing punctuation (`¡Hello!` → `Hello`), so equality triggers, `c.ask()`, NLU and AI "hear" the audio.
- `ctx.media`: the downloaded audio (it is not downloaded again).
- `ctx.transcriptError`: the error, when transcription failed. The message **is still routed** (without a transcript) and a `warn` is logged.
- `ctx.type`: it stays `'voice'`, so `VOICE_NOTE` still fires. With the default `asText: 'auto'` it becomes `'text'` **only while an active conversation for that user waits for text** (`c.ask()`, `c.waitText()`), so the voice note answers the question. If the conversation waits for audio (`c.waitMedia(['voice'])`), a menu (`c.choose()`, which reads `body`) or any message (`c.waitAny()`), the note arrives as `'voice'` with its transcript.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `types` | `('voice' \| 'audio')[]` | `['voice']` | Which types to transcribe. Add `'audio'` for audio files. |
| `setBody` | `boolean` | `true` | Writes the transcript into `ctx.body`. |
| `asText` | `boolean \| 'auto'` | `'auto'` | `true`: always `ctx.type = 'text'` (the `@botmesh/ai` autoresponder answers audio, but `VOICE_NOTE` stops matching). `false`: never. |
| `trimPunctuation` | `boolean` | `true` | Removes leading/trailing punctuation from `body`. |
| `language` / `prompt` | `string` | — | STT hints per message. Without `language`, the language resolved by i18n (`ctx.lang`, base code: `en-gb` → `en`) is used if it comes from a real signal (preference, provider or `detect`), never the default value; otherwise the service detects it. |
| `useContextLanguage` | `boolean` | `true` | `false` ignores `ctx.lang` as a hint. |
| `filter` | `(ctx) => boolean` | — | Return `false` to skip transcription (large groups, users without a plan…). |
| `priority` | `number` | `100` | Hook priority. |
| `onError` | `(err, ctx) => void` | `warn` log | What to do when transcription fails. |

`autoTranscribe: false` disables the hook; `ctx.tools.voice.transcribe(ctx)` is still available on demand.

### `autoReplyWithVoice` (off by default)

While the **last inbound message** of a chat is a voice note, outbound text to that chat is synthesized and sent as a voice note. It is a `before('send')` hook, so it covers `ctx.reply`, `flow().say`, `c.say` and the AI autoresponder. If the user writes text again, the chat goes back to text. `ctx.stream()` output (drafts, live edits, chunks and the final message; `stream` payload in the hook) and `ctx.edit` edits **always stay as text**.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `alsoText` | `boolean` | `false` | Sends the voice note and then the text. |
| `maxChars` | `number` | `limits.maxTextChars` | Longer texts stay as text. |
| `voice` / `instructions` | `string` | — | Voice and style for the replies. |
| `triggerTypes` | `('voice' \| 'audio')[]` | `['voice']` | Which inbound messages turn voice mode on. |
| `filter` | `(chatId, text) => boolean` | — | Return `false` to keep text as text (e.g. replies from a human agent). |

If synthesis fails or the channel does not support `voice` (`capabilities.contentKinds`), the original text is sent.

## `ctx.tools.voice`

| Method | Returns | Description |
| --- | --- | --- |
| `transcribe(source, opts?)` | `Promise<string>` | `source`: `ctx`, `ctx.media`, a `Buffer` or `{ buffer, mimetype?, filename?, durationSec? }`. |
| `transcribeDetailed(source, opts?)` | `Promise<Transcription>` | `{ text, language?, durationSec?, provider }`. |
| `synthesize(text, opts?)` | `Promise<Buffer>` | Audio ready for `ctx.voice(buffer)`. |
| `synthesizeDetailed(text, opts?)` | `Promise<SynthesizedAudio>` | `{ buffer, mimetype, format, provider }`. |
| `speak(ctx, text, opts?)` | `Promise<SentMessage>` | Synthesizes and sends with `ctx.voice()`. |
| `warmup()` | `Promise<void>` | Resolves the adapters; rejects with `VoiceConfigError`. |
| `hasStt` / `hasTts` / `limits` | — | Effective configuration. |

## Providers

```ts
// STT
{ provider: 'openai', apiKey, model: 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe', language, prompt, temperature, baseUrl }
{ provider: 'deepgram', apiKey, model: 'nova-3', language, smartFormat: true, query: { keyterm: 'BotWA' }, baseUrl }

// TTS
{ provider: 'openai', apiKey, model: 'gpt-4o-mini-tts', voice: 'alloy', format: 'opus', instructions, speed, baseUrl }
{ provider: 'elevenlabs', apiKey, voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_multilingual_v2', outputFormat: 'mp3_44100_128', voiceSettings, languageCode }
```

API keys fall back to `OPENAI_API_KEY`, `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY`. All accept `timeoutMs` (it can only shorten `limits.timeoutMs`), `maxResponseBytes` and, for your own servers on a trusted network, `allowHttp` / `allowPrivateHosts` (e.g. `faster-whisper-server` on `http://127.0.0.1:8000/v1`).

You can also pass your own adapter (a local model, another service):

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

## Audio formats

- **Input:** WhatsApp and Telegram voice notes arrive as OGG/Opus, which Whisper, `gpt-4o-*-transcribe` and Deepgram accept directly. If the channel does not report the mimetype, it is detected from the first bytes (OGG, WAV, MP3, MP4/M4A, WebM, FLAC, AMR) and, otherwise, OGG is assumed.
- **Output for WhatsApp:** a voice note (PTT) must be **OGG/Opus**. `@botmesh/baileys` transcodes `kind: 'voice'` to OGG/Opus on its own (with the `ffmpeg` binary it bundles through `@ffmpeg-installer/ffmpeg`), so any format works. For Cloud API and Telegram ask the TTS for OGG/Opus: it is the OpenAI default (`format: 'opus'`); on ElevenLabs use `outputFormat: 'opus_48000_64'` if your plan offers it (the default is `mp3_44100_128`, which Telegram and Cloud API accept as audio but not always as a voice note).
- There is no transcoding inside this package (it does not depend on `ffmpeg`).

## Limits

```ts
voicePlugin({
  stt, tts,
  limits: {
    maxInputBytes: 25 * 1024 * 1024, // maximum audio size; stops the download as soon as it is exceeded (OpenAI limit)
    maxDurationSec: 300,             // maximum duration; read from the last OGG page before calling the service
    maxTextChars: 4096,              // maximum characters per synthesis
    timeoutMs: 60_000,               // maximum time per STT/TTS call; also the adapters' HTTP timeout
  },
})
```

Duration is checked **before** paying for the transcription when it is known (explicit `durationSec` or an OGG). Other containers are not estimated.

## Errors

All extend `VoiceError` and carry a stable `code`:

| Class | `code` | When |
| --- | --- | --- |
| `VoiceConfigError` | `CONFIG` | Missing API key, unknown provider, STT/TTS not configured. |
| `VoiceError` | `NO_MEDIA` | The message has no audio / the text is empty. |
| `AudioTooLargeError` | `AUDIO_TOO_LARGE` | Exceeds `maxInputBytes`. |
| `AudioTooLongError` | `AUDIO_TOO_LONG` | Exceeds `maxDurationSec`. |
| `TextTooLongError` | `TEXT_TOO_LONG` | Exceeds `maxTextChars`. |
| `VoiceTimeoutError` | `TIMEOUT` | `timeoutMs` elapsed. |
| `VoiceHttpError` | `HTTP` | Non-2xx response (`status`, service detail). |
| `VoiceRateLimitedError` | `RATE_LIMITED` | HTTP 429 (`retryAfterMs`). |
| `VoiceError` | `NETWORK` / `BAD_RESPONSE` | Network failure (also when downloading the message audio), insecure URL or unexpected response. |

Error messages and logs never include API keys, audio or transcripts.

## Tests

```ts
import { createTestBot } from '@botmesh/core/testing'
import { voicePlugin } from '@botmesh/voice'

const { bot, chat, provider } = await createTestBot()
provider.downloadMedia = async () => Buffer.from('OggS...')
bot.plug(voicePlugin({
  stt: { name: 'fake', transcribe: async () => ({ text: 'hello', provider: 'fake' }) },
}))
bot.when('hello', (ctx) => ctx.reply('👋'))

await chat.send('', { type: 'voice' })
await chat.expectReply('👋')
```

HTTP adapters accept injected `fetch` and `resolver` to test them without network.

## License

MIT
