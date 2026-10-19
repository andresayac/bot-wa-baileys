import type { ImapClientLike, ImapFetchedMessage, SmtpMailOptions, SmtpSendInfo, SmtpTransportLike } from '../../src/types.js'

interface StoredMail { uid: number; source: Buffer; seen: boolean }

/** In-memory IMAP mailbox shared by every client a provider (re)creates. */
export class FakeImapServer {
  messages: StoredMail[] = []
  uidNext = 1
  uidValidity = 7n
  clients: FakeImapClient[] = []
  /** Error the next `connect()` rejects with (consumed once unless `sticky`). */
  connectError?: Error
  sticky = false
  fetchCalls = 0
  /** Error the next `search()` rejects with, dropping the connection first (consumed once). */
  searchError?: Error
  /** UID ranges requested with `{ source: true }`, in order. */
  sourceFetches: number[][] = []

  add(raw: string | Buffer, seen = false): number {
    const uid = this.uidNext++
    this.messages.push({ uid, source: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'), seen })
    return uid
  }

  /**
   * New mail arrives while the client IDLEs: store it and notify connected clients.
   * Like imapflow >= 1.7, a client never IDLEs while it holds a mailbox lock,
   * so such a client is not told about the new mail.
   */
  deliver(raw: string | Buffer): number {
    const uid = this.add(raw)
    for (const c of this.clients) {
      if (c.connected && c.locks === 0) c.emit('exists', { path: 'INBOX', count: this.messages.length, prevCount: this.messages.length - 1 })
    }
    return uid
  }

  createClient = (): FakeImapClient => {
    const c = new FakeImapClient(this)
    this.clients.push(c)
    return c
  }

  get current(): FakeImapClient | undefined {
    return [...this.clients].reverse().find((c) => c.connected)
  }
}

export class FakeImapClient implements ImapClientLike {
  connected = false
  /** Mailbox locks currently held (imapflow does not auto-IDLE while one is held). */
  locks = 0
  mailbox: { path: string; uidNext: number; uidValidity: bigint } | false = false
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(private readonly server: FakeImapServer) {}

  async connect(): Promise<void> {
    if (this.server.connectError) {
      const err = this.server.connectError
      if (!this.server.sticky) this.server.connectError = undefined
      throw err
    }
    this.connected = true
  }

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.mailbox = { path, uidNext: this.server.uidNext, uidValidity: this.server.uidValidity }
    this.locks++
    let released = false
    return { release: () => { if (!released) { released = true; this.locks-- } } }
  }

  async search(query: Record<string, unknown>): Promise<number[]> {
    if (this.server.searchError) {
      const err = this.server.searchError
      this.server.searchError = undefined
      this.drop()
      throw err
    }
    const all = this.server.messages
    if (query.seen === false) return all.filter((m) => !m.seen).map((m) => m.uid)
    if (typeof query.uid === 'string') {
      const from = Number(query.uid.split(':')[0])
      const hits = all.filter((m) => m.uid >= from).map((m) => m.uid)
      // IMAP "N:*" always matches at least the highest UID, even when it is < N.
      if (!hits.length && all.length) return [all[all.length - 1]!.uid]
      return hits
    }
    return all.map((m) => m.uid)
  }

  async *fetch(range: string | number[], query: Record<string, unknown> = { source: true }): AsyncIterable<ImapFetchedMessage> {
    this.server.fetchCalls++
    const uids = Array.isArray(range) ? range : range.split(',').map(Number)
    if (query.source) this.server.sourceFetches.push([...uids])
    for (const m of this.server.messages) {
      if (!uids.includes(m.uid)) continue
      const out: ImapFetchedMessage = { uid: m.uid }
      if (query.size) out.size = m.source.length
      if (query.source) out.source = m.source
      yield out
    }
  }

  async messageFlagsAdd(range: string | number[], flags: string[]): Promise<boolean> {
    const uids = Array.isArray(range) ? range : range.split(',').map(Number)
    if (flags.includes('\\Seen')) for (const m of this.server.messages) if (uids.includes(m.uid)) m.seen = true
    return true
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args)
  }

  async logout(): Promise<void> {
    this.drop()
  }

  close(): void {
    this.drop()
  }

  /** Simulate the server dropping the connection. */
  drop(): void {
    if (!this.connected) return
    this.connected = false
    this.emit('close')
  }
}

export class FakeSmtp implements SmtpTransportLike {
  sent: SmtpMailOptions[] = []
  failWith?: unknown
  rejectAll = false
  verified = 0
  closed = false

  async sendMail(mail: SmtpMailOptions): Promise<SmtpSendInfo> {
    if (this.failWith) throw this.failWith
    this.sent.push(mail)
    const to = typeof mail.to === 'string' ? mail.to : mail.to.address
    return this.rejectAll
      ? { messageId: mail.messageId, accepted: [], rejected: [to], response: '550 rejected' }
      : { messageId: mail.messageId, accepted: [to], rejected: [], response: '250 OK' }
  }

  async verify(): Promise<boolean> {
    this.verified++
    return true
  }

  close(): void {
    this.closed = true
  }
}

export const email = (headers: string[], body = 'Hola'): string => [...headers, '', body].join('\r\n')

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
