# Voice (`@botmesh/voice`)

`@botmesh/voice` adds **speech-to-text** (STT) for inbound voice notes and
**text-to-speech** (TTS) to answer with audio. It is a plugin, not a channel:
it works the same on WhatsApp (Baileys or Cloud API), Telegram or any
provider that delivers `voice` / `audio` messages.

::: warning Experimental — not on npm
`@botmesh/voice` is a working, tested package, but it is **private**: it is not
part of the first alpha and its API may change. Use it from the monorepo
(`workspace:*`).
:::

- STT: OpenAI (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and
  compatible servers) and Deepgram (`nova-3`).
- TTS: OpenAI (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`) and ElevenLabs.
- No SDKs: plain HTTPS through `secureFetch` from `@botmesh/http` (SSRF guard,
  timeouts, size caps).
- `install()` is synchronous and never touches the network: adapters are
  resolved on first use, and a non-fatal warmup logs a bad config (missing API
  key, unknown provider) at startup.

## Quickstart

```ts
import { VOICE_NOTE } from '@botmesh/core'
import { voicePlugin } from '@botmesh/voice'

bot.plug(voicePlugin({
  stt: { provider: 'openai', model: 'whisper-1', apiKey: process.env.OPENAI_API_KEY },
  tts: { provider: 'openai', voice: 'nova', apiKey: process.env.OPENAI_API_KEY },
}))

// A voice note saying "Hello." also fires this text trigger
bot.when('hello', (ctx) => ctx.reply('Hi there!'))

// Type triggers still work, now with the transcript at hand
bot.when(VOICE_NOTE, async (ctx) => {
  await ctx.reply(`You said: ${ctx.transcript}`)
  await ctx.voice(await ctx.tools.voice.synthesize('Got it!'))
})
```

| Option | Default | Description |
|---|---|---|
| `stt` | — | `{ provider: 'openai' \| 'deepgram', ... }` or your own `SttAdapter`. |
| `tts` | — | `{ provider: 'openai' \| 'elevenlabs', ... }` or your own `TtsAdapter`. |
| `limits` | see [Limits](#limits) | Size, duration, text and time limits. |
| `autoTranscribe` | `true` when `stt` is set | Transcribe inbound voice notes before routing. `true` or an options object. |
| `autoReplyWithVoice` | `false` | Answer voice with voice. `true` or an options object. Requires `tts`. |

`autoTranscribe` without `stt`, or `autoReplyWithVoice` without `tts`, throws
a `VoiceConfigError` when the plugin is installed.

## Transcribing voice notes (`autoTranscribe`)

A `before('message')` hook (priority `100`, so it runs before most hooks)
downloads each voice note, transcribes it and sets:

- `ctx.transcript`: the text exactly as the service returned it (`''` when
  nothing was said).
- `ctx.body`: the same text without leading and trailing punctuation
  (`¡Hola!` becomes `Hola`), so equality triggers, `c.ask()`, NLU and AI
  handlers "hear" the audio.
- `ctx.media`: the downloaded audio (it is not downloaded again).
- `ctx.transcriptError`: the error when transcription failed. The message is
  **still routed** (without a transcript) and a warning is logged.
- `ctx.type`: stays `'voice'`, so `VOICE_NOTE` triggers still fire. With the
  default `asText: 'auto'` it becomes `'text'` **only while a conversation of
  that user waits for text** (`c.ask()`, `c.waitText()`), so a voice note
  answers the question. When the conversation waits for audio
  (`c.waitMedia(['voice'])`), a menu (`c.choose()`, which reads `body`) or any
  message (`c.waitAny()`), the note arrives as `'voice'` with its transcript.

| Option | Type | Default | Description |
|---|---|---|---|
| `types` | `('voice' \| 'audio')[]` | `['voice']` | Which inbound types to transcribe. Add `'audio'` for audio files. |
| `setBody` | `boolean` | `true` | Write the transcript into `ctx.body`. |
| `asText` | `boolean \| 'auto'` | `'auto'` | `true`: always set `ctx.type = 'text'` (text-only handlers answer audio, but `VOICE_NOTE` / `AUDIO` triggers stop matching). `false`: never. |
| `trimPunctuation` | `boolean` | `true` | Strip leading/trailing punctuation from `ctx.body` (`ctx.transcript` keeps the raw text). |
| `language` | `string` | — | Language hint for every transcription (e.g. `'es'`). |
| `useContextLanguage` | `boolean` | `true` | Use `ctx.lang` as the hint when `language` is not set (see [i18n](#language-and-i18n)). |
| `prompt` | `string` | — | Prompt / vocabulary hint for every transcription. |
| `filter` | `(ctx) => boolean` | — | Return `false` to skip a message (big groups, unpaid users). |
| `priority` | `number` | `100` | Priority of the `before('message')` hook. |
| `onError` | `(error, ctx) => void` | logs a warning | Called when a transcription fails. |

`autoTranscribe: false` disables the hook; `ctx.tools.voice.transcribe(ctx)`
is still available on demand.

### With the AI autoresponder

The [`@botmesh/ai`](/guide/ai) autoresponder only answers **text** messages.
With the default `asText: 'auto'`, a voice note sent outside a conversation
stays `'voice'`, so the AI does not answer it. To let the AI answer voice
notes, set `asText: true`:

```ts
bot.plug(voicePlugin({
  stt: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
  tts: { provider: 'openai', voice: 'nova' },
  autoTranscribe: { asText: true },
  autoReplyWithVoice: true, // the AI's answer goes back as a voice note
}))
bot.plug(aiPlugin({ provider: 'anthropic', persona }))
```

### Language and i18n

The language hint for the STT service is, in order:

1. `autoTranscribe.language`, when set.
2. The language [i18n](/guide/i18n) resolved for the sender (`ctx.lang`, base
   code: `en-gb` becomes `en`), only when it comes from a real signal (stored
   preference, provider or detector), never the bare default. Turn this off
   with `useContextLanguage: false`.
3. Otherwise none: the service detects the language.

After the hook writes the transcript into `ctx.body`, the core re-resolves the
language when it came from the detector or the default, so an i18n `detect`
function sees the spoken text. A `ctx.lang` set by a hook is kept.

## Answering with voice (`autoReplyWithVoice`)

While a chat's **latest inbound message** is a voice note, outbound text to
that chat is synthesized and sent as a voice note instead. It is a
`before('send')` hook, so it covers `ctx.reply`, flow `say` steps, `c.say` and
the AI autoresponder alike. When the user writes text again, the chat goes
back to text.

| Option | Type | Default | Description |
|---|---|---|---|
| `alsoText` | `boolean` | `false` | Send the voice note and then the text as well. |
| `maxChars` | `number` | `limits.maxTextChars` | Longer texts stay as text. |
| `voice` | `string` | — | Voice for the replies. |
| `instructions` | `string` | — | Style instructions (OpenAI `gpt-4o-mini-tts`). |
| `triggerTypes` | `('voice' \| 'audio')[]` | `['voice']` | Inbound types that switch a chat to voice replies. |
| `filter` | `(chatId, text) => boolean` | — | Return `false` to keep a text as text (e.g. a human agent's replies). |

These always stay text:

- Everything [`ctx.stream()`](/guide/streaming) outputs: drafts, live edits,
  sentence chunks and the final message (the send payload carries `stream`).
  A streamed reply must stay one editable text.
- In-place edits from `ctx.edit`.
- Replies to a channel whose `capabilities.contentKinds` lacks `'voice'`.

If synthesis fails, the original text is sent.

## `ctx.tools.voice`

The plugin injects a `VoiceClient` as `ctx.tools.voice` (typed through module
augmentation, no casts needed):

| Method | Returns | Description |
|---|---|---|
| `transcribe(source, opts?)` | `Promise<string>` | `source`: `ctx`, `ctx.media`, a `Buffer` or `{ buffer, mimetype?, filename?, durationSec? }`. |
| `transcribeDetailed(source, opts?)` | `Promise<Transcription>` | `{ text, language?, durationSec?, provider }`. |
| `synthesize(text, opts?)` | `Promise<Buffer>` | Audio ready for `ctx.voice(buffer)`. |
| `synthesizeDetailed(text, opts?)` | `Promise<SynthesizedAudio>` | `{ buffer, mimetype, format, provider }`. |
| `speak(ctx, text, opts?)` | `Promise<SentMessage>` | Synthesize and send with `ctx.voice()`. |
| `warmup()` | `Promise<void>` | Resolve the adapters now; rejects with `VoiceConfigError`. |
| `hasStt` / `hasTts` / `limits` | — | Effective configuration. |

Transcription options: `language`, `prompt`, `signal`. Synthesis options:
`voice`, `instructions`, `signal`.

```ts
bot.when(VOICE_NOTE, async (ctx) => {
  const { text, language } = await ctx.tools.voice.transcribeDetailed(ctx)
  await ctx.tools.voice.speak(ctx, `I heard ${text.length} characters in ${language ?? 'an unknown language'}.`)
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

| Adapter | Default model | API key fallback |
|---|---|---|
| OpenAI STT | `whisper-1` | `OPENAI_API_KEY` |
| Deepgram STT | `nova-3` (detects the language when no hint is given) | `DEEPGRAM_API_KEY` |
| OpenAI TTS | `gpt-4o-mini-tts`, voice `alloy`, format `opus` | `OPENAI_API_KEY` |
| ElevenLabs TTS | `eleven_multilingual_v2`, format `mp3_44100_128` (needs a `voiceId`) | `ELEVENLABS_API_KEY` |

Every built-in adapter also accepts `timeoutMs` (it can only tighten
`limits.timeoutMs`), `maxResponseBytes` and, for self-hosted servers on a
trusted network, `allowHttp` / `allowPrivateHosts` (for example a
Whisper-compatible server on `http://127.0.0.1:8000/v1`).

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

- **Input**: WhatsApp and Telegram voice notes arrive as OGG/Opus, which
  Whisper, `gpt-4o-*-transcribe` and Deepgram accept directly. When the channel
  reports no mimetype, it is sniffed from the first bytes (OGG, WAV, MP3,
  MP4/M4A, WebM, FLAC, AMR), else OGG is assumed.
- **Output on WhatsApp**: a voice note must be OGG/Opus. `@botmesh/baileys`
  transcodes `kind: 'voice'` to OGG/Opus itself (with the `ffmpeg` binary it
  bundles through `@ffmpeg-installer/ffmpeg`), so any format works. For the Cloud API and Telegram, ask the TTS for OGG/Opus: it is
  the OpenAI default (`format: 'opus'`); on ElevenLabs use
  `outputFormat: 'opus_48000_64'` if your plan offers it.
- This package does no transcoding (it does not depend on `ffmpeg`).

## Limits

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

The duration is checked **before** paying for a transcription when it is
known (an explicit `durationSec`, or an OGG file). Other containers are not
estimated.

## Errors

Every error extends `VoiceError` and carries a stable `code`:

| Class | `code` | When |
|---|---|---|
| `VoiceConfigError` | `CONFIG` | Missing API key, unknown provider, STT/TTS not configured. |
| `VoiceError` | `NO_MEDIA` | No audio on the message, or empty text to synthesize. |
| `AudioTooLargeError` | `AUDIO_TOO_LARGE` | Over `maxInputBytes`. |
| `AudioTooLongError` | `AUDIO_TOO_LONG` | Over `maxDurationSec`. |
| `TextTooLongError` | `TEXT_TOO_LONG` | Over `maxTextChars`. |
| `VoiceTimeoutError` | `TIMEOUT` | Over `timeoutMs`. |
| `VoiceHttpError` | `HTTP` | Non-2xx answer (`status`). |
| `VoiceRateLimitedError` | `RATE_LIMITED` | HTTP 429 (`retryAfterMs` from `Retry-After`). |
| `VoiceError` | `NETWORK` / `BAD_RESPONSE` | Transport failure (also when downloading the message's audio), unsafe URL, or an unexpected answer. |

Error messages and logs never include API keys, audio or transcripts.

## Testing

```ts
import { createTestBot } from '@botmesh/core/testing'
import { voicePlugin } from '@botmesh/voice'

const { bot, chat, provider } = await createTestBot()
provider.downloadMedia = async () => Buffer.from('OggS...')
bot.plug(voicePlugin({
  stt: { name: 'fake', transcribe: async () => ({ text: 'hello', provider: 'fake' }) },
}))
bot.when('hello', (ctx) => ctx.reply('Hi!'))

await chat.send('', { type: 'voice' })
await chat.expectReply('Hi!')
```

The HTTP adapters accept injected `fetch` and `resolver` to test them without
network. More in the
[`@botmesh/voice` README](https://github.com/andresayac/botmesh/tree/main/packages/voice).

## Next steps

- [AI plugin](/guide/ai) — answer transcribed voice notes with AI
- [Streaming replies](/guide/streaming) — why streamed output stays text
- [Internationalization (i18n)](/guide/i18n) — where `ctx.lang` comes from
- [Messages & media](/guide/messages) — `ctx.voice()` and receiving media
