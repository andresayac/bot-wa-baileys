---
"@bot-wa/http": minor
---

Precise `SecureHttpError` codes. Out-of-range `timeoutMs`, `maxBytes` or `maxRedirects` now reject with `INVALID_OPTIONS`, and a non-2xx response in `fetchBuffer` rejects with `HTTP_STATUS` plus the response code in the new `error.status`; both used to reuse `INVALID_URL`, which now means only an unparseable URL or redirect `Location`. Code that matched `INVALID_URL` to catch HTTP failures must switch to `HTTP_STATUS`.
