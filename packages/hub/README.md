# @bot-wa/hub

> **Paquete privado** (`"private": true`, no se publica en npm). Implementación real y persistente; la API puede cambiar sin aviso mientras la alpha no salga.

Registro de plugins por tenant. Valida manifiestos, compatibilidad con el runtime y permisos explícitos antes de habilitar un plugin.

```ts
import { KvPluginStore, PluginRegistry } from '@bot-wa/hub'
import { RedisDurableKv } from '@bot-wa/redis-store'

const registry = new PluginRegistry(new KvPluginStore(new RedisDurableKv({ client })))
await registry.install('acme', manifest, '2.0.0')
await registry.enable('acme', manifest.id, manifest.permissions)
```

`validateManifest()` comprueba:

- `version`: semver completo (`MAJOR.MINOR.PATCH[-pre][+build]`).
- `botwa`: rango semver que debe satisfacer la versión del runtime. Soporta versión exacta, `=`, `>`, `>=`, `<`, `<=`, `^`, `~`, x-ranges (`2`, `2.x`, `2.1.*`, `*`), intersecciones separadas por espacios y uniones con `||`. No soporta rangos con guion (`1.0.0 - 2.0.0`) ni el prefijo `v`. Los prereleases se ordenan por precedencia: `^2.0.0` no acepta `2.0.0-alpha.1` (usa `^2.0.0-alpha.1` o `>=2.0.0-0`) ni `3.0.0-alpha.1`.
- `entry`: ruta relativa POSIX dentro del paquete. Se rechazan rutas absolutas, letras de unidad (`C:/x.js`), rutas UNC y barras invertidas, URLs (`file:///x.js`), segmentos `..` o vacíos y caracteres de control; nombres como `a..b.js` son válidos.

El registro no ejecuta código ni descarga paquetes; la firma, sandbox y marketplace remoto son responsabilidades de la siguiente capa de infraestructura.

## Almacenamiento

- `MemoryPluginStore` — implementación de referencia, en RAM. Se pierde al reiniciar; úsala en tests.
- `KvPluginStore` — persiste sobre cualquier [`DurableKv`](../core/src/durability/kv.ts) del core (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). La tabla lleva el tenant (`@bot-wa/tenant-kv`) y la habilitación es un compare-and-set, de modo que dos procesos no se pisan.

Ambas pasan la misma suite de conformidad (`test-utils/plugin-store-conformance.ts`). Las suites contra servidores reales (`tests/integration.test.ts`) se activan con `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` y `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite siempre corre con un archivo temporal.

```ts
const sqlite = new SQLiteStore({ file: 'hub.db' })
const registry = new PluginRegistry(new KvPluginStore(sqlite.durability().kv))
```
