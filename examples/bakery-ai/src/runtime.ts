/**
 * Process plumbing shared by the entry points: config loading, logging and
 * graceful shutdown.
 */
import { pino, type Logger } from 'pino'
import type { Bot } from '@botmesh/core'
import { ConfigError, loadDotEnv } from './config.js'

/**
 * Load `.env`, then the channel config. On a {@link ConfigError} print the
 * problems (variable names only, never values) and exit with code 1.
 */
export function loadConfigOrExit<T>(load: () => T): T {
  try {
    loadDotEnv()
    return load()
  } catch (err) {
    if (err instanceof ConfigError) {
      // The logger is not built yet (its level comes from the config): write directly.
      process.stderr.write(`${err.message}\n\nCopy .env.example to .env and fill it in (see README.md).\n`)
      process.exit(1)
    }
    throw err
  }
}

export function createLogger(level: string): Logger {
  return pino({ level, base: undefined })
}

/** Connection and error logs. Message bodies are never logged (personal data). */
export function attachBotLogging(bot: Bot, logger: Logger): void {
  bot.on('ready', () => logger.info('bot ready'))
  bot.on('connection', (u) => logger.info({ state: u.state, reason: u.reason }, 'connection'))
  bot.on('error', ({ error }) => logger.error({ err: error }, 'bot error'))
  bot.before('message', async (ctx, next) => {
    logger.debug({ chatId: ctx.from, type: ctx.type }, 'message in')
    await next()
  })
}

/**
 * Run `cleanup` once on SIGINT/SIGTERM, then exit. A second signal (or a
 * cleanup slower than `timeoutMs`) exits immediately.
 */
export function onShutdown(logger: Logger, cleanup: () => Promise<void>, timeoutMs = 10_000): void {
  let stopping = false
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1)
    stopping = true
    logger.info({ signal }, 'shutting down')
    const force = setTimeout(() => {
      logger.warn('shutdown timed out, exiting')
      process.exit(1)
    }, timeoutMs)
    force.unref()
    cleanup().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed')
        process.exit(1)
      },
    )
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
}
