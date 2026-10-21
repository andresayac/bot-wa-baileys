# @botmesh/http

Defensive HTTP client for outbound provider downloads. It requires HTTPS, blocks private/loopback destinations and unsafe DNS, validates every redirect, caps the response and enforces a timeout.

```ts
import { fetchBuffer } from '@botmesh/http'

const image = await fetchBuffer('https://cdn.example/image.png', {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 10_000,
})
```

Never enable `allowHttp` or `allowPrivateHosts` outside a network you control.

## Errors

Every policy rejection is a `SecureHttpError` with a stable `code`:

| `code` | When |
| --- | --- |
| `INVALID_URL` | The URL (or a redirect's `Location`) cannot be parsed. |
| `INVALID_OPTIONS` | `timeoutMs`, `maxBytes` or `maxRedirects` out of range. No request is made. |
| `UNSAFE_URL` | Scheme other than HTTPS (without `allowHttp`), credentials in the URL, or no hostname. |
| `UNSAFE_HOST` | The host or its DNS answer points at a private, loopback or link-local address. |
| `TIMEOUT` | The whole request exceeded `timeoutMs`. |
| `RESPONSE_TOO_LARGE` | The body exceeded `maxBytes`. |
| `TOO_MANY_REDIRECTS` | More hops than `maxRedirects`. |
| `HTTP_STATUS` | `fetchBuffer` got a non-2xx response; the code is in `error.status`. `secureFetch` does not reject on status: it returns the `response`. |

```ts
import { fetchBuffer, SecureHttpError } from '@botmesh/http'

try {
  await fetchBuffer(url)
} catch (error) {
  if (error instanceof SecureHttpError && error.code === 'HTTP_STATUS' && error.status === 404) {
    // the resource no longer exists
  }
}
```
