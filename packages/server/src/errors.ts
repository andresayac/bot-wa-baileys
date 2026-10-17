/** The request body exceeded the configured limit (→ 413). */
export class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError'
  constructor(readonly limit: number) { super(`request body exceeds ${limit} bytes`) }
}

/** The request body did not arrive within the timeout (→ 408). */
export class BodyTimeoutError extends Error {
  override readonly name = 'BodyTimeoutError'
  constructor(readonly timeoutMs: number) { super(`request body not received within ${timeoutMs} ms`) }
}

/**
 * The raw body was already consumed (e.g. `express.json()` ran first) and the
 * exact bytes cannot be recovered (→ 500). Re-serializing would break signatures.
 */
export class BodyUnavailableError extends Error {
  override readonly name = 'BodyUnavailableError'
  constructor() { super('raw request body was already consumed by another middleware') }
}

/** The client aborted while sending the body. */
export class BodyAbortedError extends Error {
  override readonly name = 'BodyAbortedError'
  constructor() { super('client aborted the request body') }
}
