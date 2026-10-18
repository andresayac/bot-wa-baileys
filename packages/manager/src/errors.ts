/** Error with a machine-readable code, thrown by manager operations (mapped to HTTP by the REST API). */
export class ManagerError extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'NOT_CONFIGURED', readonly details?: unknown) {
    super(message)
    this.name = 'ManagerError'
  }
}
