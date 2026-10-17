# @bot-wa/hub

> [!WARNING]
> **Prototipo en memoria · privado (`"private": true`, no se publica en npm).**
> El estado vive en RAM y se pierde al reiniciar; no hay firma, sandbox ni registry remoto, y la API puede cambiar sin aviso. Sirve para fijar el contrato antes de la implementación real.
>
> Roadmap: track [H. Plugins, Hub, MCP y skills](../../ROADMAP.md#h-plugins-hub-mcp-y-skills), fase [F5 — Ecosistema y escala](../../ROADMAP.md#f5--ecosistema-y-escala) («Plugin SDK v2 y registry firmado», «Integration Hub y trust tiers»). El contrato objetivo es el [Plugin manifest v2](../../ROADMAP.md#plugin-manifest-v2).

Registro de plugins por tenant. Valida manifiestos, compatibilidad con el runtime y permisos explícitos antes de habilitar un plugin.

```ts
import { PluginRegistry } from '@bot-wa/hub'

const registry = new PluginRegistry()
registry.install('acme', manifest, '2.0.0')
registry.enable('acme', manifest.id, manifest.permissions)
```

`validateManifest()` comprueba:

- `version`: semver completo (`MAJOR.MINOR.PATCH[-pre][+build]`).
- `botwa`: rango semver que debe satisfacer la versión del runtime. Soporta versión exacta, `=`, `>`, `>=`, `<`, `<=`, `^`, `~`, x-ranges (`2`, `2.x`, `2.1.*`, `*`), intersecciones separadas por espacios y uniones con `||`. No soporta rangos con guion (`1.0.0 - 2.0.0`) ni el prefijo `v`. Los prereleases se ordenan por precedencia: `^2.0.0` no acepta `2.0.0-alpha.1` (usa `^2.0.0-alpha.1` o `>=2.0.0-0`) ni `3.0.0-alpha.1`.
- `entry`: ruta relativa POSIX dentro del paquete. Se rechazan rutas absolutas, letras de unidad (`C:/x.js`), rutas UNC y barras invertidas, URLs (`file:///x.js`), segmentos `..` o vacíos y caracteres de control; nombres como `a..b.js` son válidos.

El registro no ejecuta código ni descarga paquetes; la firma, sandbox y marketplace remoto son responsabilidades de la siguiente capa de infraestructura.
