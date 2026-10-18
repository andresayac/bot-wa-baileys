# Changesets

Esta carpeta la usa [Changesets](https://changesets.dev) (CLI v3) para versionar y publicar los paquetes del monorepo. Cada archivo `*.md` que veas aquí (salvo este README) es un *changeset*: declara qué paquetes cambian, con qué tipo de bump semver y con qué nota de changelog.

## Cuándo añadir uno

Todo cambio **visible para el usuario** de un paquete publicable (feature, fix, cambio de API, cambio de comportamiento, dependencia que afecta a quien instala) lleva un changeset en el mismo PR:

```bash
pnpm changeset          # elige paquetes, tipo de bump (patch/minor/major) y escribe la nota
```

No hace falta para cambios que no llegan a npm: tests, CI, docs del sitio, refactors internos sin efecto observable o paquetes privados. Si quieres dejar constancia explícita de que un PR no publica nada: `pnpm changeset --empty`.

## Cómo se publica

La publicación es **manual**: la hace el mantenedor desde su máquina, en `main` y con el árbol limpio. No hay ningún workflow de GitHub que publique.

1. `pnpm version-packages` (`changeset version`) consume los changesets pendientes: sube versiones, actualiza las dependencias internas (`workspace:*`) y escribe el `CHANGELOG.md` de cada paquete. Revisa el resultado y haz commit.
2. `pnpm release` (`pnpm build && changeset publish`) publica en npm todo paquete público cuya versión aún no esté en el registro y crea los tags de git `<paquete>@<versión>`.
3. `git push --follow-tags`.

Para ver qué se publicaría sin publicar nada: `pnpm changeset publish-plan`.

## Configuración (`config.json`)

- `baseBranch: "main"`, `access: "public"`, `commit: false` (los commits de versión los haces tú, no el CLI).
- `updateInternalDependencies: "patch"`: un bump de un paquete actualiza el rango en los paquetes del workspace que dependen de él.
- `privatePackages: { version: false, tag: false }`: los paquetes con `"private": true` **nunca** se versionan, etiquetan ni publican. Para promover uno, quita `"private": true` de su `package.json` y añade un changeset.

Un paquete público no puede depender (en `dependencies`/`peerDependencies`) de uno privado: Changesets lo rechaza con `Invalid tree`.

## Prereleases (modo `alpha` activo)

El repo está en **modo prerelease `alpha`**: `pnpm changeset pre enter alpha` creó `pre.json` en esta carpeta (no lo borres ni lo edites a mano). Mientras siga ahí:

- `changeset version` genera versiones de prerelease: `@bot-wa/core` sale como `2.0.0-alpha.N` y el resto como `x.y.z-alpha.N`.
- `changeset publish` publica bajo el dist-tag `alpha`, no `latest`.
- `pnpm changeset status --verbose` muestra qué versión recibiría cada paquete.

Para salir de la serie alpha y publicar versiones estables bajo `latest`:

```bash
pnpm changeset pre exit
```

Más detalle en [`CONTRIBUTING.md`](../CONTRIBUTING.md#publicar-una-versión).
