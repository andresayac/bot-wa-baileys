# @bot-wa/graph-core

## 0.2.0-alpha.0

### Minor Changes

- b0034aa: - New `tryParseGraphBody(body)`: non-throwing body parse that returns `{ ok: false, status: 400 }` for anything that is not a JSON object, so `ingest()` handlers can answer 400 to malformed input.
  - `checkGraphSignature` and `parseGraphBody` accept a `Uint8Array` / `ArrayBuffer` raw body (fetch-style request handlers), not only `string` / `Buffer`.
  - `toGraphError` maps more codes: `130429` (throughput), `131056` (pair rate limit) and `131048` (spam rate limit) to `RateLimitedError` with per-code default delays; `131030` (test number allowed list) and `551` (person unavailable) to `RecipientUnreachableError`; Messenger/Instagram `10` / subcode `2018278` (outside the messaging window) to `OutsideSessionWindowError`.
- 1cc2146: New `readGraphResponse(res, { chatId, contentKind, retryAfterMs })`: the single Graph response check shared by the Cloud API, Messenger and Instagram clients. It resolves to the JSON body, or rejects with the typed error `toGraphError` maps it to (honouring `Retry-After`), so the Messenger Platform window / unreachable codes live in one place.
- f8c1d4f: Helpers for durable media references whose token is a hosted URL. `@bot-wa/http` adds `isAllowedHostUrl(url, { hosts, allowHttp?, maxLength? })`, a synchronous host allow-list check (a name also allows its subdomains, an IP literal only itself) for URLs read back from storage. `@bot-wa/graph-core` adds `META_MEDIA_HOSTS` (the Messenger/Instagram attachment CDNs), `serializeUrlMediaRef` and `rehydrateUrlMediaRef`, which the Messenger and Instagram providers use for `serializeMediaRef`/`rehydrateMediaRef`.

### Patch Changes

- 522bcca: Map Graph error `131062` (BSUID recipient not supported, e.g. authentication templates) to `UnsupportedContentError`.
- 9ec06c8: Security: `verifyChallenge` compares `hub.verify_token` in constant time and rejects an empty configured token and non-string query values; `checkGraphSignature` finds `X-Hub-Signature-256` case-insensitively and `verifySignature` validates the hex digest format.
- 8854c8e: `toGraphError` maps the Messenger Platform send errors: window subcodes 2018278 / 2534022 to `OutsideSessionWindowError`, and code 551 plus subcodes 1545041 / 2018001 / 2534014 to `RecipientUnreachableError` (with the `chatId`).
- ce7790f: Packaging: dependencies between `@bot-wa/*` packages are published as caret ranges (`^x.y.z`, from `workspace:^`) instead of exact versions, so npm dedupes a single `@bot-wa/core` instead of installing a second copy when one package lags a patch behind. Published READMEs use absolute GitHub links (relative links broke on npmjs.com), and `@bot-wa/core`/`@bot-wa/http` gain `repository.directory`, `homepage` and `bugs` metadata.
- Updated dependencies [2e16743]
- Updated dependencies [397c2be]
- Updated dependencies [0a2291f]
- Updated dependencies [ddfb1e9]
- Updated dependencies [ee5777c]
- Updated dependencies [522bcca]
- Updated dependencies [588fa34]
- Updated dependencies [a33cb08]
- Updated dependencies [909fa96]
- Updated dependencies [9cb6621]
- Updated dependencies [99251ef]
- Updated dependencies [7cc66b2]
- Updated dependencies [39a8149]
- Updated dependencies [31fcc2e]
- Updated dependencies [40fdab4]
- Updated dependencies [4bbd0ad]
- Updated dependencies [f8c1d4f]
- Updated dependencies [231cbd2]
- Updated dependencies [ca25eb7]
- Updated dependencies [18958c6]
- Updated dependencies [40ec0bd]
- Updated dependencies [fd07c8c]
- Updated dependencies [0149d66]
- Updated dependencies [9c94d93]
- Updated dependencies [08a933f]
- Updated dependencies [1a81406]
- Updated dependencies [64fb59f]
- Updated dependencies [2549ffe]
- Updated dependencies [a4e9429]
- Updated dependencies [310db8d]
- Updated dependencies [2bab262]
- Updated dependencies [6ea4442]
- Updated dependencies [136caa5]
- Updated dependencies [634993f]
- Updated dependencies [b866fbd]
- Updated dependencies [c6a4292]
- Updated dependencies [7b00477]
- Updated dependencies [6504335]
- Updated dependencies [ce42173]
- Updated dependencies [1984f6f]
- Updated dependencies [522bcca]
- Updated dependencies [02a21cc]
- Updated dependencies [23371fb]
- Updated dependencies [9b97391]
- Updated dependencies [f25b2af]
- Updated dependencies [2232f88]
- Updated dependencies [27620ef]
- Updated dependencies [e4574e6]
- Updated dependencies [ce7790f]
- Updated dependencies [b95b523]
- Updated dependencies [5196990]
- Updated dependencies [2c4f9f0]
- Updated dependencies [efb1fa6]
- Updated dependencies [4fc0560]
  - @bot-wa/core@2.0.0-alpha.2
