/**
 * Config validation — runtime checks for BotConfig with clear error messages.
 *
 * No external dependencies: a lightweight validator that catches typos and
 * type mismatches at construction time instead of failing silently later.
 */

import type { BotConfig } from '../core/types.js'

export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly expected: string,
    public readonly received: unknown,
  ) {
    super(`Invalid config.${field}: expected ${expected}, got ${typeof received} (${JSON.stringify(received)})`)
    this.name = 'ConfigValidationError'
  }
}

function assertType(field: string, value: unknown, type: string): void {
  if (value === undefined || value === null) return
  if (typeof value !== type) {
    throw new ConfigValidationError(field, type, value)
  }
}

function assertStringOrNumber(field: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ConfigValidationError(field, 'string | number', value)
  }
}

/**
 * Validate a BotConfig object at construction time.
 * Throws {@link ConfigValidationError} with a clear message on invalid input.
 * Returns the config unchanged if valid.
 */
export function validateConfig(config: BotConfig): BotConfig {
  assertType('session', config.session, 'string')
  assertType('sessionsDir', config.sessionsDir, 'string')
  assertType('pairingCode', config.pairingCode, 'string')
  assertType('reconnect', config.reconnect, 'boolean')
  assertType('markOnlineOnConnect', config.markOnlineOnConnect, 'boolean')
  assertType('debug', config.debug, 'boolean')
  assertType('ignoreNewsletters', config.ignoreNewsletters, 'boolean')
  assertType('ignoreBroadcasts', config.ignoreBroadcasts, 'boolean')
  assertType('syncFullHistory', config.syncFullHistory, 'boolean')
  assertType('commandPrefix', config.commandPrefix, 'string')

  if (config.commandPrefix === '') {
    throw new ConfigValidationError('commandPrefix', 'a non-empty string', '')
  }

  if (config.conversationScope !== undefined) {
    if (config.conversationScope !== 'participant' && config.conversationScope !== 'chat') {
      throw new ConfigValidationError('conversationScope', "'participant' | 'chat'", config.conversationScope)
    }
  }

  if (config.groupMode !== undefined) {
    if (!['all', 'mentions', 'commands'].includes(config.groupMode)) {
      throw new ConfigValidationError('groupMode', "'all' | 'mentions' | 'commands'", config.groupMode)
    }
  }

  if (config.rateLimit !== undefined && (typeof config.rateLimit !== 'object' || config.rateLimit === null)) {
    throw new ConfigValidationError('rateLimit', 'object', config.rateLimit)
  }

  if (config.qr !== undefined && typeof config.qr !== 'object') {
    throw new ConfigValidationError('qr', 'object', config.qr)
  }

  if (config.qr) {
    assertType('qr.terminal', config.qr.terminal, 'boolean')
    assertType('qr.file', config.qr.file, 'boolean')
    assertType('qr.small', config.qr.small, 'boolean')
    if (config.qr.handler !== undefined && typeof config.qr.handler !== 'function') {
      throw new ConfigValidationError('qr.handler', 'function', config.qr.handler)
    }
  }

  if (config.conversation) {
    assertStringOrNumber('conversation.timeout', config.conversation.timeout)
    assertType('conversation.timeoutMessage', config.conversation.timeoutMessage, 'string')
    assertType('conversation.retriesMessage', config.conversation.retriesMessage, 'string')
    assertType('conversation.errorMessage', config.conversation.errorMessage, 'string')
    assertType('conversation.cancelledMessage', config.conversation.cancelledMessage, 'string')
  }

  if (config.browser !== undefined) {
    const valid = ['macOS', 'ubuntu', 'windows', 'appropriate']
    if (typeof config.browser === 'string' && !valid.includes(config.browser)) {
      throw new ConfigValidationError('browser', `'macOS' | 'ubuntu' | 'windows' | 'appropriate' | [string, string, string]`, config.browser)
    }
    if (Array.isArray(config.browser) && config.browser.length !== 3) {
      throw new ConfigValidationError('browser', 'a tuple of exactly 3 strings', config.browser)
    }
  }

  return config
}
