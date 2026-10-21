# Contributing

Thanks for wanting to contribute to `botmesh`. This repo is a transport-agnostic **pnpm monorepo**: the engine is `@botmesh/core` (`packages/core`), surrounded by transports (baileys/meta/messenger/instagram/telegram/discord), stores (sqlite/redis/mongo/postgres/mysql), shared helpers (`@botmesh/graph-core`, `@botmesh/http`) and tooling (`@botmesh/ai`, `@botmesh/nlu`, `@botmesh/manager`, `create-botmesh`). See the full table in the [README](README.md#packages). If you are a coding agent, read [`AGENTS.md`](AGENTS.md) too.

## Requirements

- **Node >= 22** (24 LTS recommended).
- **pnpm** (see the version in `packageManager` in `package.json`; install it with `corepack enable`).
- **Docker**, only if you are going to run the store integration tests.

## Getting started

```bash
pnpm install          # install the whole workspace
pnpm build            # compile every package (pnpm -r build, in topological order)
pnpm typecheck        # tsc -p tsconfig.test.json per package (src + tests)
pnpm test             # full suite (pnpm -r test, vitest run per package)
```

Working on a single package (`--filter` uses the `name` from `package.json`, which does not always match the directory):

```bash
pnpm --filter @botmesh/ai test
pnpm --filter @botmesh/core build
pnpm --filter "@botmesh/meta..." build     # the package plus its workspace dependencies
```

Packages resolve each other through `exports` → `lib/` (compiled output): if you change `core` and then test a package that uses it, build `core` first.

**Windows:** start the terminal with the drive letter in **uppercase**. A lowercase drive letter (the usual thing in the VS Code terminal) makes a hand-run `pnpm -r <script>` fail to match the workspace directory, which pulls in the root package and runs everything twice. The root scripts (`pnpm build`, `pnpm test`, `pnpm typecheck`) do not have that problem.

## Store integration tests (Docker)

The store unit tests are hermetic (in-memory fakes or a temporary SQLite file). On top of that, `mongo-store`, `mysql-store`, `postgres-store` and `redis-store` ship a `tests/integration.test.ts` that runs against a **real** server. Each suite reads its `BOTWA_TEST_*_URL` variable and **skips itself when it is not defined**, so `pnpm test` never needs the network.

```bash
# disposable servers (high ports so they do not clash with a local MySQL/Redis)
docker run -d --name botwa-it-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=botwa -p 55432:5432 postgres:16
docker run -d --name botwa-it-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=botwa -p 53306:3306 mysql:8.4
docker run -d --name botwa-it-mongo -p 57017:27017 mongo:7
docker run -d --name botwa-it-redis -p 56379:6379 redis:7

export BOTWA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55432/botwa
export BOTWA_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:53306/botwa
export BOTWA_TEST_MONGO_URL=mongodb://127.0.0.1:57017
export BOTWA_TEST_REDIS_URL=redis://127.0.0.1:56379

pnpm --filter "./packages/*-store" test   # MySQL takes a few seconds to accept connections

docker rm -f botwa-it-postgres botwa-it-mysql botwa-it-mongo botwa-it-redis
```

On Windows, always use `127.0.0.1` instead of `localhost`: `localhost` resolves to `::1` first and Docker Desktop's IPv6 forwarding accepts the TCP connection only to cut it, so the hooks time out.

`redis-store` also ships suites against a real **Redis Cluster** (`tests/cluster.integration.test.ts` and `tests/cluster-migrate.integration.test.ts`; the second one also uses `BOTWA_TEST_REDIS_URL`). Ports 47100-47105 stay well away from the ones above; the cluster bus (57100-57105) never leaves the container:

```bash
docker run -d --name botwa-it-redis-cluster -e IP=0.0.0.0 -e INITIAL_PORT=47100 -e MASTERS=3 -e SLAVES_PER_MASTER=1 -p 127.0.0.1:47100-47105:47100-47105 grokzen/redis-cluster:7.0.10
export BOTWA_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:47100
export BOTWA_TEST_REDIS_CLUSTER_CHAOS=1   # optional: failover and slot migration under load
pnpm --filter @botmesh/redis-store test
docker rm -f botwa-it-redis-cluster
```

In PowerShell, environment variables are set with `$env:BOTWA_TEST_POSTGRES_URL = 'postgres://postgres:postgres@127.0.0.1:55432/botwa'` (and likewise for the rest). You can define only the ones you care about: the other suites skip themselves.

### Email (`@botmesh/email`) against GreenMail

`packages/email-provider/tests/integration.test.ts` exercises the email provider with real `imapflow` and `nodemailer` against [GreenMail](https://greenmail-mail-test.github.io/greenmail/) (IMAP IDLE, SMTP, threading, attachments, loop protection, restarts and a full `Bot` flow). It turns on with `BOTWA_TEST_EMAIL`:

```bash
docker run -d --name botwa-it-greenmail \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  -p 127.0.0.1:3025:3025 -p 127.0.0.1:3143:3143 greenmail/standalone:2.1.3

BOTWA_TEST_EMAIL=1 pnpm --filter @botmesh/email test

docker rm -f botwa-it-greenmail
```

Host and ports: `BOTWA_TEST_EMAIL_HOST`, `BOTWA_TEST_EMAIL_SMTP_PORT` and `BOTWA_TEST_EMAIL_IMAP_PORT` (default `127.0.0.1`, `3025` and `3143`). More detail in the [package README](packages/email-provider/README.md#integration-tests). If you touch `email-provider`, run it locally: CI does not.

## Load, soak and leaks (`pnpm bench:soak`)

`scripts/soak/soak.mjs` drives the `@botmesh/core` runtime (and `@botmesh/ai` with `MockAIProvider`) through `MockProvider`: thousands of chats and group participants running flows (`ask`/validation/retries/timeouts/`delay`), conversations with `c.idle`, `bot.onIdle`, inbound dedupe, handoff, sticky language, `ctx.user`, broadcast, metrics, the typing pacer, streaming and AI tool confirmations (buttons, typed answers, timeouts, `/reset`, stale presses). After every round it waits for the bots to go idle, forces GC and measures heap, active handles (`process.getActiveResourcesInfo()`), internal map sizes, event-loop lag and throughput. At the end it calls `stop({ drain: true })` **under load** and fails (exit code 2) if any timer is still alive. It is not part of `pnpm test`.

```bash
pnpm build                                        # uses the compiled lib/
pnpm bench:soak                                   # a few seconds
pnpm bench:soak -- --chats 2000 --rounds 20       # more load
pnpm bench:soak -- --duration 600                 # a 10-minute soak
pnpm bench:soak -- --fresh 0                      # repeated chats only: the heap must stay flat
pnpm bench:soak -- --json > soak.json             # JSON report
pnpm bench:soak -- --rounds 1 --trace-timers      # where the timers left after stop() come from
```

Options: `--chats`, `--groups`, `--participants`, `--ai-chats`, `--fresh` (new chats per round; they grow `MemoryStore` on purpose and the report measures the heap after deleting them), `--rounds`, `--duration` (seconds), `--json`, `--trace-timers`. Every leak that gets fixed also gets a fast regression test in the normal suite (`packages/core/tests/soak-regressions.test.ts`, `packages/ai/tests/soak-regressions.test.ts`).

## Code rules

- **ESM-only**: `"type": "module"`, relative imports with the `.js` extension (NodeNext). Node >= 22.
- **No `console.*`** in `src/` — use the injected `logger`. QR output to the terminal is the only exception.
- **No `any`** in exported public types.
- **TDD**: write the failing test first, then the minimal implementation. Every behaviour change needs its test.
- The AI package loads provider SDKs lazily; never import them at the top level.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(...)`, `docs(...)`, `refactor(...)`, `test(...)`, `build(...)`, `chore(...)`. Imperative subject, ≤ 72 chars.

## Changesets

Every **user-visible** change to a publishable package (feature, fix, API or behaviour change) carries a *changeset* in the same PR:

```bash
pnpm changeset        # pick packages, bump type (patch/minor/major) and write the note
```

It creates a `.changeset/<name>.md` that is committed with the PR. Not needed for tests, CI, site docs, internal refactors with no observable effect, or private packages (`pnpm changeset --empty` if you want to be explicit). Details in [`.changeset/README.md`](.changeset/README.md).

## Before opening a PR

```bash
pnpm build && pnpm typecheck && pnpm test   # all green
pnpm changeset                              # if anything publishable changed
pnpm run docs                               # optional: checks the site builds with no dead links (use `pnpm run`: `pnpm docs` is a pnpm builtin)
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `build` and `test` on Node 22 and 24 on every push to `main` and on every PR against `main` (plus `pnpm run docs` on Node 24). `pnpm typecheck` and the store integration tests do **not** run in CI: run them locally before opening the PR (the store ones only if you touch a store).

## Publishing a version

Versions are managed with [Changesets](https://changesets.dev) (CLI v3) and published **by hand** from the maintainer's machine. There is no release workflow.

**Public packages** (published to npm): `@botmesh/core`, `@botmesh/baileys`, `@botmesh/meta`, `@botmesh/telegram`, `@botmesh/sqlite-store`, `@botmesh/redis-store`, `@botmesh/ai`, `@botmesh/http`, `@botmesh/graph-core` and `create-botmesh`.

**Private packages** (`"private": true`, never published): everything else — the experimental channels (`discord`, `messenger`, `instagram`, `evolution`, `wppconnect`, `twilio`, `gohighlevel`, `gupshup`, `email`, `tiktok`), the `mongo`/`postgres`/`mysql` stores, the infrastructure (`server`, `wa-gateway-kit`), the plugins and integrations (`nlu`, `rag`, `voice`, `dialogflow`, `chatwoot`, `tickets`, `moderation`, `manager`, `events`, `otel`), the product packages (`inbox`, `crm`, `hub`, `campaigns`, `deployments`, `tenant-kv`, `flow-schema`) and the tooling (`eslint-plugin-botmesh`, `@botmesh/mcp`). The [README](README.md#packages) table is the canonical list.

### The `@bot-wa/*` packages are deprecated

The project was called `@bot-wa/*` until October 2026. Those packages were **deprecated**, not unpublished (unpublishing breaks whoever already installed them), so anyone arriving through the old name sees the pointer to the new one:

```
@bot-wa/core@2.0.0-alpha.2            → Renamed to @botmesh/core
@bot-wa/{baileys,meta,telegram,sqlite-store,redis-store,ai,http,graph-core}@0.2.0-alpha.0
                                     → Renamed to @botmesh/<same name>
create-bot-wa@0.2.0-alpha.0          → Renamed to create-botmesh
```

To reverse a deprecation (for example, to publish a fix under the old name after all), run `npm deprecate "<package>@<version>" ""`. Two things worth knowing if you ever repeat the operation:

- `npm deprecate` is an authenticated write, so an account with `auth-and-writes` 2FA needs a one-time password **per package**, and the range `@*` is not accepted: go version by version. A Granular Access Token marked to bypass 2FA does the whole list in one pass, and it must be kept out of the repo (environment variable only, never a file).
- If `npm` resolves to a pnpm shim in your shell, `npm deprecate` runs pnpm instead, which cannot prompt for the OTP and fails with `ERR_PNPM_UNAUTHORIZED`. Use your Node installation's official npm CLI for that operation, with no pipes, so it can prompt.

Package `CHANGELOG.md` files and `docs/superpowers/` keep the old names on purpose: they narrate what was published under them.

### Flow

1. Every PR carries its changeset (`pnpm changeset`).
2. To publish, on `main` with a clean tree and an npm session (`pnpm login`):

```bash
pnpm version-packages         # changeset version: bumps versions and writes each package CHANGELOG
git add -A                    # the per-package CHANGELOG.md files are new, so -am would miss them
git commit -m "chore(release): version packages"
pnpm changeset publish-plan   # review what is about to be published
pnpm pack:smoke               # packs and installs the tarballs in a clean project (publishes nothing)
pnpm test:scripts             # tests of the scripts/ helpers (smoke-test semver)
pnpm release                  # pnpm clean && pnpm build && changeset publish: publishes and tags <package>@<version>
git push --follow-tags
```

> **Order matters.** A bare `pnpm release` publishes the **current** versions in the `package.json` files and leaves the changesets unconsumed (`changeset publish` does not consume them): the first time it would have shipped `0.1.0` / `2.0.0-alpha.1` with all the pending work left out. Always `version-packages` → commit → `release`.

### Release checklist

Run the whole thing before `changeset publish` (it is the checklist the [`ROADMAP.md`](ROADMAP.md) safety gate asks for); the threat model and its residual risks live in [docs/guide/threat-model.md](docs/guide/threat-model.md).

- [ ] `main` clean, no `wave*` branches or worktrees, everything that gets published already committed.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green (Node 22 and 24; CI covers build and test).
- [ ] `pnpm api-check` (0 findings) and `pnpm pack:smoke` (tarballs installed for real and templates resolved).
- [ ] `pnpm version-packages` run and reviewed with `pnpm changeset status --verbose` and `pnpm changeset publish-plan`; commit `chore(release): version packages`.
- [ ] `pnpm run docs:site && pnpm docs:check` with no errors or warnings, and `docs/public/llms.txt` up to date.
- [ ] No secret, session credential or `.env` in the tree or in the tarballs (`git status`, `scripts/pack-smoke.mjs`).
- [ ] Threat model and this checklist reviewed when the release changes surfaces (new channel, new capability, new public package).
- [ ] After publishing: `npm dist-tag ls` for every package, a clean install from the registry with the right tag, and a smoke `npm create botmesh@alpha` in an empty directory.

### Packaging smoke test

`pnpm pack:smoke` (`scripts/pack-smoke.mjs`) simulates installing from npm **without publishing**: it builds, runs `pnpm pack` on every public package into a temporary directory outside the repo, checks each tarball (`main`/`types`/`exports`/`bin` files, README and LICENSE; no `src`, tests, source maps, configs or credentials; `lib/` output without source; `engines`; private or `workspace:` dependencies; sizes) and then, in a clean npm project, installs the tarballs and verifies that every `exports` subpath imports, that a TypeScript consumer compiles with `moduleResolution` `nodenext` and `bundler`, that the optional AI SDKs only fail when used, that the `botmesh` and `create-botmesh` bins work, that no published README has relative links (they break on npmjs.com) and that every `create-botmesh` template resolves its versions against the tarballs and installs **without touching its `@botmesh/*` ranges** (a local, temporary npm registry, `scripts/smoke/registry.mjs`, serves the tarballs to the `@botmesh` scope, so npm itself resolves the ranges, prereleases included) and boots in `botmesh dev`. It needs network access for third-party dependencies and takes a few minutes. Options: `--no-build`, `--no-scaffold-install` (faster), `--keep` (keeps the temporary directory). It is a local script: there is no CI workflow for it.

### Prerelease mode `alpha`

The repo is in Changesets' **`alpha` prerelease mode** (`.changeset/pre.json`, created with `pnpm changeset pre enter alpha`). While it stays that way:

- `pnpm version-packages` produces prerelease versions: `@botmesh/core` comes out as `2.0.0-alpha.N` and the rest as `x.y.z-alpha.N` (e.g. `0.2.0-alpha.0`). `pnpm changeset status --verbose` shows the versions that would be generated.
- `pnpm release` publishes under the `alpha` dist-tag. A package that **has never been published** also gets `latest`, because npm assigns it to the first version of a name; for an existing package it is not moved, so `npm i @botmesh/core` only resolves while that package is brand new.
- `.changeset/pre.json` records the pre-mode state; do not delete or hand-edit it.

To leave prerelease mode once the API settles:

```bash
pnpm changeset pre exit    # the next version-packages produces stable versions (no -alpha.N) and publishes under latest
```

The scope **`@botmesh`** already exists on npm, and `create-botmesh` is taken by this project; both are prerequisites of the first publish and are done.

### Promoting a private package

Remove `"private": true` from its `package.json`, check that it has `publishConfig.access: "public"`, `repository.directory` and `files`, and add a changeset. No public package may depend on a private one (Changesets rejects it). The versions `create-botmesh` stamps are regenerated from the `package.json` files (`create-botmesh/src/versions.ts`, on `pnpm build` and `pnpm version-packages`).

## Documentation

- VitePress site in `docs/` (`pnpm docs:dev` to preview on `http://localhost:5173/`). It is not hosted anywhere: the docs are read in the repo itself. Before accepting changes under `docs/`, run `pnpm run docs:site && pnpm docs:check` (broken links and anchors, Mermaid diagrams that do not render, repeated headings).
- API reference generated with TypeDoc (`pnpm docs:api`) — note that TypeDoc runs against TypeScript 5.9 at the root (TypeDoc 0.28 does not support TS 7 yet, which is what compiles the packages).
- Historical designs and decisions: `docs/superpowers/specs/` and `docs/superpowers/plans/`.
