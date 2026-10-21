---
"@bot-wa/http": patch
---

Security: `isPrivateAddress` now parses IPv6 and blocks forms that embed a private IPv4 (IPv4-mapped in hex such as `::ffff:7f00:1`, IPv4-compatible `::127.0.0.1`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo, site-local, `100::/64`). Cross-origin redirects also drop credential-looking headers (`apikey`, `x-api-key`, `xi-api-key`, `x-auth-token`, ...), and a `303` (or a `301`/`302` after a `POST`) continues as a body-less `GET`.
