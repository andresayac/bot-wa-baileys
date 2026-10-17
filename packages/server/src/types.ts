/**
 * Structural types for @bot-wa/server. Nothing here imports a web framework or
 * `@bot-wa/core`: any object with the right shape works, so a provider
 * (`CloudAPIProvider`, `TelegramProvider`, ...) or a `Bot` is accepted as-is.
 */

/** Request headers as Node exposes them (lower-cased keys). */
export type IngressHeaders = Record<string, string | string[] | undefined>

/**
 * The slice of `IProvider` the ingress drives. `ingest` receives the raw body
 * (a Buffer, or a utf-8 string with `body: 'text'`) plus the request headers,
 * and may return (or resolve to) the HTTP status to answer with.
 */
export interface WebhookProvider {
  ingest?(rawEvent: unknown, headers?: IngressHeaders): unknown
  /** GET verification handshake (Meta). Returns the challenge to echo, or null → 403. */
  verifyChallenge?(query: Record<string, string>): string | null | Promise<string | null>
}

/** The slice of `Bot` used by `/readyz`. `Bot#getConnectionState()` fits. */
export interface BotStateSource {
  getConnectionState(): string
}

/** pino-compatible logger subset. The ingress logs metadata only, never bodies or headers. */
export interface IngressLogger {
  debug?(obj: Record<string, unknown>, msg?: string): void
  info?(obj: Record<string, unknown>, msg?: string): void
  warn(obj: Record<string, unknown>, msg?: string): void
  error(obj: Record<string, unknown>, msg?: string): void
}

export interface IngressRoute {
  /** Exact path to serve, e.g. `'/webhook/whatsapp'`. Must start with `/`. */
  path: string
  provider: WebhookProvider
  /**
   * How the raw body is handed to `ingest`: `'buffer'` (default — the exact
   * bytes, what Meta's `X-Hub-Signature-256` check needs) or `'text'` (utf-8
   * string; use it for `TelegramProvider`, whose `ingest` parses strings).
   */
  body?: 'buffer' | 'text'
  /** Per-route override of {@link IngressOptions.maxBodyBytes}. */
  maxBodyBytes?: number
}

export interface IngressOptions {
  routes: IngressRoute[]
  /** Max request body in bytes; larger bodies get 413. Default 1 MiB. */
  maxBodyBytes?: number
  /** Time allowed to receive the whole body; slower clients get 408. Default 10 000 ms. */
  bodyTimeoutMs?: number
  /** Time allowed for `ingest` to settle; past it the request gets 503. Default 10 000 ms. */
  ingestTimeoutMs?: number
  /**
   * Max webhook requests being read or ingested at once; beyond it new
   * requests get 503 + `Retry-After: 1`. A timed-out ingest keeps its slot
   * until it actually settles, so the bound holds. Default 64.
   */
  maxConcurrent?: number
  /** Liveness path (always 200 while serving). `false` disables it. Default `'/healthz'`. */
  healthPath?: string | false
  /** Readiness path (200 when ready, else 503). `false` disables it. Default `'/readyz'`. */
  readyPath?: string | false
  /** Bot whose connection state gates readiness (`'ready'` → ready). */
  bot?: BotStateSource
  /** Extra readiness check (DB, queue...). Throwing or resolving false → not ready. */
  readiness?: () => boolean | Promise<boolean>
  logger?: IngressLogger
}

/** Framework-neutral request handed to {@link Ingress.handle} by an adapter. */
export interface IngressRequest {
  method: string
  /** Path without query string. */
  path: string
  query: URLSearchParams
  headers: IngressHeaders
  /**
   * Read the whole raw body. Must reject with `BodyTooLargeError` once more
   * than `limit` bytes arrive, with `BodyTimeoutError` after `timeoutMs`, and
   * with `BodyUnavailableError` when something already consumed the stream.
   */
  readBody(limit: number, timeoutMs: number): Promise<Buffer>
}

export interface IngressResponse {
  status: number
  headers: Record<string, string>
  body: string
  /** The adapter should close the connection (the request body was not fully read). */
  closeConnection?: boolean
}

export interface Ingress {
  /** Handle a request. Resolves `undefined` when no route matches (adapters fall through / 404). */
  handle(req: IngressRequest): Promise<IngressResponse | undefined>
  /** Whether `path` is served by this ingress (webhook or health route). */
  matches(path: string): boolean
  /** Every path served (webhook routes + enabled health paths). */
  readonly paths: readonly string[]
  /** Webhook requests currently being read or ingested. */
  readonly inflight: number
  /** True once `close()` was called. */
  readonly closing: boolean
  /** Whether `/readyz` would answer ready right now. */
  isReady(): Promise<boolean>
  /**
   * Stop accepting webhooks (503) and report not ready; resolves once in-flight
   * requests settle, or after `timeoutMs` (default: wait indefinitely).
   */
  close(opts?: { timeoutMs?: number }): Promise<void>
}
