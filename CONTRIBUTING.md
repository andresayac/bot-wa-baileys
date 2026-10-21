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

`redis-store` también trae suites contra un **Redis Cluster** real (`tests/cluster.integration.test.ts` y `tests/cluster-migrate.integration.test.ts`; la segunda usa además `BOTWA_TEST_REDIS_URL`). Los puertos 47100-47105 quedan lejos de los anteriores; el bus del cluster (57100-57105) no sale del contenedor:

```bash
docker run -d --name botwa-it-redis-cluster -e IP=0.0.0.0 -e INITIAL_PORT=47100 -e MASTERS=3 -e SLAVES_PER_MASTER=1 -p 127.0.0.1:47100-47105:47100-47105 grokzen/redis-cluster:7.0.10
export BOTWA_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:47100
export BOTWA_TEST_REDIS_CLUSTER_CHAOS=1   # opcional: failover y migración de un slot bajo carga
pnpm --filter @bot-wa/redis-store test
docker rm -f botwa-it-redis-cluster
```

En PowerShell, las variables se definen con `$env:BOTWA_TEST_POSTGRES_URL = 'postgres://postgres:postgres@127.0.0.1:55432/botwa'` (y así con las demás). Puedes definir solo las que te interesen: el resto de suites se salta.

### Email (`@bot-wa/email`) contra GreenMail

`packages/email-provider/tests/integration.test.ts` prueba el provider de email con `imapflow` y `nodemailer` reales contra [GreenMail](https://greenmail-mail-test.github.io/greenmail/) (IMAP IDLE, SMTP, hilos, adjuntos, protección contra bucles, reinicios y un flujo del `Bot`). Se activa con `BOTWA_TEST_EMAIL`:

```bash
docker run -d --name botwa-it-greenmail \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  -p 127.0.0.1:3025:3025 -p 127.0.0.1:3143:3143 greenmail/standalone:2.1.3

BOTWA_TEST_EMAIL=1 pnpm --filter @bot-wa/email test

docker rm -f botwa-it-greenmail
```

Host y puertos: `BOTWA_TEST_EMAIL_HOST`, `BOTWA_TEST_EMAIL_SMTP_PORT` y `BOTWA_TEST_EMAIL_IMAP_PORT` (por defecto `127.0.0.1`, `3025` y `3143`). Más detalles en el [README del paquete](packages/email-provider/README.md#tests-de-integración). Si tocas `email-provider`, córrelo en local: CI no lo ejecuta.

## Carga, soak y fugas (`pnpm bench:soak`)

`scripts/soak/soak.mjs` mete carga en el runtime de `@bot-wa/core` (y en `@bot-wa/ai` con `MockAIProvider`) sobre `MockProvider`: miles de chats y participantes de grupo con flows (`ask`/validación/reintentos/timeouts/`delay`), conversaciones con `c.idle`, `bot.onIdle`, dedupe de entrada, handoff, idioma "pegajoso", `ctx.user`, broadcast, métricas, pacer de typing, streaming y confirmaciones de herramientas de IA (botones, respuestas escritas, timeouts, `/reset`, pulsaciones viejas). Tras cada ronda espera a que los bots queden ociosos, fuerza GC y mide heap, handles activos (`process.getActiveResourcesInfo()`), tamaño de los mapas internos, lag del event loop y throughput. Al final hace `stop({ drain: true })` **bajo carga** y falla (código 2) si queda algún temporizador vivo. No forma parte de `pnpm test`.

```bash
pnpm build                                        # usa lib/ compilado
pnpm bench:soak                                   # unos segundos
pnpm bench:soak -- --chats 2000 --rounds 20       # más carga
pnpm bench:soak -- --duration 600                 # soak de 10 minutos
pnpm bench:soak -- --fresh 0                      # solo chats repetidos: el heap debe quedar plano
pnpm bench:soak -- --json > soak.json             # informe en JSON
pnpm bench:soak -- --rounds 1 --trace-timers      # de dónde salen los temporizadores que quedan tras stop()
```

Opciones: `--chats`, `--groups`, `--participants`, `--ai-chats`, `--fresh` (chats nuevos por ronda; hacen crecer el `MemoryStore` a propósito y el informe mide el heap tras borrarlos), `--rounds`, `--duration` (segundos), `--json`, `--trace-timers`. Cada fuga que se arregle lleva además un test rápido en la suite normal (`packages/core/tests/soak-regressions.test.ts`, `packages/ai/tests/soak-regressions.test.ts`).

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
pnpm run docs                               # opcional: verifica que el sitio compila sin links muertos (usa `pnpm run`: `pnpm docs` es un builtin de pnpm)
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) corre `build` y `test` en Node 22 y 24 en cada push a `main` y en cada PR contra `main` (en Node 24 también `pnpm run docs`). `pnpm typecheck` y los tests de integración de stores **no** corren en CI: ejecútalos en local antes de abrir el PR (los de stores, si tocas un store).

## Publicar una versión

Las versiones se gestionan con [Changesets](https://changesets.dev) (CLI v3) y se publican **a mano** desde la máquina del mantenedor. No hay workflow de release.

**Paquetes públicos** (se publican en npm): `@bot-wa/core`, `@bot-wa/baileys`, `@bot-wa/meta`, `@bot-wa/telegram`, `@bot-wa/sqlite-store`, `@bot-wa/redis-store`, `@bot-wa/ai`, `@bot-wa/http`, `@bot-wa/graph-core` y `create-bot-wa`.

**Paquetes privados** (`"private": true`, nunca se publican): todo lo demás — los canales experimentales (`discord`, `messenger`, `instagram`, `evolution`, `wppconnect`, `twilio`, `gohighlevel`, `gupshup`, `email`, `tiktok`), los stores `mongo`/`postgres`/`mysql`, la infraestructura (`server`, `wa-gateway-kit`), los plugins e integraciones (`nlu`, `rag`, `voice`, `dialogflow`, `chatwoot`, `tickets`, `moderation`, `manager`, `events`, `otel`), los paquetes de producto (`inbox`, `crm`, `hub`, `campaigns`, `deployments`, `tenant-kv`, `flow-schema`) y el tooling (`eslint-plugin-bot-wa`, `@bot-wa/mcp`). La tabla del [README](README.md#paquetes) es la lista canónica.

### Flujo

1. Cada PR incluye su changeset (`pnpm changeset`).
2. Para publicar, en `main` con el árbol limpio y sesión iniciada en npm (`pnpm login`):

```bash
pnpm version-packages      # changeset version: sube versiones y escribe los CHANGELOG de cada paquete
git commit -am "chore(release): version packages"
pnpm changeset publish-plan   # revisa qué se va a publicar
pnpm pack:smoke            # empaqueta e instala los tarballs en un proyecto limpio (no publica nada)
pnpm test:scripts          # tests de los helpers de scripts/ (semver del smoke test)
pnpm release               # pnpm clean && pnpm build && changeset publish: publica y crea los tags <paquete>@<versión>
git push --follow-tags
```

> **El orden importa.** `pnpm release` a secas publica las versiones **actuales** de los `package.json` y deja los changesets sin aplicar (`changeset publish` no los consume): la primera vez subiría `0.1.0` / `2.0.0-alpha.1` con todo el trabajo pendiente fuera. Siempre `version-packages` → commit → `release`.

### Checklist de release

Se ejecuta completo antes de `changeset publish` (es el checklist que exige el safety gate de [`ROADMAP.md`](ROADMAP.md)); el modelo de amenazas y sus riesgos residuales están en [docs/guide/threat-model.md](docs/guide/threat-model.md).

- [ ] `main` limpio, sin ramas `wave*` ni worktrees, con todo lo que se publica ya commiteado.
- [ ] `pnpm build && pnpm typecheck && pnpm test` en verde (Node 22 y 24; el CI cubre build y test).
- [ ] `pnpm api-check` (0 hallazgos) y `pnpm pack:smoke` (tarballs instalados de verdad y plantillas resueltas).
- [ ] `pnpm version-packages` ejecutado y revisado con `pnpm changeset status --verbose` y `pnpm changeset publish-plan`; commit `chore(release): version packages`.
- [ ] `pnpm run docs:site && pnpm docs:check` sin errores ni avisos, y `docs/public/llms.txt` al día.
- [ ] Ningún secreto, credencial de sesión ni `.env` en el árbol ni en los tarballs (`git status`, `scripts/pack-smoke.mjs`).
- [ ] Threat model y este checklist revisados si el release cambia superficies (canal nuevo, capability nueva, paquete público nuevo).
- [ ] Tras publicar: `npm dist-tag ls` de cada paquete, instalación limpia desde el registro con el tag correcto y un `npm create bot-wa@alpha` de humo en un directorio vacío.

### Smoke test de empaquetado

`pnpm pack:smoke` (`scripts/pack-smoke.mjs`) simula instalar desde npm **sin publicar**: compila, ejecuta `pnpm pack` en cada paquete público hacia un directorio temporal fuera del repo, revisa cada tarball (archivos de `main`/`types`/`exports`/`bin`, README y LICENSE; nada de `src`, tests, source maps, configs ni credenciales; salida de `lib/` sin fuente; `engines`; dependencias privadas o con `workspace:`; tamaños) y luego, en un proyecto npm limpio, instala los tarballs y comprueba que cada subpath de `exports` se importa, que un consumidor TypeScript compila con `moduleResolution` `nodenext` y `bundler`, que los SDKs opcionales de IA ausentes solo fallan al usarse, que los bins `bot-wa` y `create-bot-wa` funcionan que ningún README publicado tiene enlaces relativos (se rompen en npmjs.com) y que cada plantilla de `create-bot-wa` resuelve sus versiones contra los tarballs y se instala **sin tocar sus rangos `@bot-wa/*`** (un registro npm local y temporal, `scripts/smoke/registry.mjs`, sirve los tarballs al scope `@bot-wa`, así que es npm quien resuelve los rangos, prereleases incluidas) y arranca en `bot-wa dev`. Necesita red para las dependencias de terceros y tarda unos minutos. Opciones: `--no-build`, `--no-scaffold-install` (más rápido), `--keep` (conserva el directorio temporal). Es un script local: no hay workflow de CI para él.

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

Quita `"private": true` de su `package.json`, comprueba que tiene `publishConfig.access: "public"`, `repository.directory` y `files`, y añade un changeset. Ningún paquete público puede depender de uno privado (Changesets lo rechaza). Las versiones que estampa `create-bot-wa` se regeneran solas desde los `package.json` (`create-bot-wa/src/versions.ts`, en `pnpm build` y `pnpm version-packages`).

## Documentación

- Sitio VitePress en `docs/` (`pnpm docs:dev` para previsualizar en `http://localhost:5173/`). No se publica en ningún hosting: la documentación se lee en el propio repo. Antes de dar por buenos cambios en `docs/`, ejecuta `pnpm run docs:site && pnpm docs:check` (enlaces y anclas rotos, diagramas Mermaid sin renderizar, títulos repetidos).
- Referencia de API generada con TypeDoc (`pnpm docs:api`) — nota: TypeDoc corre contra TypeScript 5.9 en la raíz (TypeDoc 0.28 aún no soporta TS 7, que es el compilador de los paquetes).
- Diseños y decisiones históricas: `docs/superpowers/specs/` y `docs/superpowers/plans/`.
