# Golden transcripts

A golden transcript is a recorded conversation (what users sent and what the
bot answered) saved as a versioned JSON file. You commit it next to your tests
and replay it against the bot: if a change alters a reply, the replay shows
the expected and actual message side by side.

The workflow:

1. **Record** a conversation (in tests or in production) or build it from the
   store message log.
2. **Redact** it so no personal data ends up in the repository.
3. **Save** it as JSON.
4. **Replay** it in a test (or in a deployment gate) and fail on any diff.

| Function | Import from | Purpose |
| --- | --- | --- |
| `recordTranscript`, `RecordingProvider` | `@bot-wa/core` or `@bot-wa/core/testing` | Record live traffic through a provider wrapper |
| `transcriptFromStore`, `transcriptFromMessages` | `@bot-wa/core` or `@bot-wa/core/testing` | Build a transcript from the store message log |
| `redactTranscript`, `createRedactionMap` | `@bot-wa/core` or `@bot-wa/core/testing` | Replace PII with stable placeholders |
| `parseTranscript`, `serializeTranscript`, `createTranscript` | `@bot-wa/core` or `@bot-wa/core/testing` | Read, write and hand-write transcripts |
| `replayTranscript`, `assertTranscript`, `REPLAY_MASKS` | `@bot-wa/core/testing` only | Replay and diff |

## Record a conversation

`recordTranscript(provider, options?)` wraps any `IProvider` (a real transport
or a `MockProvider`) in a transparent `RecordingProvider`. Give
`recorder.provider` to the bot; it records inbound messages and interactions
and every successful send.

```ts
import { Bot } from '@bot-wa/core'
import { MockProvider, recordTranscript, redactTranscript, serializeTranscript } from '@bot-wa/core/testing'
import { writeFileSync } from 'node:fs'

const recorder = recordTranscript(new MockProvider())
const bot = new Bot({ provider: recorder.provider })
// ... register handlers, start the bot, drive the conversation ...

const golden = redactTranscript(recorder.transcript({ name: 'checkout' }))
writeFileSync('tests/golden/checkout.json', serializeTranscript(golden))
```

The handle exposes `transcript({ name?, description? })` (a snapshot),
`clear()`, `pause()` and `resume()`.
In a test built with `createTestBot`, `chat.transcript()` returns the same shape
straight from the mock (see [Conversation snapshots](/guide/testing#conversation-snapshots)).

| Option | Default | Notes |
| --- | --- | --- |
| `maxTurns` | `10000` (`DEFAULT_MAX_TURNS`) | Oldest turns are dropped first. `Infinity` disables the cap. |
| `includeFromMe` | `false` | Also record echoes of the bot's own messages flagged `fromMe`. |
| `now` | `Date.now` | Clock for the `t` offsets. |

Failed or skipped sends are not recorded. Recording also works in production
(that is why it is exported from `@bot-wa/core`), but the buffer keeps message
bodies, display names and ids **unredacted** in RAM: keep `maxTurns` bounded
and call `clear()` once you have taken a transcript.

## From the store message log

`transcriptFromStore(source, chatIds, options?)` reads one or more chats from
`getMessagesByChat` and merges them into one transcript ordered by timestamp.
Pass the **bot** (or `bot.getStore()`): a `Bot` writes to a namespaced view of
the store you give it, so the raw store finds nothing under the plain chat
ids.

```ts
import { transcriptFromStore } from '@bot-wa/core'

const transcript = await transcriptFromStore(bot, [chatId], { name: 'support-123', limit: 500 })
```

Options: `name`, `limit` (per chat, default `1000`), `includeFailed` (keep
outbound messages with status `failed`, default `false`) and `isGroup` (a flag
or `(chatId) => boolean`; when omitted, `transcriptFromStore` reads the chat
kind from the store). `transcriptFromMessages(messages, options?)` does the
same with an array of `StoredMessage`.

The store keeps no full outbound content and no display names, so these
transcripts compare only `kind` and `text`, and replays use the mock's default
push name.

## The file format

```json
{
  "format": "bot-wa/transcript",
  "version": 1,
  "name": "checkout",
  "source": "recorder",
  "redacted": true,
  "turns": [
    { "dir": "in", "chatId": "<user:1>", "senderId": "<user:1>", "type": "text", "text": "hola", "displayName": "<name:1>", "id": "<msg:1>", "t": 0 },
    { "dir": "out", "chatId": "<user:1>", "kind": "text", "text": "Hi <name:1>! Your email?", "content": { "kind": "text", "text": "Hi <name:1>! Your email?" }, "t": 12 }
  ]
}
```

- Inbound turns (`dir: 'in'`): `chatId`, `senderId`, `type`, `text`, and
  optionally `event` (`'message'` or `'interaction'`, where `text` holds the
  button/list data), `isGroup`, `displayName`, `id` and `t`.
- Outbound turns (`dir: 'out'`): `chatId`, `kind`, `text` (text, caption,
  question...), and optionally `content` (the full JSON-safe content, only when
  recorded live; binaries become `{ $binary: { bytes, sha256 } }`), `id` and
  `t`.
- `t` is milliseconds since the first turn; `startedAt` (epoch ms) is optional
  and redaction drops it.
- Ids are opaque strings: nothing parses them.

`serializeTranscript(t)` writes stable, diff-friendly JSON (2-space indent,
trailing newline). `parseTranscript(input)` (a JSON string or an already-parsed
object) validates the shape and version and throws `TranscriptFormatError` otherwise.
`createTranscript(turns, meta?)` builds one by hand.

## Redaction

`redactTranscript(transcript, options?)` returns a redacted copy with stable
placeholders numbered by first appearance, so the result is deterministic and
redacting twice changes nothing.

- Ids become `<user:N>`, `<chat:N>` (group chats) and `<msg:N>`. User and
  chat ids of 4+ characters are also replaced inside texts (message ids only
  as whole fields).
- Display names become `<name:N>`, in the field and inside any text (so a
  reply that greets the user by name is redacted too). On replay the
  placeholder is sent as the push name, so the reply still matches.
- Emails and phone numbers (7+ digits) in **inbound** texts become
  `<email:N>` / `<phone:N>`. Outbound texts only get the values already learned
  from the inbound side (data the bot echoes back): prices, dates or order
  numbers the bot prints on its own stay as they are, because the replay
  compares them against the real values.

| Option | Default | Notes |
| --- | --- | --- |
| `emails` / `phones` | `true` | Built-in patterns. |
| `ids` | `true` | Replace chat, sender and message ids. |
| `displayNames` | `'placeholder'` | `'drop'` removes the field but still redacts the name in texts; `'keep'` leaves it. |
| `outboundPatterns` | `false` | Also apply the patterns to outbound texts. Replay such a golden with the `redact` replay option. |
| `surrogates` | `false` | Use format-valid values (`email1@redacted.invalid`, `+10000000001`) so validation steps accept the redacted input on replay. |
| `dropStartedAt` | `true` | Remove the wall-clock start. |
| `rules` | `[]` | Extra `{ name, pattern }` rules (`name` matches `[a-z0-9_-]+`); matches become `<name:N>`. |
| `allow` | `[]` | Values never redacted (a support phone printed by the bot). |
| `map` | new | A `RedactionMap` (`createRedactionMap()`) shared between calls keeps placeholders stable across transcripts. |

```ts
const golden = redactTranscript(raw, {
  rules: [{ name: 'order', pattern: /ORD-\d+/ }],
  allow: ['+57 601 555 0100'],
})
```

## Replay and assert

`replayTranscript(transcript, createBot, options?)` builds a fresh bot around
an in-memory `MockProvider`, feeds it the inbound turns one by one and diffs
what it sends back against the recorded outbound turns. `createBot` receives
the provider and must return the bot **without starting it**; the replay
starts and stops it.

```ts
import { readFileSync } from 'node:fs'
import { Bot, type IProvider } from '@bot-wa/core'
import { assertTranscript, parseTranscript, REPLAY_MASKS } from '@bot-wa/core/testing'
import { registerFlows } from '../src/flows.js'

function buildBot(provider: IProvider) {
  const bot = new Bot({ provider })
  registerFlows(bot)
  return bot
}

it('checkout still answers the same', async () => {
  const golden = parseTranscript(readFileSync('tests/golden/checkout.json', 'utf8'))
  await assertTranscript(golden, buildBot, { masks: [REPLAY_MASKS.isoDate] })
})
```

`assertTranscript` throws a `TranscriptMismatchError` (with `.result`) whose
message is the report. `replayTranscript` returns a `ReplayResult` instead:
`{ ok, diffs, expected, actual, report() }`, where `actual` is the
conversation the bot produced. Each `TranscriptDiff` has a `kind`
(`'missing'`, `'unexpected'`, `'mismatch'` or `'timing'`), the `step` (index of
the inbound turn, `-1` before the first one), `chatId`, `position`, the
`expected` and `actual` turns, the first differing `field` (`'kind'`,
`'text'`, `'content.buttons.0.text'`, `'t'`, `'id'`) and a `message`.
`formatReplayReport(transcript, diffs)` renders the same report.

After each inbound turn the replay waits until the bot has sent at least as
many messages as expected and then stays quiet for `settleMs`, so both missing
and extra replies are detected.

### Tolerance options

| Option | Default | Notes |
| --- | --- | --- |
| `settleMs` | `30` | Quiet period that ends a step once the expected replies arrived. |
| `stepTimeoutMs` | `2000` | Max wait for a step's replies. |
| `order` | `'per-chat'` | Compare each chat's replies in order and tolerate interleaving between chats; `'strict'` compares the global order (and the `chatId`). |
| `timestamps` | `'ignore'` | `{ toleranceMs }` flags a reply whose delay after its inbound turn differs from the recorded one by more than `toleranceMs`. |
| `compareIds` | `false` | Compare outbound message ids (volatile by default). |
| `compareContent` | `true` | Compare the full `content` when the golden has one; `false` compares only `kind` + `text`. |
| `ignoreContentFields` | `[]` | Dot paths inside `content` to skip (`'media'`, `'target.id'`). |
| `masks` | `[]` | `RegExp` or `{ pattern, replace? }` applied to every string on both sides (matches become `'<*>'` by default). |
| `redact` | none | `{ emails?, phones?, rules? }` for goldens made with `outboundPatterns: true`: matches and placeholders of those categories become `<category:*>` on both sides. |
| `normalizeWhitespace` | `true` | Collapse whitespace runs and trim. |
| `normalizeText` | none | Custom normalizer, applied after the masks. |
| `now` | `Date.now` | Clock for the actual `t` offsets. |

`REPLAY_MASKS` has ready-made masks: `isoDate`, `time`, `uuid` and `number`.

## Publish gate (`@bot-wa/deployments`)

::: warning Experimental — not published yet
`@bot-wa/deployments` is a private, in-memory prototype (not on npm): state
lives in RAM and its API may change.
:::

`DeploymentRegistry` keeps immutable versions per tenant and bot with exactly
one active version (`publish`, `active`, `rollback`, `list`).
`publish(tenantId, botId, version, artifact, { gate })` runs the gate
**before** activating the version:

- if it passes, the version is stored and activated with
  `deployment.gate = { passed: true, checkedAt, summary? }`;
- if it fails or throws, `publish` rejects with a `DeploymentGateError`
  (`candidate`, `result`) and nothing is stored, so the same version can be
  fixed and published again.

With a gate, `publish` returns a `Promise`, and the version is reserved while
the gate runs (a duplicate publish fails with `deployment version already
exists`). A gate is any `(candidate) => boolean | GateResult` function, sync or
async; `GateResult` is `{ ok, reason?, summary?, details? }`.

`goldenTranscriptGate(options)` replays golden transcripts against the
candidate and passes only if all of them match. Each transcript runs against a
fresh bot.

```ts
import { readFileSync } from 'node:fs'
import { parseTranscript, REPLAY_MASKS } from '@bot-wa/core/testing'
import { DeploymentGateError, DeploymentRegistry, goldenTranscriptGate } from '@bot-wa/deployments'

const registry = new DeploymentRegistry()
const gate = goldenTranscriptGate({
  transcripts: [parseTranscript(readFileSync('golden/checkout.json', 'utf8'))],
  createBot: (candidate) => loadBotFactory(candidate.artifact),   // returns (provider) => Bot, not started
  replay: { masks: [REPLAY_MASKS.isoDate] },
})

try {
  await registry.publish('acme', 'support', '1.4.0', 'sha256:...', { gate })
} catch (error) {
  if (error instanceof DeploymentGateError) console.error(error.message)   // includes the expected vs actual report
}
```

| Option | Notes |
| --- | --- |
| `transcripts` | An array, or `(candidate) => Transcript[]` (sync or async) to load the files of that version. |
| `createBot` | `(candidate) => ReplayBotFactory` (sync or async). |
| `replay` | `ReplayOptions` passed to `replayTranscript`. |
| `allowEmpty` | Default `false`: with no transcripts, or a transcript without inbound turns or without expected replies (a vacuous pass), the gate fails. |

On failure, `error.result.details.results` lists
`{ name, ok, diffs, report }` per transcript.

## See also

- [Testing](/guide/testing)
- [Control plane](/guide/control-plane)
- [`@bot-wa/deployments` README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/deployments)
