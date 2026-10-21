# @botmesh/baileys

The **WhatsApp via [Baileys 7](https://github.com/WhiskeySockets/Baileys)** transport ([`IProvider` v2](https://github.com/andresayac/botmesh/blob/main/packages/core/src/core/provider.ts)) for [`@botmesh/core`](https://github.com/andresayac/botmesh/tree/main/packages/core). It links the bot as a WhatsApp Web device (QR or pairing code) and opens its own WebSocket: no public server and no webhook needed.

> **Unofficial client.** Baileys implements the WhatsApp Web protocol by reverse engineering; neither WhatsApp nor Meta endorses it. Automating an account may break the [WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service) and end in **a banned number**. Use a dedicated number, write only to people who asked you to (opt-in), do not send bulk messages and keep the rate limiter on. If you need an official route with no ban risk, use [`@botmesh/meta`](https://github.com/andresayac/botmesh/tree/main/packages/meta-provider) (WhatsApp Cloud API).

- **Ingress:** own socket with reconnect and backoff; Baileys events are translated into neutral `InboundEvent`s: messages, reactions, poll votes (decrypted by the provider), group changes, calls and presence.
- **Outbound:** text, image, video, audio, voice note (transcoded to Opus), document, sticker (converted with `sharp`), location, contact, **native polls** and reactions. Buttons, lists and cards degrade to numbered text.
- **Actions:** read receipts, typing/recording, deleting messages and downloading inbound media.
- **Stable identity:** the provider resolves WhatsApp's LID/PN duality before emitting every event, so the core always sees the same `senderId` for the same person.

## Requirements

- **Node ≥ 22** (ESM-only).
- **`@whiskeysockets/baileys` 7.0.0-rc14 or newer.** Since late July 2026 WhatsApp closes connections that use the previous handshake with `428 Connection Terminated`, even before showing the QR. rc14 brings the updated handshake (among other things, the WhatsApp Web version bundled in the package). If your lockfile resolves an older rc, upgrade it.
- Network egress to `wss://web.whatsapp.com` and, at startup, to `raw.githubusercontent.com`: the provider queries the latest WhatsApp Web version published by Baileys. Without access it uses the version bundled in the installed release, which is why that release must be ≥ rc14.

## Installation

In the monorepo the package is already available as a workspace. From an app:

```bash
pnpm add @botmesh/core @botmesh/baileys
```

`ffmpeg` is bundled (`@ffmpeg-installer/ffmpeg`) for voice notes, and `sharp` for stickers.

## Quickstart

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const bot = new Bot({ provider: new BaileysProvider({ session: 'my-bot' }) })

bot.on('ready', () => console.log('✅ Connected'))
bot.when('hola', (ctx) => ctx.reply('👋 Hello!'))

await bot.start()   // the first time it prints the QR in the terminal: scan it from WhatsApp → Linked devices
```

The session is stored in `./sessions/my-bot`; later starts reconnect without a QR. There is a full example (commands, flows, media, hooks, DI and scheduler) in [`examples/bot.ts`](https://github.com/andresayac/botmesh/blob/main/packages/baileys-provider/examples/bot.ts) (`pnpm --filter @botmesh/baileys example`).

## Configuration

```ts
interface BaileysProviderConfig {
  session?: string            // session id, 'default' by default
  sessionsDir?: string        // root folder for sessions, './sessions' by default
  pairingCode?: string        // phone in international format: pair with a code instead of a QR
  qr?: QrConfig               // how to show the QR (terminal, small size by default)
  rateLimit?: RateLimitConfig // anti-ban send pacing (on by default)
  reconnect?: boolean         // true by default
  browser?: BrowserConfig     // device identity; better leave it alone (see below)
  markOnlineOnConnect?: boolean // false by default: the phone keeps receiving notifications
  syncFullHistory?: boolean     // false by default
  ignoreBroadcasts?: boolean    // true by default (status@broadcast is always ignored)
  ignoreNewsletters?: boolean   // true by default
  pollStore?: PollStore         // poll persistence to read votes after a restart (see Polls and votes)
  durableMedia?: { viewOnce?: boolean } // with durability: journal view-once media too (off by default)
  debug?: boolean               // 'debug' level on the default logger (otherwise 'error')
  logger?: LoggerLike           // any logger with debug/info/warn/error (pino, console…); Baileys gets an adapter (toBaileysLogger)
}
```

### Session

Each session lives in `<sessionsDir>/<session>` and holds the linked device's credentials. For several numbers, use a different `session` per number. The validation rules are in [Session security](#session-security).

### QR or pairing code

By default the provider emits a QR. If the server has no camera or terminal at hand, ask for a **pairing code**:

```ts
const provider = new BaileysProvider({
  session: 'my-bot',
  pairingCode: '+57 300 123 4567',   // only the digits count
  qr: { terminal: false },
})
const bot = new Bot({ provider })
bot.on('qr', (artifact) => {
  // Both the QR (long strings) and the 8-character code arrive here.
  if (artifact.length === 8) notifyOperator(artifact)
})
await bot.start()
```

On the phone: **Linked devices → Link with phone number** and enter the code. The code is requested once per start, together with the first QR. If the request fails, the provider logs it and keeps offering the QR. The QR and the code also arrive in the `connection` event, as `authPayload`.

### QR rendering

```ts
interface QrConfig {
  terminal?: boolean        // draw the QR on stdout
  small?: boolean           // compact QR (true by default)
  file?: boolean | string   // PNG: true → '<session>.qr.png' in the CWD; a string fixes the path
  handler?: (qr: string) => void | Promise<void>  // your own render (web, Slack…)
}
```

Without `qr`, it is drawn in the terminal. If you pass a `qr` object, only what you set is enabled. Errors writing the PNG are logged, never thrown.

> The QR and the pairing code grant access to the account while they are valid. Never log them or send them over unencrypted channels, and delete the PNG when you no longer need it.

### Browser identity (`browser`)

**Leave it undefined.** The provider then omits the option and Baileys uses its default identity (`Browsers.macOS('Chrome')`), which is the one the rc14 handshake validates. The `'macOS' | 'ubuntu' | 'windows' | 'appropriate'` presets announce **Chrome** on that operating system. A custom tuple `[os, browser, version]` is passed through and leaves a warning in the log: with non-standard identities (e.g. `'Desktop'` or an invented name), WhatsApp may close the connection with `428` before the QR.

### Rate limiter (anti-ban)

Every `send()` goes through a token bucket before reaching the socket. Sends that exceed the limit are **queued, not dropped**, and a throttled chat does not hold the others back.

```ts
new BaileysProvider({
  session: 'my-bot',
  rateLimit: {
    perChat: { max: 5, window: '10s' },   // default
    global: { max: 50, window: '60s' },   // default
    jitter: { min: 500, max: 1500 },      // "human" pause between sends (off by default)
    maxWait: '30s',                       // after this long in the queue the send fails with RateLimiterTimeout (a RateLimitedError)
    // enabled: false                     // turn it off completely (not recommended)
  },
})
```

More detail in the [Rate limiting](https://github.com/andresayac/botmesh/blob/main/docs/guide/rate-limiting.md) guide.

### Reconnect and backoff

When the socket closes, the provider emits `connection` with `state: 'closed'` and decides based on the Baileys code:

| Code | Meaning | What the provider does | `reason` |
| --- | --- | --- | --- |
| 401 `loggedOut`, 500 `badSession`, 411 `multideviceMismatch` | The session is no longer valid | Deletes **only** that session's folder and starts over (new QR) | `sessionInvalid` |
| 440 `connectionReplaced`, 403 `forbidden` | Another instance uses the session, or forbidden | **Does not reconnect** (fighting the other instance risks the number) | `sessionTakenOver` |
| 515 `restartRequired` | Normal restart after pairing | Reconnects instantly | `transient` |
| Everything else (428, 408, 503…) | Transient drop | Exponential backoff: 1 s, 2 s, 4 s… up to 30 s, at most 10 attempts | `transient` |

If `start()` fails during a reconnect (for example, no network), it is retried with the same backoff and the same cap. When it is exhausted, a final `closed` is emitted with `detail.message: 'reconnect exhausted'`. With `reconnect: false` it never retries. The counter goes back to zero every time the connection opens.

## Identity: LID and PN

WhatsApp identifies every user in two ways: the phone number (**PN**, `573001234567@s.whatsapp.net`) and an opaque identifier (**LID**, `…@lid`). The same contact may arrive as a PN, as a LID with the PN next to it (`remoteJidAlt`/`participantAlt`) or as a bare LID, and the form can change from one message to the next. If the bot used the raw `remoteJid`, the same person would be split into two keys and flows would break (the `ask` never receives the answer).

The provider resolves it with an `IdentityStore` **before** emitting every event:

- It learns the LID↔PN pair when it sees it: in the message key, in `lid-mapping.update` events and by querying Baileys' mapping store (stored in the session folder, so it survives restarts).
- It canonicalizes: when it knows a LID's PN, `chatId` and `senderId` use the **PN**. Otherwise they use the **LID**. Always normalized, without the device suffix (`:12`).
- In groups, `chatId` is the group (`…@g.us`) and `senderId` is the canonicalized participant.
- `ctx.senderInfo.platformData` carries `{ phoneNumber?, lid? }`: the PN when known and the raw LID as it arrived.
- The other events go through the **same** canonicalization, so a person has the same id everywhere: the author of a reaction or a vote, the participants and the author (`actor`) of a group change, the caller (`call.from`) and the chat and keys of `presences`. The provider takes advantage of the PN Baileys includes in each event (`participantAlt`, `authorPn`, `callerPn`, the participant's `phoneNumber`) and, when it does not, queries the mapping store.
- In a reaction, `senderId` is **whoever reacts** and `ref.id` is the reacted message (previously the author of that message was reported, by mistake).
- Mentions (`mentions`) and the author of the quoted message (`quoted.senderId`) are canonical too: in a group addressed by LID, WhatsApp mentions and quotes with LIDs, and the provider swaps them for the PN when it knows it (querying the mapping store if needed). That way `ctx.quoted?.senderId === provider.selfId` detects a reply to a message sent by the bot. The quote and the mentions are also read from captions of photos, videos and documents, and `quoted.ref` points at the quoted message (usable as `quoted` to reply in the thread).
- Wrapped messages (disappearing mode, *view once*, document with caption) are unwrapped before being classified, so they arrive with their real `type`, `body` and `media`.
- `provider.selfId` is the bot's normalized PN (`573000000000@s.whatsapp.net`, without the device suffix `:12` that `creds.me.id` stores), the same id its own reactions and votes carry. With `groupMode: 'mentions'`, the core compares mentions against `selfId`, so the bot answers whether it is mentioned by its number or by its LID.
- In `group`, the provider translates Baileys' `modify` action (number change) into `action: 'update'`, but rc14 never gets to emit it: while processing the number change, Baileys runs `JSON.parse` on the notice's raw JIDs and throws before emitting the event. In practice, with rc14 a number change produces no `group` event at all.
- When sending to a LID, the provider uses the PN if it knows it and, otherwise, sends directly to the LID.

For advanced cases, `IdentityStore`, `provider.getPNForLID(lid)` and the JID helpers (`isPn`, `isLid`, `normalizeJid`, `sameUser`…) are exported.

### Contacts with a username (2026)

With WhatsApp usernames, some contacts **never** expose their number: they always arrive as `@lid`, with no PN next to it and no known mapping. For them the identity is **stable on the LID**: all their messages produce the same `chatId`/`senderId`, `platformData.phoneNumber` stays `undefined` and sends go to the LID. Do not assume `senderId` is a phone: check it with `isPn()` before using it as one.

**Residual behaviour:** if the LID→PN mapping is learned **later** (a message arrives with the PN next to it or a `lid-mapping.update` comes in), from that moment the person is identified by their PN. A conversation that started under the LID keeps waiting on the LID key and will not see the following messages, which arrive with the PN. In practice:

- Set `.timeout()` on flows (or `timeout` on `c.ask`/`c.waitText`) so an orphaned conversation closes itself. The user restarts it with the trigger or with a command such as `/reset`.
- If you store per-person data (CRM, preferences), store `platformData.phoneNumber` and `platformData.lid` too, so you can reconcile the two records.

## Polls and votes

`ctx.poll(question, options, multiSelect?)` sends a native poll. Votes reach the bot as a `poll` event, already decrypted and with the full tally:

```ts
await ctx.poll('Pizza or sushi?', ['Pizza', 'Sushi'])

bot.on('poll', (vote) => {
  // vote.ref.id      → poll id (vote.ref.native is the poll message)
  // vote.ref.chatId  → chat where the vote was cast, the same chatId its messages use
  // vote.senderId    → whoever just voted, with the canonical identity of their messages
  // vote.options     → current tally: [{ name, votes, voters }]
  const chosen = vote.options.filter((o) => o.voters?.includes(vote.senderId)).map((o) => o.name)
  console.log(chosen.length ? `Chose: ${chosen.join(', ')}` : 'Withdrew their vote')
})
```

WhatsApp encrypts every vote end to end with a key derived from the poll secret (`messageSecret`), its id and the creator's and voter's JIDs. Baileys 7 ships that decryption commented out, so the provider does it on its own:

- **It remembers the polls it sees:** those the bot sends (the `send()` result and the `append` echo Baileys emits) and those others create in the chats the provider listens to. Polls from ignored chats (statuses, broadcast lists, channels; see `ignoreBroadcasts`/`ignoreNewsletters`) take no room, except the bot's own. It keeps the **500** most recent in memory; a poll that receives votes stays among the recent ones.
- **It ties every vote to its poll:** a vote only names the poll by its id, and any member of a chat knows the id and secret of its polls. That is why the provider requires the vote to arrive through the **same chat** as the poll (counting the LID and PN forms of one chat) and to name the **same creator**. Another poll reusing the id (ids are chosen by the client that sends) cannot add votes to the one already in memory. Votes that do not comply are dropped with a `debug`-level log.
- **It decrypts by trying the LID and PN forms** of the creator and the voter. In a group addressed by LID the vote is signed with the LIDs; in a chat by PN, with the numbers. A wrong pair does not pass the AES-GCM authentication, so trying them produces no false positives.
- **It keeps each person's last vote:** a new vote replaces the previous one, an empty selection withdraws it and a vote older than the stored one is dropped. A person counts once even if they vote first as a LID and later show up with their PN.
- **Every vote counts once:** Baileys redelivers offline messages as `append`, so the provider remembers the ids of the last 5000 counted votes and does not emit a repeated one. A different vote from the same person with the same timestamp does update the tally.
- The encrypted vote no longer arrives as a `poll`-type message. `bot.onPoll` only fires for polls created by someone else, with the question in `body`.

Limitations:

- Without a `pollStore`, only votes for polls **this process** saw are decrypted. After a restart memory starts empty, so votes for earlier polls (or ones evicted from the cache) are dropped with a `debug`-level log. To keep them, configure a [`pollStore`](#persisting-polls-pollstore). A vote that cannot be decrypted leaves a `warn` with the poll id, no JID and no content.
- **The bot cannot vote.** Baileys 7 has no API to build an encrypted vote (no vote content in `sendMessage`, no `decryptPollVote` counterpart for encrypting); you would have to reimplement the encryption and send it with `relayMessage`. That is why there is no `ctx.vote()`.

### Persisting polls (`pollStore`)

To decrypt votes that arrive **after a restart**, pass a `pollStore`: a minimal async interface, keyed by the poll message id, that you can back with Redis, SQL or a file.

```ts
import type { PollStore, StoredPoll } from '@botmesh/baileys'

const pollStore: PollStore = {
  get: async (id) => {
    const raw = await redis.get(`poll:${id}`)
    return raw ? (JSON.parse(raw) as StoredPoll) : undefined
  },
  set: async (id, poll) => { await redis.set(`poll:${id}`, JSON.stringify(poll), 'EX', 30 * 24 * 3600) },
  delete: async (id) => { await redis.del(`poll:${id}`) },
}

new BaileysProvider({ session: 'my-bot', pollStore })
```

- `StoredPoll` is plain JSON: the poll key (chat and creator, with their LID/PN forms), the question, the `messageSecret` in base64, the options with their hash and each person's last vote. It stores no other messages.
- The provider calls `set` when it sees a new poll and after every counted vote; `get` when a vote arrives for a poll that is not in memory (or a new poll reuses an id); and `delete` when an entry is malformed. The in-memory cache of 500 polls still sits in front of the store.
- After a restart, the tally continues where it left off and the same rules hold: the vote must arrive through the same chat and name the same creator, and a later poll with the same id does not overwrite the stored one.
- Retention (TTL, cleanup) is up to you. If the store fails, the provider logs it as a `warn` and continues with the in-memory cache: it never breaks a send or the reception.
- **The entry holds the poll secret**, with which its votes are decrypted: treat the store as carefully as the session folder.

`vote.ref.native` of a poll loaded from the store is a reconstructed poll message (key, question, options and secret), enough to quote it.

## Session security

The session folder (`creds.json` and the Signal keys) **is** the account: whoever copies it can read and send messages as your number.

- **Path containment.** `session` is an opaque id: 1 to 128 characters among letters, digits, `.`, `_` and `-`, starting with a letter or digit. It admits no separators and no `..`. It is validated in the constructor, before touching the disk. `sessionsDir` cannot be the filesystem root. Before reading, writing or deleting, the provider rejects a session folder that is a symbolic link and checks with the real path that it stays inside `sessionsDir`.
- **`stop()` vs `logoutAndDeleteSession()`.** `stop()` closes the socket and **keeps** the session: the next `start()` reconnects without a QR. `logoutAndDeleteSession()` unlinks the device in WhatsApp and deletes **only** that session's folder, so the next start asks for a new QR. Use it only when you really want to unlink.
- **Automatic deletion.** On 401/500/411 (invalid session) the provider deletes the session folder on its own so it can pair again.
- Add `sessions/` to `.gitignore`, restrict the folder permissions (e.g. `chmod 700`) and do not run two instances with the same session: WhatsApp would close one with `440 conflict`.
- The provider logs no QR, codes or message bodies. With `debug: true` Baileys' log is very verbose; do not leave it on in production.

## Capabilities

| Capability | Value | Notes |
| --- | --- | --- |
| `buttons` | ❌ | degrade to numbered text |
| `lists` | ❌ | degrade to numbered text |
| `polls` | ✅ | native poll sending and vote reading with the `poll` event (see [Polls and votes](#polls-and-votes)) |
| `reactions` | ✅ | send and receive; `senderId` is whoever reacts |
| `edit` | ❌ | |
| `typing` | ✅ | `composing` / `recording` / `paused` |
| `presence` | ✅ | `presence` events |
| `readReceipts` | ✅ | `markRead` |
| `groups` | ✅ | group messages and participant events |
| `templates` | ❌ | they require the Cloud API (`@botmesh/meta`) |
| `interactionsRequireAck` | ❌ | |
| `pushIngress` | ❌ | the provider keeps its own socket |

## Error mapping

`send()` only rejects with `ProviderError` subclasses from `@botmesh/core`. Failures from `sock.sendMessage`, the rate limiter and content preparation are converted like this:

| Cause | Becomes |
| --- | --- |
| Baileys 429 | `RateLimitedError` (`retryAfterMs` comes from `retry-after`, 1 s by default) |
| 413 or *too large* | `PayloadTooLargeError` |
| 401 / 403, *forbidden*, *not-authorized*, *blocked* | `RecipientUnreachableError` |
| `kind: 'template'` or `'native'` | `UnsupportedContentError` |
| wait in the rate limiter queue longer than `maxWait` | `RateLimiterTimeout`, a subclass of `RateLimitedError` |
| `stop()` with sends still queued | `ProviderError('RateLimiter reset')` |
| no connected socket | `ProviderError('Provider not connected')` |
| anything else | `ProviderError`, with the original error in `cause` |

`RateLimiterTimeout` keeps its `name` and its `chatId` and `waitedMs` fields, so code that already caught it keeps working. Because it is a `RateLimitedError`, it is also caught by a transport-portable `catch (e instanceof RateLimitedError)`; its `retryAfterMs` is the time left until the bucket blocking it recovers a token.

## Limitations

- **No native buttons or lists.** WhatsApp Web stopped supporting them for unofficial clients. Use numbered menus with `choose()` (in the DSL `flow().choose(...)` or in conversations `c.choose(...)`) or a native poll with `ctx.poll(question, options)`. `ctx.buttons(...)` and the `list` content still work, but arrive as numbered text.
- **Poll votes:** without a `pollStore`, only those for polls the process has seen since it started are read, and the bot cannot vote (see [Polls and votes](#polls-and-votes)). If the answer must survive a restart, configure a `pollStore` or use `choose()`.
- No templates and no 24-hour window: that belongs to the Cloud API.
- Sent messages cannot be edited (`edit: false`).

## Notes

- ESM only (`"type": "module"`); relative imports carry the `.js` extension.
- To answer WhatsApp's resend requests (`getMessage`), the provider keeps the last 2000 messages of the chats it listens to and of the bot itself in memory. Messages from ignored chats (statuses, broadcast lists, channels) take no room.
- Errors are logged under pino's `err` key, so the log shows message and stack. If you inject your own `logger`, keep pino's error serializer.
- `provider.socket` exposes the Baileys socket for operations the `IProvider` does not cover (groups, profile…). Use it carefully: whatever you do there bypasses the rate limiter and the error mapping.
