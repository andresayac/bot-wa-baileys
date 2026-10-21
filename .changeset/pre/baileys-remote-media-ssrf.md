---
"@bot-wa/baileys": minor
---

Security: outbound `{ url }` / `https://…` media is now downloaded by the provider through `@bot-wa/http` (every redirect hop vetted, private and link-local hosts refused, socket pinned to the vetted address, 64 MiB and 60 s caps) and sent to Baileys as a Buffer. Baileys' own `fetch` followed redirects blindly, so a public URL redirecting to an internal address was an SSRF. New `remoteMedia` option (`maxBytes`, `timeoutMs`, `allowHttp`, `maxRedirects`, `resolver`, `fetch`); `remoteMedia.allowPrivateHosts: true` restores the previous pass-through. An unsafe or failing URL rejects with `UnsupportedContentError`, an oversized one with `PayloadTooLargeError`.
