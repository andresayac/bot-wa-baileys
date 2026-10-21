---
"@bot-wa/http": minor
"@bot-wa/graph-core": minor
---

Helpers for durable media references whose token is a hosted URL. `@bot-wa/http` adds `isAllowedHostUrl(url, { hosts, allowHttp?, maxLength? })`, a synchronous host allow-list check (a name also allows its subdomains, an IP literal only itself) for URLs read back from storage. `@bot-wa/graph-core` adds `META_MEDIA_HOSTS` (the Messenger/Instagram attachment CDNs), `serializeUrlMediaRef` and `rehydrateUrlMediaRef`, which the Messenger and Instagram providers use for `serializeMediaRef`/`rehydrateMediaRef`.
