# @botmesh/hub

> **Private package** (`"private": true`, not published to npm). Real, persistent implementation; the API may change without notice while the alpha is out.

Per-tenant plugin registry. It validates manifests, runtime compatibility and explicit permissions before enabling a plugin.

```ts
import { KvPluginStore, PluginRegistry } from '@botmesh/hub'
import { RedisDurableKv } from '@botmesh/redis-store'

const registry = new PluginRegistry(new KvPluginStore(new RedisDurableKv({ client })))
await registry.install('acme', manifest, '2.0.0')
await registry.enable('acme', manifest.id, manifest.permissions)
```

`validateManifest()` checks:

- `version`: full semver (`MAJOR.MINOR.PATCH[-pre][+build]`).
- `botwa`: semver range the runtime version must satisfy. Supports exact versions, `=`, `>`, `>=`, `<`, `<=`, `^`, `~`, x-ranges (`2`, `2.x`, `2.1.*`, `*`), space-separated intersections and `||` unions. It does not support hyphen ranges (`1.0.0 - 2.0.0`) or the `v` prefix. Prereleases are ordered by precedence: `^2.0.0` accepts neither `2.0.0-alpha.1` (use `^2.0.0-alpha.1` or `>=2.0.0-0`) nor `3.0.0-alpha.1`.
- `entry`: POSIX-relative path inside the package. Absolute paths, drive letters (`C:/x.js`), UNC paths and backslashes, URLs (`file:///x.js`), `..` or empty segments and control characters are rejected; names such as `a..b.js` are valid.

The registry neither executes code nor downloads packages; signing, sandboxing and the remote marketplace are the responsibility of the next infrastructure layer.

## Storage

- `MemoryPluginStore` — reference implementation, in RAM. Lost on restart; use it in tests.
- `KvPluginStore` — persists over any core [`DurableKv`](../core/src/durability/kv.ts) (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). The table carries the tenant (`@botmesh/tenant-kv`) and enabling is a compare-and-set, so two processes never overwrite each other.

Both pass the same conformance suite (`test-utils/plugin-store-conformance.ts`). The suites against real servers (`tests/integration.test.ts`) are enabled with `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` and `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite always runs on a temporary file.

```ts
const sqlite = new SQLiteStore({ file: 'hub.db' })
const registry = new PluginRegistry(new KvPluginStore(sqlite.durability().kv))
```
