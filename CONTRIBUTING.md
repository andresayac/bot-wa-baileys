# Contributing

Gracias por querer contribuir a `bot-wa-baileys`. Este repo es un **monorepo pnpm** transporte-agnóstico: el motor es `@bot-wa/core` (`packages/core`), rodeado de transportes (baileys/meta/messenger/instagram/telegram/discord), stores (sqlite/redis/mongo/postgres/mysql), helpers compartidos (`@bot-wa/graph-core`, `@bot-wa/http`) y tooling (`@bot-wa/ai`, `@bot-wa/nlu`, `@bot-wa/manager`, `create-bot-wa`). Ver la tabla completa en el [README](README.md#paquetes). Si eres un agente de código, lee también [`AGENTS.md`](AGENTS.md).

## Requisitos

- **Node >= 22** (recomendado 24 LTS).
- **pnpm** (ver la versión en `packageManager` de `package.json`; instala con `corepack enable`).
- **Docker**, solo si vas a correr los tests de integración de los stores.

## Puesta en marcha

```bash
pnpm install          # instala todo el workspace
pnpm build            # compila todos los paquetes (pnpm -r build, en orden topológico)
pnpm typecheck        # tsc -p tsconfig.test.json en cada paquete (src + tests)
pnpm test             # suite completa (pnpm -r test, vitest run en cada paquete)
```

Trabajar en un solo paquete (el `--filter` usa el `name` del `package.json`, que no siempre coincide con el directorio):

```bash
pnpm --filter @bot-wa/ai test
pnpm --filter @bot-wa/core build
pnpm --filter "@bot-wa/meta..." build     # el paquete + sus dependencias del workspace
```

Los paquetes se resuelven entre sí por `exports` → `lib/` (salida compilada): si cambias `core` y pruebas un paquete que lo usa, compila `core` primero.

**Windows:** abre la terminal en la ruta con la unidad en **mayúscula** (`C:\laragon\www\bot-wa-baileys`). Si la unidad llega en minúscula (`c:\...`, habitual en la terminal de VS Code), un `pnpm -r <script>` lanzado a mano no reconoce el directorio, incluye el paquete raíz y todo se ejecuta dos veces. Los scripts raíz (`pnpm build`, `pnpm test`, `pnpm typecheck`) no tienen ese problema.

## Tests de integración de stores (Docker)

Los tests unitarios de los stores son herméticos (fakes en memoria o un archivo SQLite temporal). Además, `mongo-store`, `mysql-store`, `postgres-store` y `redis-store` traen un `tests/integration.test.ts` que corre contra un servidor **real**. Cada suite lee su variable `BOTWA_TEST_*_URL` y **se salta sola si no está definida**, así que `pnpm test` nunca necesita red.

```bash
# servidores desechables (puertos altos para no chocar con un MySQL/Redis local, p. ej. Laragon)
docker run -d --name botwa-it-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=botwa -p 55432:5432 postgres:16
docker run -d --name botwa-it-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=botwa -p 53306:3306 mysql:8.4
docker run -d --name botwa-it-mongo -p 57017:27017 mongo:7
docker run -d --name botwa-it-redis -p 56379:6379 redis:7

export BOTWA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55432/botwa
export BOTWA_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:53306/botwa
export BOTWA_TEST_MONGO_URL=mongodb://127.0.0.1:57017
export BOTWA_TEST_REDIS_URL=redis://127.0.0.1:56379

pnpm --filter "./packages/*-store" test   # MySQL tarda unos segundos en aceptar conexiones

docker rm -f botwa-it-postgres botwa-it-mysql botwa-it-mongo botwa-it-redis
```

En PowerShell, las variables se definen con `$env:BOTWA_TEST_POSTGRES_URL = 'postgres://postgres:postgres@127.0.0.1:55432/botwa'` (y así con las demás). Puedes definir solo las que te interesen: el resto de suites se salta.

## Reglas del código

- **ESM-only**: `"type": "module"`, imports relativos con extensión `.js` (NodeNext). Node >= 22.
- **Sin `console.*`** en `src/` — usa el `logger` inyectado. La salida del QR por terminal es la única excepción.
- **Sin `any`** en tipos exportados públicos.
- **TDD**: escribe el test que falla primero, luego la implementación mínima. Cada cambio de comportamiento necesita su test.
- El paquete de IA carga los SDKs de proveedor de forma lazy; nunca los importes al top-level.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(...)`, `docs(...)`, `refactor(...)`, `test(...)`, `build(...)`, `chore(...)`. Sujeto en imperativo, ≤ 72 chars.

## Changesets

Todo cambio **visible para el usuario** de un paquete publicable (feature, fix, cambio de API o de comportamiento) lleva un *changeset* en el mismo PR:

```bash
pnpm changeset        # elige paquetes, tipo de bump (patch/minor/major) y escribe la nota
```

Se genera un `.changeset/<nombre>.md` que se commitea con el PR. No hace falta para tests, CI, docs del sitio, refactors internos sin efecto observable ni paquetes privados (`pnpm changeset --empty` si quieres dejarlo explícito). Detalles en [`.changeset/README.md`](.changeset/README.md).

## Antes de abrir un PR

```bash
pnpm build && pnpm typecheck && pnpm test   # todo verde
pnpm changeset                              # si cambia algo publicable
pnpm docs                                   # opcional: verifica que el sitio compila sin links muertos
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) corre `build` y `test` en Node 22 y 24 en cada push a `main` y en cada PR contra `main` (en Node 24 también `pnpm run docs`). `pnpm typecheck` y los tests de integración de stores **no** corren en CI: ejecútalos en local antes de abrir el PR (los de stores, si tocas un store).

## Publicar una versión

Las versiones se gestionan con [Changesets](https://changesets.dev) (CLI v3) y se publican **a mano** desde la máquina del mantenedor. No hay workflow de release.

**Paquetes públicos** (se publican en npm): `@bot-wa/core`, `@bot-wa/baileys`, `@bot-wa/meta`, `@bot-wa/telegram`, `@bot-wa/sqlite-store`, `@bot-wa/redis-store`, `@bot-wa/ai`, `@bot-wa/http`, `@bot-wa/graph-core` y `create-bot-wa`.

**Paquetes privados** (`"private": true`, nunca se publican): `@bot-wa/discord`, `@bot-wa/messenger`, `@bot-wa/instagram`, `@bot-wa/mongo-store`, `@bot-wa/postgres-store`, `@bot-wa/mysql-store`, `@bot-wa/nlu`, `@bot-wa/manager`, `@bot-wa/events`, `@bot-wa/inbox`, `@bot-wa/crm`, `@bot-wa/hub`, `@bot-wa/campaigns` y `@bot-wa/deployments`.

### Flujo

1. Cada PR incluye su changeset (`pnpm changeset`).
2. Para publicar, en `main` con el árbol limpio y sesión iniciada en npm (`pnpm login`):

```bash
pnpm version-packages      # changeset version: sube versiones y escribe los CHANGELOG de cada paquete
git commit -am "chore(release): version packages"
pnpm changeset publish-plan   # revisa qué se va a publicar
pnpm pack:smoke            # empaqueta e instala los tarballs en un proyecto limpio (no publica nada)
pnpm release               # pnpm build && changeset publish: publica y crea los tags <paquete>@<versión>
git push --follow-tags
```

### Smoke test de empaquetado

`pnpm pack:smoke` (`scripts/pack-smoke.mjs`) simula instalar desde npm **sin publicar**: compila, ejecuta `pnpm pack` en cada paquete público hacia un directorio temporal fuera del repo, revisa cada tarball (archivos de `main`/`types`/`exports`/`bin`, README y LICENSE; nada de `src`, tests, source maps, configs ni credenciales; salida de `lib/` sin fuente; `engines`; dependencias privadas o con `workspace:`; tamaños) y luego, en un proyecto npm limpio, instala los tarballs y comprueba que cada subpath de `exports` se importa, que un consumidor TypeScript compila con `moduleResolution` `nodenext` y `bundler`, que los SDKs opcionales de IA ausentes solo fallan al usarse, que los bins `bot-wa` y `create-bot-wa` funcionan y que cada plantilla de `create-bot-wa` resuelve sus versiones contra los tarballs, se instala y arranca en `bot-wa dev`. Necesita red para las dependencias de terceros y tarda unos minutos. Opciones: `--no-build`, `--no-scaffold-install` (más rápido), `--keep` (conserva el directorio temporal). Es un script local: no hay workflow de CI para él.

### Modo prerelease `alpha`

El repo está en **modo prerelease `alpha`** de Changesets (`.changeset/pre.json`, creado con `pnpm changeset pre enter alpha`). Mientras siga así:

- `pnpm version-packages` genera versiones de prerelease: `@bot-wa/core` sale como `2.0.0-alpha.N` y el resto como `x.y.z-alpha.N` (p. ej. `0.2.0-alpha.0`). `pnpm changeset status --verbose` muestra las versiones que se generarían.
- `pnpm release` publica con el dist-tag `alpha`, no `latest`: quien instala sin indicar tag no recibe la serie alpha (`npm i @bot-wa/core@alpha` sí).
- `.changeset/pre.json` registra el estado del modo pre; no lo borres ni lo edites a mano.

Para salir del modo prerelease cuando la API se estabilice:

```bash
pnpm changeset pre exit    # la siguiente version-packages genera las versiones estables (sin -alpha.N) y publica bajo latest
```

Antes de la primera publicación, el mantenedor debe crear o reclamar el scope **`@bot-wa`** en npm (una organización con ese nombre) y comprobar que el nombre `create-bot-wa` sigue libre.

### Promover un paquete privado

Quita `"private": true` de su `package.json`, comprueba que tiene `publishConfig.access: "public"`, `repository.directory` y `files`, y añade un changeset. Ningún paquete público puede depender de uno privado (Changesets lo rechaza). Si cambias versiones de paquetes publicables, revisa también las constantes de versión de `create-bot-wa/src/templates.ts`.

## Documentación

- Sitio VitePress en `docs/` (`pnpm docs:dev` para previsualizar en `http://localhost:5173/`). No se publica en ningún hosting: la documentación se lee en el propio repo.
- Referencia de API generada con TypeDoc (`pnpm docs:api`) — nota: TypeDoc corre contra TypeScript 5.9 en la raíz (TypeDoc 0.28 aún no soporta TS 7, que es el compilador de los paquetes).
- Diseños y decisiones históricas: `docs/superpowers/specs/` y `docs/superpowers/plans/`.
