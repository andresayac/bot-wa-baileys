export class ConversationError extends Error {}
export class ConversationTimeout extends ConversationError { constructor() { super('conversation timeout') } }
export class ConversationCancelled extends ConversationError { constructor(public silent = false) { super('conversation cancelled') } }
export class RetriesExceeded extends ConversationError { constructor() { super('too many invalid attempts') } }
export class ConversationEnded extends ConversationError { constructor(public farewell?: string) { super('conversation ended') } }
export class ConversationGoto extends ConversationError { constructor(public target: string, public args?: unknown) { super(`goto ${target}`) } }

/**
 * A conversation tried to start a wait while another one is still pending — almost always an
 * un-awaited `c.ask()` / `c.retry()`, or a wait started from a `c.idle()` callback. A
 * conversation has a single pending-wait slot, so the newer wait is refused (the pending one
 * keeps receiving messages). Not a control signal: in the conversation it ends through the
 * error path (`onError` / bot `'error'` event + `errorMessage`); in an idle callback it is only
 * reported.
 */
export class ConcurrentWaitError extends Error {
  constructor(message = 'this conversation already has a pending wait — await it before starting another one') {
    super(message)
    this.name = 'ConcurrentWaitError'
  }
}
