/**
 * Logger adapter — `BaileysProviderConfig.logger` takes any core `LoggerLike`
 * (pino, `console`, a custom object), but Baileys' own functions (`makeWASocket`,
 * `makeCacheableSignalKeyStore`, `downloadMediaMessage`) need its `ILogger`
 * shape: a string `level`, `child()` and `trace()`. {@link toBaileysLogger} passes a
 * pino-shaped logger through untouched and wraps anything else.
 */

import type { LoggerLike } from '@botmesh/core'

/**
 * Structural copy of Baileys' `ILogger` (its main entry does not re-export it).
 * pino's `Logger` satisfies it.
 */
export interface BaileysLogger {
  level: string
  child(obj: Record<string, unknown>): BaileysLogger
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

type LoggerExtras = {
  level?: unknown
  trace?: unknown
  child?: unknown
}

/** Already shaped like Baileys' `ILogger` (pino and friends): a string `level`, `child()` and `trace()`. */
export function isBaileysLogger(logger: LoggerLike): logger is LoggerLike & BaileysLogger {
  const l = logger as LoggerLike & LoggerExtras
  return typeof l.level === 'string' && typeof l.child === 'function' && typeof l.trace === 'function'
}

/**
 * The logger handed to Baileys. A logger that already has Baileys' shape (pino) is returned
 * as is, byte-for-byte the previous behaviour. Anything else is wrapped:
 * - `trace` forwards to the logger's own `trace` when it has one, else it is a no-op
 *   (Baileys' trace output is far too chatty to map onto `debug`);
 * - `level` is the logger's string `level` when it has one, else `fallbackLevel`
 *   (Baileys only compares it with `'trace'`);
 * - `child(bindings)` wraps `logger.child(bindings)` when available, else the same logger
 *   (the bindings are dropped).
 */
export function toBaileysLogger(logger: LoggerLike, fallbackLevel = 'info'): BaileysLogger {
  if (isBaileysLogger(logger)) return logger
  const extras = logger as LoggerLike & LoggerExtras
  const level = typeof extras.level === 'string' ? extras.level : fallbackLevel
  const trace = typeof extras.trace === 'function'
    ? (...a: unknown[]) => { (extras.trace as (...a: unknown[]) => void).apply(logger, a) }
    : () => {}
  return {
    level,
    child(bindings) {
      const child = typeof logger.child === 'function' ? logger.child(bindings) : logger
      return toBaileysLogger(child, level)
    },
    trace,
    // Forward only the arguments Baileys passed (a trailing `undefined` would print on console).
    debug: (...a) => logger.debug(...a),
    info: (...a) => logger.info(...a),
    warn: (...a) => logger.warn(...a),
    error: (...a) => logger.error(...a),
  }
}
