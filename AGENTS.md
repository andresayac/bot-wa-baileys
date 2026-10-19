# AGENTS.md

Guía para agentes de código (y humanos) que trabajan en este repositorio. Complementa a [`CONTRIBUTING.md`](CONTRIBUTING.md); si algo choca, manda el código y los tests.

## Qué es

Framework de bots de mensajería **agnóstico de transporte**, en un **monorepo pnpm** (`packages/*`). El motor es `@bot-wa/core`; los canales (WhatsApp vía Baileys, Cloud API, Evolution API, WPPConnect, Twilio o Gupshup; Messenger, Instagram, Telegram, Discord, GoHighLevel, email y TikTok) son paquetes que implementan `IProvider`. Hay **39 paquetes**. Todo es **ESM-only**, **Node >= 22** y está en alpha; todavía no hay nada en npm (la publicación va por Changesets, ver [Publicar una versión](#publicar-una-versión)).

Capas (las dependencias van siempre hacia abajo, nunca al revés):

| Capa | Paquetes |
| --- | --- |
| Motor | `core` (`@bot-wa/core`, la única dependencia runtime es `pino`) |
| Infra compartida | `http` (cliente anti-SSRF), `graph-core` (helpers de Meta Graph), `server` (ingress de webhooks: body crudo, límites, health) |
| Canales (13) | `baileys-provider`, `meta-provider`, `messenger-provider`, `instagram-provider`, `telegram-provider`, `discord-provider`, `evolution-provider`, `wppconnect-provider`, `twilio-provider`, `gohighlevel-provider`, `gupshup-provider`, `email-provider`, `tiktok-provider` |
| Stores | `sqlite-store`, `redis-store`, `mongo-store`, `postgres-store`, `mysql-store` |
| Plugins | `ai`, `rag`, `voice`, `nlu`, `dialogflow`, `chatwoot`, `tickets`, `moderation`, `manager`, `events` |
| Prototipos de producto | `inbox`, `crm`, `hub`, `campaigns`, `deployments` |
| Tooling | `create-bot-wa` (CLI scaffolder), `eslint-plugin` (`eslint-plugin-bot-wa`) |

El nombre del directorio no siempre coincide con el del paquete (`packages/baileys-provider` → `@bot-wa/baileys`, `packages/meta-provider` → `@bot-wa/meta`, `packages/*-provider` → `@bot-wa/<canal>`, `packages/eslint-plugin` → `eslint-plugin-bot-wa`). Mira el `name` en su `package.json` antes de usar `--filter`.

Solo 10 paquetes son **públicos**: `core`, `baileys`, `meta`, `telegram`, `sqlite-store`, `redis-store`, `ai`, `http`, `graph-core` y `create-bot-wa`. Los otros 29 llevan `"private": true` y nunca se publican:

- Canales: `discord`, `messenger`, `instagram`, `evolution`, `wppconnect`, `twilio`, `gohighlevel`, `gupshup`, `email`, `tiktok`.
- Stores: `mongo-store`, `postgres-store`, `mysql-store`.
- Plugins e infra: `server`, `rag`, `voice`, `nlu`, `dialogflow`, `chatwoot`, `tickets`, `moderation`, `manager`, `events`.
- Tooling: `eslint-plugin-bot-wa`.
- Prototipos: `inbox`, `crm`, `hub`, `campaigns`, `deployments`.
 Un paquete público no puede depender de uno privado, y sus dependencias internas se declaran como `"workspace:^"` (al empaquetar salen como `^x.y.z`, así npm deduplica `@bot-wa/core`).

## Comandos

```bash
pnpm install                              # workspace completo (usa pnpm, nunca npm/yarn)
pnpm build                                # pnpm -r build, en orden topológico
pnpm typecheck                            # pnpm -r typecheck (tsc -p tsconfig.test.json: src + tests)
pnpm test                                 # pnpm -r test (vitest run en cada paquete)

pnpm --filter @bot-wa/core test           # un paquete
pnpm --filter "@bot-wa/meta..." build     # un paquete + sus dependencias del workspace
pnpm --filter @bot-wa/core exec vitest run tests/dispatcher.test.ts   # un solo archivo
pnpm --filter "./packages/*-store" test   # los stores (con BOTWA_TEST_*_URL, también contra servidores reales)

pnpm bench:soak                           # carga/soak/fugas del runtime (tras pnpm build; no entra en pnpm test, ver CONTRIBUTING)
pnpm changeset                            # añade un changeset (todo cambio visible de un paquete público)
pnpm pack:smoke                           # empaqueta los paquetes públicos y los prueba instalados desde tarballs (no publica)
pnpm test:scripts                         # tests de los helpers de scripts/ (semver del smoke test)

pnpm docs:dev                             # sitio VitePress en local (http://localhost:5173/)
pnpm docs                                 # TypeDoc + VitePress (CI lo compila en Node 24; no se publica en ningún hosting)
```

**Importante:** los paquetes se resuelven entre sí por `exports` → `lib/` (salida compilada). Si cambias `core` (u otra dependencia interna) y luego pruebas un paquete que la usa, **compila primero la dependencia**; si no, los tests corren contra el `lib/` anterior.

Antes de dar un cambio por terminado: `pnpm build && pnpm typecheck && pnpm test` en verde. En Windows, si la terminal abre el repo con la unidad en minúscula (`c:\...`, habitual en VS Code), `pnpm -r <script>` lanzado a mano no reconoce el directorio, incluye el paquete raíz y todo se ejecuta dos veces; trabaja desde la ruta con la unidad en mayúscula (`C:\...`). Los scripts raíz (`pnpm build`, `pnpm test`, `pnpm typecheck`) no tienen ese problema.

CI (`.github/workflows/ci.yml`) corre `build` y `test` en Node 22 y 24 (más `pnpm run docs` en Node 24) en cada push a `main` y en cada PR contra `main`. `pnpm typecheck` y los tests de integración de stores **no** corren en CI: ejecútalos en local. **No añadas workflows nuevos de GitHub Actions ni GitHub Pages**: el mantenedor no los quiere; pregunta antes de tocar `.github/`.

## Toolchain

- **pnpm** (versión fijada en `packageManager`). `pnpm-lock.yaml` es la fuente de verdad. No generes `package-lock.json`; está en `.gitignore`.
- **TypeScript 7** (`tsc` nativo) compila cada paquete. La raíz tiene TS 5.9 **solo** para TypeDoc; no lo uses para compilar paquetes.
- **Vitest 4**. Los tests viven en `packages/<pkg>/tests/**/*.test.ts` y el timeout por defecto es de 10 s.
- Cada `tsconfig.json` extiende `tsconfig.base.json` (`strict`, `module`/`moduleResolution: nodenext`) y solo incluye `src/`, así que tests y `test-utils/` no entran en el build.
- `lib/` es salida generada y está ignorada en git. No la edites.
- **Changesets v3** (`@changesets/cli` en la raíz) para versionar y publicar. En CI va con `changesets/action@v2`; la v1 de la action solo sirve con la CLI v2.

## Estructura de un paquete

```
packages/<pkg>/
  package.json       # "type": "module", exports → ./lib, engines node >=22, scripts build=tsc / test=vitest run / typecheck=tsc -p tsconfig.test.json
  tsconfig.json      # extends ../../tsconfig.base.json, rootDir src, outDir lib
  tsconfig.test.json # noEmit sobre src + tests (lo usa pnpm typecheck)
  src/index.ts       # API pública: todo lo exportado aquí es contrato
  tests/*.test.ts
```

Las dependencias internas se declaran como `"workspace:*"`. Un paquete nuevo copia la forma de uno existente parecido (p. ej. `nlu` para un plugin, `telegram-provider` para un canal) y se añade a la tabla del [`README.md`](README.md#paquetes).

## Reglas de código

- **ESM estricto:** los imports relativos llevan extensión `.js` (`import { x } from './foo.js'`). Nunca `require()`; si necesitas carga dinámica, usa `await import()`.
- **Sin `console.*` en `src/`.** Usa el `logger` inyectado (compatible con pino). Excepciones que ya existen: el render del QR en terminal (escribe en `process.stdout`), `create-bot-wa/src/cli.js` y el aviso de API sin autenticar en `manager/src/http.ts`.
- **Sin `any` en tipos públicos exportados.** Usa `unknown` y estrecha el tipo. En los parámetros de listeners de interfaces, `unknown` en lugar de `never` (que rompe los sitios `implements` con TS2420).
- **Errores de envío tipados:** los providers rechazan con las subclases de `ProviderError` del core (`UnsupportedContentError`, `RateLimitedError`, `RecipientUnreachableError`, `PayloadTooLargeError`, `OutsideSessionWindowError`), no con `Error` genérico.
- **SDKs opcionales con carga lazy:** en `@bot-wa/ai`, los SDKs de proveedor (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) son `peerDependencies` opcionales y se cargan con `loadModule()`. Nunca los importes al top level. Lo mismo vale para `better-sqlite3` en `sqlite-store`, `imapflow`/`nodemailer` en `@bot-wa/email` y `pdf-parse` en `@bot-wa/rag`.
- **Comentarios y código en inglés**; la documentación de usuario (README, guías, CHANGELOG) está en español (más la versión en inglés del sitio).
- **TDD:** escribe primero el test que falla. Todo cambio de comportamiento lleva su test.

## Invariantes de arquitectura (no romper)

Son los errores que más caro han salido. Respétalos aunque un cambio "parezca" más simple sin ellos.

### Core agnóstico de transporte
- `@bot-wa/core` no conoce **ningún** concepto de transporte: nada de JID, LID, PN, `@g.us`, `WAMessageKey`, `proto` ni QR. Todo eso vive en `@bot-wa/baileys`.
- Los IDs (`ChatId`, `UserId`, `MessageId`) son **strings opacos**. El core nunca los parsea ni infiere nada de su forma; `ChatKind`/`isGroup` los rellena el provider.
- **Contrato de estabilidad de identidad:** el provider resuelve los alias (LID/PN en WhatsApp, también en Evolution y WPPConnect vía `WaIdentityStore`; `sender_chat` en Telegram, member/user en Discord) **antes** de emitir el evento. La misma persona produce siempre el mismo `senderId`. El core nunca re-deriva identidad.
- En Baileys, el cambio LID↔PN es la causa número 1 de flujos rotos. Todo keying o enrutado nuevo debe pasar por la identidad canónica (`IdentityStore` en `baileys-provider/src/identity.ts` + `getPNForLID`), nunca por el `remoteJid` crudo.
- El contrato completo está documentado en `packages/core/src/core/provider.ts`. Si cambias `IProvider`, revisa los trece canales y `MockProvider`.

### Dispatcher y conversaciones
- El dispatcher procesa una **cola FIFO por chat**. Un mensaje lo consume el primer handler que lo maneja (`ctx.pass()` para dejarlo pasar al siguiente). Orden completo de entrada (doc comment de `Dispatcher.run`): en el `Bot`, blacklist/whitelist (lo bloqueado no se marca como visto) → dedupe de entrada → persistencia → filtro `groupMode`; en el dispatcher, resolución del idioma (`prepare`, solo con i18n activo) → before-hooks (si un hook reescribió `ctx.body`, p. ej. la transcripción de voz, el idioma se re-resuelve con `reprepare` para que `detect` vea el texto final) → gate de handoff → comando → conversación activa → reanudación dormida → matchers por especificidad (`WELCOME` primero; texto; función; tipo único; multi-tipo) → catch-all → after-hooks + evento `'message'`. Los comandos siempre ganan a una conversación activa (por eso `/reset` funciona como escape). Las llamadas van primero por los gates de acceso y handoff (una llamada bloqueada no corre hooks `'call'`, no emite `'call'` ni llega a `CALL`; cuenta en `metrics().dropped`); una admitida corre hooks `'call'` + evento y, por `dispatchEvent`, resolución del idioma y solo triggers de tipo. `bot.trigger()` (y `bot.triggerFlow()`, un wrapper fino con `ifActive: 'replace'`) tampoco pasa por `run`: listas de acceso → turno FIFO del chat (`runExclusive`) → gate de handoff → resolución del idioma → inicio de la conversación.
- Un chat en handoff sigue persistiendo, corriendo hooks y emitiendo `'message'`, pero no enruta nada (salvo `handoff.allowCommands`). Un mensaje bloqueado por las listas de acceso se descarta antes de persistir. Si cambias el orden, actualiza ese doc comment, `docs/guide/concepts.md` y `docs/es/guide/conceptos.md`.
- **Un handler que inicia una conversación debe lanzarla sin esperarla:** `void runtime.enter(...).catch(...)`. `enter()` resuelve cuando la conversación **termina**, así que hacerle `await` bloquea la cola del chat.
- Las entradas del `ConversationRuntime` van ligadas a su identidad (`ConversationHandle`). No vuelvas a buscarlas por string de clave en cleanup/wait: así se arregló un bug de conversaciones zombi al re-entrar.
- En grupos, las conversaciones son **por participante** por defecto (`conversationScope: 'participant'`).
- El trigger de texto por defecto compara por **igualdad normalizada**, no por "contiene".
- DSL de flows: `flow()` (alias `addKeyword`) con `.say/.ask/.do/.choose/.media/.timeout/.persistent`, que compila al runtime async. La API v1 (`.addAnswer`, `.addAction`, `.end()`, `{ capture: true }`) **no existe**; no la generes.
- Los flows `.persistent()` solo sobreviven a un reinicio si hay un store persistente; `MemoryStore` vive en RAM.

### Plugins
- `Plugin.install()` debe ser **síncrono**. `Bot.plug()` no hace `await` de `install()`, así que un `install` async que rechace se convierte en un unhandled rejection que tumba el proceso. Si necesitas inicialización async, usa el patrón de `LazyProvider` en `@bot-wa/ai`: se resuelve en el primer uso y un `warmup()` no fatal reporta errores de configuración al arrancar.
- `aiPlugin` es un catch-all: se instala **después** de `slashCommandsPlugin`.

### Stores
- `MemoryStore` es la **referencia del contrato** de `IStore`. Todos los stores pasan la misma suite compartida, `test-utils/store-conformance.ts` (`runStoreConformance`). Un store nuevo debe incluir su `tests/conformance.test.ts` y, si cambias la semántica del contrato, actualiza la suite y los seis stores a la vez. Los métodos opcionales de datos de usuario (`ctx.user`) tienen su propia suite compartida, `test-utils/user-data-conformance.ts` (`runUserDataConformance`).
- Semántica uniforme: `deleteChat` borra también el log de mensajes del chat; `upsertChat`/`upsertContact` hacen merge superficial sobre lo existente; `maxMessagesPerChat` es opt-in (por defecto, sin límite).
- Los tests unitarios de stores no necesitan servidores reales: usan fakes en memoria (p. ej. `FakePool` en postgres) o, en sqlite, un archivo temporal que se borra al final.
- Los `tests/integration.test.ts` de `postgres-store`, `mysql-store`, `mongo-store` y `redis-store` corren contra un servidor real y leen `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_MYSQL_URL`, `BOTWA_TEST_MONGO_URL` y `BOTWA_TEST_REDIS_URL`; sin la variable, la suite se salta (`describe.skipIf`). En local, levanta los servidores con Docker (comandos en [`CONTRIBUTING.md`](CONTRIBUTING.md#tests-de-integración-de-stores-docker)); CI no los ejecuta, así que córrelos en local si tocas un store.

### Canales y red
- Meta (WhatsApp Cloud, Messenger, Instagram) comparte `@bot-wa/graph-core` para verificar webhooks, mapear errores y proteger el ingest. No dupliques esa lógica en el provider.
- La firma de un webhook se calcula sobre los **bytes crudos** del body, nunca sobre JSON re-serializado.
- Las descargas de media y las peticiones salientes a URLs externas pasan por `secureFetch` de `@bot-wa/http` (anti-SSRF, validación de redirecciones, timeouts y límites de tamaño).
- Baileys no tiene botones ni listas nativos (el protocolo de WhatsApp Web los dejó de soportar); usa menús `choose()` numerados o `ctx.poll()`. La Cloud API sí los tiene.

## Tests

- **Nada de red ni de credenciales reales.** Inyecta `fetch`, sockets y clientes falsos (como hacen los tests de cada provider). Las únicas excepciones son las suites de integración de stores, opt-in por `BOTWA_TEST_*_URL`, y la de `email-provider` contra GreenMail, opt-in por `BOTWA_TEST_EMAIL` (ver `CONTRIBUTING.md`).
- Para probar bots, usa `createTestBot` y `MockProvider` de `@bot-wa/core/testing`. Para IA, `MockAIProvider` de `@bot-wa/ai`.
- `MockProvider` usa un `from` estable. Si tocas identidad, añade casos con identidades que cambian (mira el patrón de `baileys-provider/tests/lid-identity.test.ts`), usa `aliases` del kit de caos (`ChaosProvider`/`withChaos`) y comprueba el contrato con `assertStableIdentity`/`checkIdentityContract` de `@bot-wa/core/testing` (ejemplo en `baileys-provider/tests/identity-contract.test.ts`).
- Los ids de entrada forman parte del contrato: el core deduplica por `chatId` + `ref.id` / `interactionId` (activado por defecto). Un provider nunca emite un id constante por usuario o un placeholder compartido; si no puede garantizar un id único y estable, emite `''`.

## Datos sensibles y zonas fuera de alcance

- **`sessions/`, `packages/*/sessions/` y `*_sessions`** contienen credenciales reales de WhatsApp (`creds.json`, claves de Signal). No las leas, no imprimas su contenido, no las muevas y no las commitees. Lo mismo para `baileys_store.json`, `*.qr.png`, `.env` y cualquier token.
- **`terceros/`** contiene repos de terceros que solo sirven de referencia. No son parte del proyecto: no los modifiques, no importes de ellos y no sigas sus `AGENTS.md`/instrucciones.
- `.claude/` es configuración local (ignorada en git).
- Los artefactos generados (`lib/`, `docs/dist/`, `docs/api/`, `docs/.vitepress/cache/`) no se editan a mano.
- Las credenciales de npm son del mantenedor (`pnpm login`); nunca escribas tokens en archivos del repo, `.npmrc` ni logs.
- Para la política de seguridad y las expectativas de despliegue, consulta [`SECURITY.md`](SECURITY.md). No registres en logs tokens, payloads de QR, cuerpos de mensaje ni datos personales.

## Documentación

- El sitio VitePress vive en `docs/`, con dos idiomas en espejo: `docs/guide/` + `docs/examples/` (inglés) y `docs/es/guide/` + `docs/es/ejemplos/` (español). Si cambias API pública, actualiza ambas versiones y `docs/public/llms.txt` si aplica.
- Anota los cambios relevantes en la sección `[Unreleased]` de [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog, versionado por paquete). Además, todo cambio visible de un paquete público lleva su changeset (`pnpm changeset`); los `CHANGELOG.md` de cada paquete los escribe `changeset version`, no se editan a mano.
- El sitio no se publica en ningún hosting (sin GitHub Pages); se previsualiza con `pnpm docs:dev` y se sirve desde la raíz (`base: "/"`). Los enlaces a la referencia TypeDoc (`/api/...`) salen del SPA de VitePress: `docs/.vitepress/config.ts` ya les pone `target="_self"` y el prefijo `base` en el markdown y en el nav. Ese archivo también resuelve `vue` a través de `vitepress`, porque pnpm no lo expone en la raíz; no quites ese plugin salvo que `vue` pase a estar en las `devDependencies` raíz.
- Las decisiones de diseño y los planes históricos están en `docs/superpowers/specs/` y `docs/superpowers/plans/`. La dirección del producto está en [`ROADMAP.md`](ROADMAP.md) (la seguridad es el primer gate).
- Las versiones `@bot-wa/*` que `create-bot-wa` estampa en los proyectos generados salen de `create-bot-wa/src/versions.ts`, que **se genera** (`packages/create-bot-wa/scripts/gen-versions.mjs`) desde el `package.json` de cada paquete público como `^<versión exacta>` (con prerelease, p. ej. `^2.0.0-alpha.2`, para que npm la resuelva). Lo regeneran `pnpm build` y `pnpm version-packages`; un test falla si queda desfasado. No lo edites a mano.

## Publicar una versión

- Versionado y publicación con [Changesets](https://changesets.dev) (CLI v3, `.changeset/config.json`: `access: public`, `baseBranch: main`, los paquetes privados no se versionan ni se publican).
- Flujo **manual** (sin workflow de release): cada PR trae su changeset; para publicar, el mantenedor ejecuta en `main` `pnpm version-packages` → commit → `pnpm release` (`pnpm build && changeset publish`, crea los tags) → `git push --follow-tags`.
- El repo está en **modo prerelease `alpha`** (`.changeset/pre.json`): `changeset version` genera `core@2.0.0-alpha.N` y, en el resto, `x.y.z-alpha.N`, y `changeset publish` publica con el dist-tag `alpha`. Se sale con `pnpm changeset pre exit` (decisión del mantenedor; no lo hagas por tu cuenta). Antes de publicar, revisa `pnpm changeset status --verbose` y `pnpm changeset publish-plan`, y pasa `pnpm pack:smoke`.
- **No** ejecutes `changeset version`, `changeset publish` ni `pnpm release` salvo que te lo pidan: publicar en npm no tiene vuelta atrás.
- Detalles (prereleases, scope de npm, promover un paquete privado) en [`CONTRIBUTING.md`](CONTRIBUTING.md#publicar-una-versión) y [`.changeset/README.md`](.changeset/README.md).

## Commits y PRs

- [Conventional Commits](https://www.conventionalcommits.org/) con scope de paquete o área: `feat(core): ...`, `fix(stores): ...`, `feat(channels): ...`, `docs: ...`. Asunto en imperativo, ≤ 72 caracteres.
- Los PRs van contra `main`, con `build`, `typecheck` y `test` en verde en Node 22 y 24, más `pnpm typecheck` y, si tocas stores, sus tests de integración en local. Si cambian algo visible de un paquete público, incluyen su changeset.
- No hagas commit ni push salvo que te lo pidan.
