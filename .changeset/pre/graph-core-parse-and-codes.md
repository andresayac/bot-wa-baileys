---
"@bot-wa/graph-core": minor
---

- New `tryParseGraphBody(body)`: non-throwing body parse that returns `{ ok: false, status: 400 }` for anything that is not a JSON object, so `ingest()` handlers can answer 400 to malformed input.
- `checkGraphSignature` and `parseGraphBody` accept a `Uint8Array` / `ArrayBuffer` raw body (fetch-style request handlers), not only `string` / `Buffer`.
- `toGraphError` maps more codes: `130429` (throughput), `131056` (pair rate limit) and `131048` (spam rate limit) to `RateLimitedError` with per-code default delays; `131030` (test number allowed list) and `551` (person unavailable) to `RecipientUnreachableError`; Messenger/Instagram `10` / subcode `2018278` (outside the messaging window) to `OutsideSessionWindowError`.
