# Contributing

Gracias por querer contribuir a `bot-wa-baileys`. Este repo es un **monorepo pnpm** transporte-agnóstico: el motor es `@bot-wa/core` (`packages/core`), rodeado de transportes (baileys/meta/messenger/instagram/telegram/discord), stores (sqlite/redis/mongo/postgres/mysql), helpers compartidos (`@bot-wa/graph-core`) y tooling (`@bot-wa/ai`, `@bot-wa/nlu`, `@bot-wa/manager`, `create-bot-wa`). Ver la tabla completa en el [README](README.md#paquetes).

## Requisitos

- **Node >= 22** (recomendado 24 LTS).
- **pnpm** (ver la versión en `packageManager` de `package.json`; instala con `corepack enable`).

## Puesta en marcha

```bash
pnpm install          # instala todo el workspace
pnpm build            # compila todos los paquetes (pnpm -r build)
pnpm test             # suite completa (pnpm -r test)
```

Trabajar en un solo paquete:

```bash
pnpm --filter @bot-wa/ai test
pnpm --filter @bot-wa/core build
```

## Reglas del código

- **ESM-only**: `"type": "module"`, imports relativos con extensión `.js` (NodeNext). Node >= 22.
- **Sin `console.*`** en `src/` — usa el `logger` inyectado. La salida del QR por terminal es la única excepción.
- **Sin `any`** en tipos exportados públicos.
- **TDD**: escribe el test que falla primero, luego la implementación mínima. Cada cambio de comportamiento necesita su test.
- El paquete de IA carga los SDKs de proveedor de forma lazy; nunca los importes al top-level.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(...)`, `docs(...)`, `refactor(...)`, `test(...)`, `build(...)`, `chore(...)`. Sujeto en imperativo, ≤ 72 chars.

## Antes de abrir un PR

```bash
pnpm -r build && pnpm -r test        # ambos verdes
pnpm docs                            # opcional: verifica que el sitio compila sin links muertos
```

CI (GitHub Actions) corre `build` + `test` en Node 22 y 24 en cada PR contra `main`.

## Documentación

- Sitio VitePress en `docs/` (`pnpm docs:dev` para previsualizar).
- Referencia de API generada con TypeDoc (`pnpm docs:api`) — nota: TypeDoc corre contra TypeScript 5.9 en la raíz (TypeDoc 0.28 aún no soporta TS 7, que es el compilador de los paquetes).
- Diseños y decisiones históricas: `docs/superpowers/specs/` y `docs/superpowers/plans/`.
