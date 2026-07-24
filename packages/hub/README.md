# @bot-wa/hub

Registro de plugins por tenant. Valida manifiestos, compatibilidad de major version y permisos explícitos antes de habilitar un plugin.

```ts
const registry = new PluginRegistry()
registry.install('acme', manifest, '2.0.0')
registry.enable('acme', manifest.id, manifest.permissions)
```

El registro no ejecuta código ni descarga paquetes; la firma, sandbox y marketplace remoto son responsabilidades de la siguiente capa de infraestructura.
