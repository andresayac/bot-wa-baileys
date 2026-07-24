/**
 * Config validation — runtime checks for the transport-agnostic BotConfig.
 *
 * WhatsApp/session fields (qr, pairingCode, sessionsDir, browser, …) moved to
 * @bot-wa/baileys' BaileysProviderConfig and are validated there, not here.
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
 * Validate a BotConfig object at construction time. Throws
 * {@link ConfigValidationError} with a clear message on invalid input.
 */
export function validateConfig<T extends Partial<BotConfig>>(config: T): T {
  assertType('session', config.session, 'string')
  assertType('commandPrefix', config.commandPrefix, 'string')
  assertType('debug', config.debug, 'boolean')
  assertType('tenantId', config.tenantId, 'string')
  assertType('environmentId', config.environmentId, 'string')
  assertType('botId', config.botId, 'string')
  assertType('connectionId', config.connectionId, 'string')
  assertType('persistRaw', config.persistRaw, 'boolean')

  if (config.commandPrefix === '') {
    throw new ConfigValidationError('commandPrefix', 'a non-empty string', '')
  }

  for (const field of ['tenantId', 'environmentId', 'botId', 'connectionId'] as const) {
    const value = config[field]
    if (value !== undefined && (value.trim() === '' || /[\u0000-\u001f]/.test(value))) {
      throw new ConfigValidationError(field, 'a non-empty string without control characters', value)
    }
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

  if (config.conversation) {
    assertStringOrNumber('conversation.timeout', config.conversation.timeout)
    assertType('conversation.timeoutMessage', config.conversation.timeoutMessage, 'string')
    assertType('conversation.retriesMessage', config.conversation.retriesMessage, 'string')
    assertType('conversation.errorMessage', config.conversation.errorMessage, 'string')
    assertType('conversation.cancelledMessage', config.conversation.cancelledMessage, 'string')
  }

  return config
}
