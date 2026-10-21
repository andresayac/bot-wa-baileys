# @bot-wa/http

## 0.2.0-alpha.0

### Minor Changes

- 1af5d4c: Precise `SecureHttpError` codes. Out-of-range `timeoutMs`, `maxBytes` or `maxRedirects` now reject with `INVALID_OPTIONS`, and a non-2xx response in `fetchBuffer` rejects with `HTTP_STATUS` plus the response code in the new `error.status`; both used to reuse `INVALID_URL`, which now means only an unparseable URL or redirect `Location`. Code that matched `INVALID_URL` to catch HTTP failures must switch to `HTTP_STATUS`.
- f8c1d4f: Helpers for durable media references whose token is a hosted URL. `@bot-wa/http` adds `isAllowedHostUrl(url, { hosts, allowHttp?, maxLength? })`, a synchronous host allow-list check (a name also allows its subdomains, an IP literal only itself) for URLs read back from storage. `@bot-wa/graph-core` adds `META_MEDIA_HOSTS` (the Messenger/Instagram attachment CDNs), `serializeUrlMediaRef` and `rehydrateUrlMediaRef`, which the Messenger and Instagram providers use for `serializeMediaRef`/`rehydrateMediaRef`.

### Patch Changes

- c5f5090: `secureFetch` rejects right away (without any request) when the caller's `signal` is already aborted; before, the request went out ignoring it. A followed redirect's body is now released instead of left unread, and the per-hop connections are destroyed at the end: a server answering a redirect with a body that never ends could stall `secureFetch` forever (past `timeoutMs`).
- 9ec06c8: Security: `isPrivateAddress` now parses IPv6 and blocks forms that embed a private IPv4 (IPv4-mapped in hex such as `::ffff:7f00:1`, IPv4-compatible `::127.0.0.1`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo, site-local, `100::/64`). Cross-origin redirects also drop credential-looking headers (`apikey`, `x-api-key`, `xi-api-key`, `x-auth-token`, ...), and a `303` (or a `301`/`302` after a `POST`) continues as a body-less `GET`.
- ce7790f: Packaging: dependencies between `@bot-wa/*` packages are published as caret ranges (`^x.y.z`, from `workspace:^`) instead of exact versions, so npm dedupes a single `@bot-wa/core` instead of installing a second copy when one package lags a patch behind. Published READMEs use absolute GitHub links (relative links broke on npmjs.com), and `@bot-wa/core`/`@bot-wa/http` gain `repository.directory`, `homepage` and `bugs` metadata.
