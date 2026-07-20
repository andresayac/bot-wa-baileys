# Core Transport-Agnostic Reorg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: executed INLINE (tightly-coupled reorg;
> fresh-subagent-per-task is a poor fit). Steps use `- [ ]` for tracking. TDD where net-new
> logic exists; for pure code MOVES the test is "the moved suite stays green".

**Goal:** Make `@bot-wa/core` transport-agnostic (zero WhatsApp concept) with Baileys
re-homed to `@bot-wa/baileys`, driven by `IProvider v2`.

**Architecture:** Provider normalizes inbound→`InboundEvent` and accepts `OutboundContent`;
`buildMessageContext` becomes a thin wrapper; `Dispatcher`/`ConversationRuntime`/`keyFor`
unchanged. See spec `docs/superpowers/specs/2026-07-20-core-transport-agnostic-reorg-design.md`
and the authoritative contract `docs/superpowers/specs/2026-07-20-iprovider-v2-contract.ts`.

**Tech Stack:** TypeScript 7 (ESM/NodeNext, Node ≥20), pnpm workspace, vitest.

## Global Constraints

- `@bot-wa/core` imports NO `@whiskeysockets/baileys`; no JID/LID/PN/`@g.us`/`WAMessageKey`/
  `proto`/QR. Final check: `grep -rE "baileys|@g.us|@lid|WAMessageKey|proto\." packages/core/src` → empty.
- `ChatId`/`UserId`/`MessageId` opaque strings; no suffix-match / `@`-split / jid helpers in core.
- Stability invariant is normative on `IProvider`; `keyFor` = `` `${chatId}:${senderId}` `` unchanged.
- Zero new runtime deps in core; `better-sqlite3` out of core entirely.
- Hard-break: `ctx.key`→`ctx.ref`, `ctx.rawMessage`→`ctx.raw`; no deprecated aliases.
- Every task ends build+suite green (`pnpm -r build`, `pnpm -r test`). Baseline: 156 tests.
- Contract signatures copied VERBATIM from `2026-07-20-iprovider-v2-contract.ts`.

---

### Task 1: Contracts in `@bot-wa/core`

**Files:**
- Create: `packages/core/src/core/provider.ts` (IProvider v2 + Inbound/Outbound/errors/caps/connection)
- Modify: `packages/core/src/core/types.ts` (add normalized `ChatId/UserId/MessageId/MessageRef/ChatInfo/SenderInfo/MessageType/Media*/MessageContext/SentMessage/BuildContextDeps/BotConfig`; keep old ones temporarily)
- Modify: `packages/core/src/store/IStore.ts` (add generic `StoredMessage/StoredChat/StoredContact`, `messageKey(ref)`, cursor; keep old signatures behind the transition)
- Test: `packages/core/tests/contract.test.ts`

**Deliverable:** Core exports the v2 contract; compiles; a fake minimal `IProvider` typechecks.

- [ ] Copy sections 1–9 + `MessageContext`/`SentMessage`/`BuildContextDeps`/`IStore`/`BotConfig`
      from the contract artifact into the files above (verbatim signatures).
- [ ] Write `contract.test.ts`: construct a fake `IProvider` (id, capabilities, start/stop/send/onEvent),
      assert `messageKey({id:'m',chatId:'c'})==='c:m'`, assert error classes instanceof `ProviderError`.
- [ ] `pnpm --filter @bot-wa/bot-wa-baileys build` → 0 errors. `npx vitest run tests/contract.test.ts` → pass.
- [ ] Commit: `feat(core): add IProvider v2 + normalized transport-agnostic contract`.

### Task 2: Scaffold `@bot-wa/baileys`

**Files:**
- Create: `packages/baileys-provider/package.json` (`name:@bot-wa/baileys`, deps: baileys + hapi/boom + ffmpeg/sharp/qr etc.; `@bot-wa/core` as workspace dep)
- Create: `packages/baileys-provider/tsconfig.json`, `src/index.ts`
- Modify: `pnpm-workspace.yaml` (already globs `packages/*`)

**Deliverable:** Empty package builds and can import from `@bot-wa/core`.

- [ ] Author package.json/tsconfig mirroring `packages/ai`. Move baileys + media deps here from core.
- [ ] `pnpm install`; `pnpm --filter @bot-wa/baileys build` → 0 errors (empty entry).
- [ ] Commit: `chore(baileys): scaffold @bot-wa/baileys package`.

### Task 3: Move the Baileys transport into `@bot-wa/baileys`

**Files (move from `packages/core/src` → `packages/baileys-provider/src`):**
`provider/BaileysProvider.ts`, `provider/reconnect.ts`, `utils/jid.ts`, `core/identity.ts`,
`media/MediaProcessor.ts`, `ratelimit/RateLimiter.ts`, `api/{Groups,Profile,Privacy,Chats,Presence}API.ts`,
`qr-image.d.ts`. Move tests: `jid.test.ts`, `reconnect.test.ts`, `lid-identity.test.ts`,
`ratelimit.test.ts`, `e2e-transcript.test.ts` (LID/PN).

**Deliverable:** Baileys code lives in its package; imports updated to `@bot-wa/core` for contracts.

- [ ] Move files; fix imports (contracts now from `@bot-wa/core`).
- [ ] `pnpm -r build` → 0 errors. `pnpm --filter @bot-wa/baileys test` → moved suites green.
- [ ] Commit: `refactor(baileys): move WhatsApp transport out of core`.

### Task 4: `onEvent` + `toInbound` + outbound mapper in BaileysProvider

**Files:** Modify `packages/baileys-provider/src/provider/BaileysProvider.ts`; create
`src/toInbound.ts` (proto→`InboundMessage`, moved from core `context.ts`), `src/toOutbound.ts`
(`OutboundContent`→`AnyMessageContent`).

**Deliverable:** `BaileysProvider implements IProvider<proto.IWebMessageInfo>` — `onEvent(InboundEvent)`,
`send(OutboundContent)`, `capabilities`, Boom→`DisconnectReason`, QR→`authPayload`.

- [ ] Implement `onEvent` translating internal `TypedEmitter` keys → `InboundEvent` union.
- [ ] `toInbound`: port body/type/mentions/quoted/media extraction + `IdentityStore` canonicalization
      so emitted `chatId/senderId` are stable. `toOutbound`: map each `OutboundContent.kind`
      (`buttons`→numbered text degrade; unsupported→`UnsupportedContentError`).
- [ ] Test `packages/baileys-provider/tests/normalize.test.ts`: a fake proto text message →
      `{kind:'message', message:{type:'text', body, chatId, senderId}}`; an image → `media` ref.
- [ ] `pnpm --filter @bot-wa/baileys build && ...test` green. Commit: `feat(baileys): implement IProvider v2 onEvent/send`.

### Task 5: `context.ts` → thin wrapper in core

**Files:** Modify `packages/core/src/core/context.ts`.

**Deliverable:** `buildMessageContext(BuildContextDeps)` takes a normalized `InboundMessage`
(no proto, no identity pass) and a `send(OutboundContent)`; `ctx.*` helpers build descriptors.

- [ ] Rewrite: drop proto parsing + `normalizeInboundKey` + identity; read fields off `inbound`;
      helpers (`reply/photo/poll/react/...`) build `OutboundContent` and call `deps.send`.
      Add `ctx.ref`, `ctx.raw`, `ctx.interaction?`, `ctx.acknowledge?`, `ctx.sendNative`.
- [ ] Update/port `packages/core/tests` that build contexts to the new deps shape.
- [ ] `pnpm --filter @bot-wa/bot-wa-baileys build` green. Commit: `refactor(core): buildMessageContext over normalized inbound`.

### Task 6: `Bot.ts` on `onEvent` + interaction projection

**Files:** Modify `packages/core/src/core/Bot.ts`.

**Deliverable:** Bot subscribes `provider.onEvent`; routes `kind:'message'`→dispatcher;
projects `kind:'interaction'`→`type:'buttons'` ctx with `acknowledge()`; maps `kind:'connection'`
→ `ready`/`qr`(authPayload)/`close`. `seedIdentity`/`getPNForLID` removed from core.
`BotConfig.provider` required.

- [ ] Replace `wireMessageEvents` (rawMessage) with `onEvent` switch. Remove identity seeding.
      Move WA session config out of `BotConfig` (now provider-constructed).
- [ ] Port `bot-integration`/`bot-events`/`dispatcher` tests to inject a `MockProvider v2`.
- [ ] `pnpm --filter @bot-wa/bot-wa-baileys build` green. Commit: `refactor(core): drive Bot from IProvider v2 onEvent`.

### Task 7: `MockProvider v2` + `createTestBot`

**Files:** Modify `packages/core/src/testing/MockProvider.ts`, `createTestBot.ts`.

**Deliverable:** `MockProvider implements IProvider v2`; `incoming(text,opts)` emits
`{kind:'message', message}`; `interaction(data)` emits `{kind:'interaction'}`; `outbox` records sends.

- [ ] Rewrite MockProvider to `onEvent`/`send`/`capabilities`. `incoming` builds a normalized
      `InboundMessage`. Keep `outbox` API for assertions.
- [ ] `pnpm --filter @bot-wa/bot-wa-baileys test` → core suites (dispatcher/runtime/dsl/controls/
      checkpoint/slash/matching/duration/boundedMap/validate-config/bot-*) green.
- [ ] Commit: `test(core): MockProvider v2 emits normalized InboundEvent`.

### Task 8: Rename core + extract sqlite-store

**Files:** `packages/core/package.json` (`name:@bot-wa/core`), all workspace `package.json`
deps, `packages/sqlite-store/*` (move `SQLiteStore.ts` + `sqlite-store.test.ts`;
`better-sqlite3` here).

**Deliverable:** `@bot-wa/core` + `@bot-wa/baileys` + `@bot-wa/sqlite-store` + `@bot-wa/ai`.

- [ ] Rename core package; update `@bot-wa/ai` and `@bot-wa/baileys` deps to `@bot-wa/core`.
- [ ] Move SQLiteStore to its package; remove `better-sqlite3` peer/dev from core.
- [ ] `pnpm install`; `pnpm -r build && pnpm -r test` green. Commit: `refactor: rename @bot-wa/core; extract @bot-wa/sqlite-store`.

### Task 9: Update `@bot-wa/ai` to v2

**Files:** `packages/ai/src/*` (AIClient, plugin, ContextManager, chatKey).

**Deliverable:** `@bot-wa/ai` compiles against v2 (`ctx.ref/raw`, `IStore` generic, `IProvider`).

- [ ] Replace `ctx.key`/`ctx.rawMessage` reads with `ctx.ref`/`ctx.raw`; adapt store use to generic `IStore`.
- [ ] `pnpm --filter @bot-wa/ai build && test` → 25 tests green.
- [ ] Commit: `refactor(ai): adapt to IProvider v2 (ref/raw)`.

### Task 10: Green total + demo smoke

**Files:** `packages/baileys-provider/examples/bot.ts` (moved demo; constructs
`new Bot({ provider: new BaileysProvider({...}) })`).

**Deliverable:** Whole workspace green + the demo boots to QR through the new packages.

- [ ] Update the example to the new construction shape. Grep-verify Global Constraint (no baileys in core).
- [ ] `pnpm -r build && pnpm -r test` → ≥156 green. Build + run the demo; confirm QR renders.
- [ ] Commit: `chore: transport-agnostic core reorg complete`.

## Self-Review

- **Spec coverage:** contract (T1), baileys extraction (T3-4), thin context (T5), Bot rewire +
  interaction projection (T6), MockProvider v2 (T7), rename + sqlite extract (T8), ai (T9),
  green+grep constraint (T10). Cloud API/AI presets/Redis correctly deferred. ✓
- **Type consistency:** all signatures sourced from the one committed contract artifact. ✓
- **Coupling note:** T4↔T5↔T6 are one logical rewrite split for test checkpoints; if a boundary
  proves artificial mid-execution, merge and keep the suite green rather than forcing a seam.
