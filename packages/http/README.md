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

## Errores

Todo rechazo de política es un `SecureHttpError` con un `code` estable:

| `code` | Cuándo |
| --- | --- |
| `INVALID_URL` | La URL (o el `Location` de una redirección) no se puede parsear. |
| `INVALID_OPTIONS` | `timeoutMs`, `maxBytes` o `maxRedirects` fuera de rango. No se hace ninguna petición. |
| `UNSAFE_URL` | Esquema distinto de HTTPS (sin `allowHttp`), credenciales en la URL o sin hostname. |
| `UNSAFE_HOST` | El host o su DNS apunta a una dirección privada, loopback o link-local. |
| `TIMEOUT` | La petición completa superó `timeoutMs`. |
| `RESPONSE_TOO_LARGE` | El cuerpo superó `maxBytes`. |
| `TOO_MANY_REDIRECTS` | Más saltos que `maxRedirects`. |
| `HTTP_STATUS` | `fetchBuffer` recibió una respuesta no 2xx; el código está en `error.status`. `secureFetch` no rechaza por status: devuelve la `response`. |

```ts
import { fetchBuffer, SecureHttpError } from '@bot-wa/http'

try {
  await fetchBuffer(url)
} catch (error) {
  if (error instanceof SecureHttpError && error.code === 'HTTP_STATUS' && error.status === 404) {
    // el recurso ya no existe
  }
}
```
