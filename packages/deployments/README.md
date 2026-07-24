# @bot-wa/deployments

Versiones inmutables por tenant y bot, con una única versión activa.

```ts
registry.publish('acme', 'support', '1.2.0', 'sha256:...')
registry.rollback('acme', 'support', '1.1.0')
```

El artefacto es una referencia opaca; el despliegue real y el rollout gradual pertenecen al adaptador de infraestructura.
