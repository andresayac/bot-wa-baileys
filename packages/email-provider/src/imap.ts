/**
 * IMAP ingress: connect, lock the mailbox, IDLE, and fetch new messages by UID.
 *
 * - First connect: `processExisting: 'unseen'` processes the UNSEEN backlog;
 *   `'none'` starts from UIDNEXT. After that every sync fetches `lastUid+1:*`,
 *   so `markSeen: false` never replays mail and a human reading a message in
 *   their own client before the bot syncs does not hide it from the bot.
 * - `exists` notifications (pushed by the server while IDLE — imapflow IDLEs
 *   automatically once a mailbox is selected) trigger a sync. Syncs are
 *   serialized and coalesced.
 * - A dropped connection reconnects with exponential backoff, reusing the UID
 *   cursor unless UIDVALIDITY changed (then it restarts from UIDNEXT, never
 *   replaying the mailbox). Authentication failures do not retry.
 * - The UNSEEN backlog scan stays pending until it completes: a scan that fails
 *   halfway is retried on the next sync (skipping UIDs already processed), never
 *   replaced by a `1:*` range that would replay mail a human already read.
 * - Messages are fetched in batches of `BATCH` UIDs, sizes first: mail larger
 *   than `maxMessageBytes` is skipped (and flagged `\Seen` when `markSeen`)
 *   without downloading its body.
 */

import type { ConnectionState, DisconnectReason, LoggerLike } from '@bot-wa/core'
import type { ImapClientLike, ImapMailboxLock } from './types.js'

export interface ImapMessageMeta {
  uid: number
  mailbox: string
  internalDate?: Date
  /** Mailbox UIDVALIDITY the `uid` belongs to. */
  uidValidity?: string
}

/** UIDs fetched per FETCH command, so a large backlog is never buffered whole. */
const BATCH = 20

export interface ImapIngressOptions {
  createClient: () => Promise<ImapClientLike>
  mailbox: string
  markSeen: boolean
  processExisting: 'unseen' | 'none'
  /** Messages whose RFC 822 size exceeds this are skipped without downloading them. */
  maxMessageBytes: number
  onMessage: (source: Buffer, meta: ImapMessageMeta) => Promise<void>
  onState: (state: ConnectionState, reason?: DisconnectReason, detail?: string) => void
  logger: LoggerLike
  reconnectBaseMs: number
  reconnectMaxMs: number
}

/** True for IMAP authentication failures (imapflow sets `authenticationFailed`). */
export function isAuthError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { authenticationFailed?: unknown; serverResponseCode?: unknown; responseText?: unknown; message?: unknown }
  if (e.authenticationFailed === true) return true
  if (e.serverResponseCode === 'AUTHENTICATIONFAILED') return true
  const text = `${typeof e.responseText === 'string' ? e.responseText : ''} ${typeof e.message === 'string' ? e.message : ''}`
  return /AUTHENTICATIONFAILED|invalid credentials|authentication failed/i.test(text)
}

export class ImapIngress {
  private client?: ImapClientLike
  private lock?: ImapMailboxLock
  private stopped = true
  private everConnected = false
  private lastUid = 0
  private baselineUid = 0
  /** UIDNEXT-1 when the first connection selected the mailbox: the end of the UNSEEN backlog. */
  private scanBaselineUid = 0
  private uidValidity?: string
  private pendingUnseenScan = false
  private attempts = 0
  private timer?: ReturnType<typeof setTimeout>
  private chain: Promise<void> = Promise.resolve()
  private queued = false

  constructor(private readonly opts: ImapIngressOptions) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const client = this.client
    const lock = this.lock
    this.client = undefined
    this.lock = undefined
    try { lock?.release() } catch { /* already released */ }
    if (client) {
      try {
        await client.logout()
      } catch {
        try { client.close?.() } catch { /* ignore */ }
      }
    }
    await this.chain.catch(() => undefined)
  }

  /** UIDVALIDITY of the currently selected mailbox. */
  get currentUidValidity(): string | undefined {
    return this.client ? this.uidValidity : undefined
  }

  /**
   * Fetch one message's raw source by UID (attachment re-download). Returns
   * `undefined` when `uidValidity` is given and no longer matches the mailbox.
   */
  async fetchSource(uid: number, uidValidity?: string): Promise<Buffer | undefined> {
    const client = this.client
    if (!client) return undefined
    if (uidValidity !== undefined && uidValidity !== this.uidValidity) return undefined
    for await (const m of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) {
      if (m.uid === uid && m.source) return Buffer.from(m.source)
    }
    return undefined
  }

  private async connect(): Promise<void> {
    const client = await this.opts.createClient()
    client.on('error', (err: unknown) => {
      this.opts.logger.warn({ err }, 'imap client error')
    })
    client.on('close', () => {
      if (this.client === client) this.handleClose()
    })
    client.on('exists', () => {
      if (this.client === client) this.requestSync()
    })
    try {
      await client.connect()
      this.lock = await client.getMailboxLock(this.opts.mailbox)
    } catch (err) {
      try { client.close?.() } catch { /* ignore */ }
      throw err
    }
    if (this.stopped) {
      try { this.lock.release() } catch { /* ignore */ }
      await client.logout().catch(() => undefined)
      return
    }
    this.client = client
    const mailbox = client.mailbox || undefined
    const validity = mailbox?.uidValidity != null ? String(mailbox.uidValidity) : undefined
    const uidNext = typeof mailbox?.uidNext === 'number' ? mailbox.uidNext : undefined
    this.baselineUid = uidNext !== undefined ? Math.max(0, uidNext - 1) : this.lastUid
    if (!this.everConnected) {
      this.everConnected = true
      this.scanBaselineUid = this.baselineUid
      if (this.opts.processExisting === 'unseen') this.pendingUnseenScan = true
      else this.lastUid = this.baselineUid
    } else if (validity !== this.uidValidity) {
      this.opts.logger.warn('imap UIDVALIDITY changed; resuming from UIDNEXT')
      this.lastUid = this.baselineUid
      this.pendingUnseenScan = false // old UIDs mean nothing now
    }
    this.uidValidity = validity
    this.attempts = 0
    this.opts.onState('ready')
    this.requestSync()
  }

  private handleClose(): void {
    this.client = undefined
    this.lock = undefined
    if (this.stopped) return
    this.opts.onState('closed', 'transient', 'imap connection closed')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = Math.min(this.opts.reconnectBaseMs * 2 ** this.attempts, this.opts.reconnectMaxMs)
    this.attempts++
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      this.opts.onState('connecting')
      this.connect().catch((err: unknown) => {
        if (this.stopped) return
        const detail = err instanceof Error ? err.message : String(err)
        if (isAuthError(err)) {
          this.opts.onState('closed', 'sessionInvalid', detail)
          return
        }
        this.opts.logger.warn({ err, attempt: this.attempts }, 'imap reconnect failed')
        this.opts.onState('closed', 'transient', detail)
        this.scheduleReconnect()
      })
    }, delay)
    this.timer.unref?.()
  }

  private requestSync(): void {
    if (this.queued) return
    this.queued = true
    this.chain = this.chain
      .then(async () => {
        this.queued = false
        await this.sync()
      })
      .catch((err: unknown) => {
        this.queued = false
        this.opts.logger.error({ err }, 'imap sync failed')
      })
  }

  private async sync(): Promise<void> {
    const client = this.client
    if (!client || this.stopped) return
    let uids: number[]
    const unseenScan = this.pendingUnseenScan
    if (unseenScan) {
      // Stays pending until the scan completes; UIDs processed by a failed attempt are skipped.
      uids = ((await client.search({ seen: false }, { uid: true })) || []).filter((u) => u > this.lastUid)
    } else {
      uids = ((await client.search({ uid: `${this.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > this.lastUid)
    }
    uids = [...new Set(uids)].sort((a, b) => a - b)
    for (let i = 0; i < uids.length; i += BATCH) {
      if (this.stopped || this.client !== client) return
      await this.processBatch(client, uids.slice(i, i + BATCH))
    }
    if (this.stopped || this.client !== client) return
    // The backlog scan covered everything up to UIDNEXT at first select (seen mail is skipped on purpose).
    if (unseenScan) {
      this.lastUid = Math.max(this.lastUid, this.scanBaselineUid)
      this.pendingUnseenScan = false
    }
  }

  private async processBatch(client: ImapClientLike, batch: number[]): Promise<void> {
    // Sizes first, so oversized mail is never downloaded.
    const sizes = new Map<number, number>()
    for await (const m of client.fetch(batch, { uid: true, size: true }, { uid: true })) {
      if (typeof m.size === 'number') sizes.set(m.uid, m.size)
    }
    const wanted: number[] = []
    const oversized: number[] = []
    for (const uid of batch) {
      if ((sizes.get(uid) ?? 0) > this.opts.maxMessageBytes) oversized.push(uid)
      else wanted.push(uid)
    }
    for (const uid of oversized) {
      this.opts.logger.warn({ uid, size: sizes.get(uid), limit: this.opts.maxMessageBytes }, 'email larger than maxInboundBytes skipped')
    }

    const fetched: Array<{ uid: number; source: Buffer; internalDate?: Date }> = []
    if (wanted.length) {
      // Collect first: issuing other IMAP commands while iterating a FETCH deadlocks imapflow.
      for await (const m of client.fetch(wanted, { uid: true, source: true, internalDate: true }, { uid: true })) {
        if (!m.source) continue
        if (m.source.length > this.opts.maxMessageBytes) {
          this.opts.logger.warn({ uid: m.uid, limit: this.opts.maxMessageBytes }, 'email larger than maxInboundBytes skipped')
          continue
        }
        const internalDate = m.internalDate ? new Date(m.internalDate) : undefined
        fetched.push({ uid: m.uid, source: Buffer.from(m.source), internalDate })
      }
    }
    fetched.sort((a, b) => a.uid - b.uid)
    const byUid = new Map(fetched.map((m) => [m.uid, m]))
    for (const uid of batch) {
      if (this.stopped || this.client !== client) return
      const m = byUid.get(uid)
      if (m) {
        byUid.delete(uid)
        try {
          await this.opts.onMessage(m.source, { uid: m.uid, mailbox: this.opts.mailbox, internalDate: m.internalDate, uidValidity: this.uidValidity })
        } catch (err) {
          this.opts.logger.error({ err, uid: m.uid }, 'email processing failed')
        }
      }
      this.lastUid = Math.max(this.lastUid, uid)
    }
    if (this.opts.markSeen && this.client === client) {
      await client.messageFlagsAdd(batch, ['\\Seen'], { uid: true })
    }
  }
}
