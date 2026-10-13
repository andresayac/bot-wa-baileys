# @bot-wa/hub

> [!WARNING]
> **Prototipo en memoria · privado (`"private": true`, no se publica en npm).**
> El estado vive en RAM y se pierde al reiniciar; no hay firma, sandbox ni registry remoto, y la API puede cambiar sin aviso. Sirve para fijar el contrato antes de la implementación real.
>
> Roadmap: track [H. Plugins, Hub, MCP y skills](../../ROADMAP.md#h-plugins-hub-mcp-y-skills), fase [F5 — Ecosistema y escala](../../ROADMAP.md#f5--ecosistema-y-escala) («Plugin SDK v2 y registry firmado», «Integration Hub y trust tiers»). El contrato objetivo es el [Plugin manifest v2](../../ROADMAP.md#plugin-manifest-v2).

Registro de plugins por tenant. Valida manifiestos, compatibilidad de major version y permisos explícitos antes de habilitar un plugin.

```ts
import { PluginRegistry } from '@bot-wa/hub'

const registry = new PluginRegistry()
registry.install('acme', manifest, '2.0.0')
registry.enable('acme', manifest.id, manifest.permissions)
```

El registro no ejecuta código ni descarga paquetes; la firma, sandbox y marketplace remoto son responsabilidades de la siguiente capa de infraestructura.
