export class ConversationError extends Error {}
export class ConversationTimeout extends ConversationError { constructor() { super('conversation timeout') } }
export class ConversationCancelled extends ConversationError { constructor(public silent = false) { super('conversation cancelled') } }
export class RetriesExceeded extends ConversationError { constructor() { super('too many invalid attempts') } }
export class ConversationEnded extends ConversationError { constructor(public farewell?: string) { super('conversation ended') } }
export class ConversationGoto extends ConversationError { constructor(public target: string, public args?: unknown) { super(`goto ${target}`) } }
