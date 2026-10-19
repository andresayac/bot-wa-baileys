# @bot-wa/wa-gateway-kit (private)

Internal package: the code shared by the WhatsApp REST gateway transports
[`@bot-wa/evolution`](../evolution-provider) and
[`@bot-wa/wppconnect`](../wppconnect-provider). It is `"private": true`, never
published, and its API can change at any time. Use those providers instead;
they re-export the public pieces (`WaIdentityStore`, `normalizeJid`,
`IdentityPersistence`, `RestHttpOptions`).

| Module | Contents |
| --- | --- |
| `rest.ts` | `restCall` (JSON over `secureFetch`, no redirects, secrets kept out of error messages), `resolveHttpPolicy`, `parseRetryAfter`, `describeErrorBody`, `isRecord` |
| `media.ts` | `resolveMedia` (public URL passthrough, everything else inline base64), `guessMimetype`, `toDataUri` |
| `identity.ts` | `WaIdentityStore` (bounded LRU LID/PN reconciliation with optional persistence), `normalizeJid`, `isLidJid`, `isGroupJid` |
