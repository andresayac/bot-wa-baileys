# @bot-wa/http

Cliente HTTP defensivo para descargas salientes de proveedores. Valida HTTPS, bloquea destinos privados/loopback y DNS inseguro, valida cada redirección, limita la respuesta y aplica timeout.

```ts
import { fetchBuffer } from '@bot-wa/http'

const image = await fetchBuffer('https://cdn.example/image.png', {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 10_000,
})
```

No habilites `allowHttp` ni `allowPrivateHosts` fuera de una red controlada.
