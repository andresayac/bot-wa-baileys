---
"@bot-wa/meta": patch
---

- `ingest()` answers `400` for a body that is not a JSON object instead of throwing.
- Template quick-reply buttons (`type: 'button'`) arrive as `button` interactions carrying the button `payload` (they were `unknown` messages with an empty body).
- Replies expose the quoted message as `quoted.ref` (its `wamid`).
- Statuses other than `sent` / `delivered` / `read` / `failed` (e.g. `deleted`, `warning`) are dropped instead of being reported as `failed`, which also kept them from triggering session-window fallbacks.
- Location and contact messages get a readable `body`.
- Buffer / stream / path media are uploaded with a real MIME type (document `mimetype`, file extension, magic bytes, then a per-kind default) instead of `application/octet-stream`, which the Cloud API rejects for images, audio, video and stickers; documents keep their `filename` in the upload.
- Requests that never get a response (DNS, TLS, reset) reject with a `ProviderError`, including the media CDN download, where an SSRF refusal or timeout is a `ProviderError` and an oversized file a `PayloadTooLargeError`.
