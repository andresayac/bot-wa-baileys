/**
 * MemoryStore — default in-process store (transport-agnostic).
 *
 * Buffered Map of messages per chat (capped), full chat/contact maps, flow
 * checkpoints, AI conversation history, and delivery cursors. Optional JSON
 * dump/load for restarts (messages are intentionally NOT persisted).
 */

import { existsSync } from 'fs'
import { readFile, writeFile, rename } from 'fs/promises'
import type {
  AIMessage,
  FlowCheckpoint,
  IStore,
  MessageRef,
  StoredChat,
  StoredContact,
  StoredMessage,
  UserDataEntry,
  UserId,
} from '../core/provider.js'
import { MemoryUserDataTable } from './MemoryUserDataTable.js'
import { parseDuration } from '../utils/duration.js'

/** Minimal logger surface — satisfied by pino and by a bare `console`. */
export interface MemoryStoreLogger {
  error?: (...args: unknown[]) => void
}

export interface MemoryStoreOptions {
  /** Max messages retained per chat. Default 1000. */
  maxMessagesPerChat?: number
  /** Optional JSON file for persistence across restarts. */
  file?: string
  /** Auto-save interval: a duration (`'1m'`) or ms. Set 0 to disable. Default 60_000. */
  autoSaveInterval?: string | number
  /** Optional logger for load/persist failures. Falls back to silence when omitted. */
  logger?: MemoryStoreLogger
}

export class MemoryStore implements IStore {
  private messages = new Map<string, Map<string, StoredMessage>>() // chatId -> messageId -> msg
  private chats = new Map<string, StoredChat>()
  private contacts = new Map<string, StoredContact>()
  private checkpoints = new Map<string, FlowCheckpoint>()
  private conversations = new Map<string, AIMessage[]>()
  private cursors = new Map<string, string>()
  private userData = new MemoryUserDataTable()
  private autoSaveTimer: NodeJS.Timeout | null = null
  /** Serializes persist() calls so a timer save and a stop() save never overlap. */
  private persistQueue: Promise<void> = Promise.resolve()
  private persistSeq = 0

  /** `autoSaveInterval` in ms, parsed up front so a bad duration fails at construction. */
  private readonly autoSaveMs: number

  constructor(private opts: MemoryStoreOptions = {}) {
    this.autoSaveMs = parseDuration(opts.autoSaveInterval ?? 60_000)
  }

  /**
   * `true` when this store mirrors itself to a JSON `file`, so its data (including
   * `persistent()` flow checkpoints) survives a process restart. `false` = RAM only.
   */
  get durable(): boolean { return Boolean(this.opts.file) }

  async start(): Promise<void> {
    if (this.opts.file && existsSync(this.opts.file)) {
      try {
        const raw = await readFile(this.opts.file, 'utf8')
        const data = JSON.parse(raw)
        if (data.chats) for (const c of data.chats) this.chats.set(c.id, c)
        if (data.contacts) for (const c of data.contacts) this.contacts.set(c.id, c)
        if (data.checkpoints) for (const [k, v] of Object.entries(data.checkpoints)) this.checkpoints.set(k, v as FlowCheckpoint)
        if (data.conversations) for (const [k, v] of Object.entries(data.conversations)) this.conversations.set(k, v as AIMessage[])
        if (data.cursors) for (const [k, v] of Object.entries(data.cursors)) this.cursors.set(k, v as string)
        this.userData.load(data.userData, Date.now()) // absent in files written before ctx.user
        // Messages are intentionally NOT restored (privacy + size).
      } catch (err) {
        this.opts.logger?.error?.({ err, file: this.opts.file }, 'MemoryStore failed to load file')
      }
    }
    const interval = this.autoSaveMs
    if (this.opts.file && interval > 0) {
      this.autoSaveTimer = setInterval(() => this.persist().catch(() => {}), interval)
    }
  }

  async stop(): Promise<void> {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer)
      this.autoSaveTimer = null
    }
    if (this.opts.file) await this.persist()
  }

  /**
   * Serialize a snapshot to disk. Calls are CHAINED (never concurrent): the
   * autosave timer and stop() can both trigger a persist, and two overlapping
   * writes to the same temp file could interleave and corrupt it. Queueing
   * guarantees one-at-a-time; the temp name is also per-write for extra safety.
   */
  private persist(): Promise<void> {
    if (!this.opts.file) return Promise.resolve()
    this.persistQueue = this.persistQueue.then(() => this.writeSnapshot())
    return this.persistQueue
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.opts.file) return
    const payload = {
      chats: [...this.chats.values()],
      contacts: [...this.contacts.values()],
      checkpoints: Object.fromEntries(this.checkpoints),
      conversations: Object.fromEntries(this.conversations),
      cursors: Object.fromEntries(this.cursors),
      userData: this.userData.snapshot(Date.now()),
    }
    try {
      // Atomic write: serialize to a UNIQUE temp file, then rename over the
      // target. A crash mid-write leaves the previous good file intact instead
      // of a truncated JSON that would wipe persisted checkpoints on next load.
      const tmp = `${this.opts.file}.${process.pid}.${++this.persistSeq}.tmp`
      await writeFile(tmp, JSON.stringify(payload), 'utf8')
      await rename(tmp, this.opts.file)
    } catch (err) {
      this.opts.logger?.error?.({ err, file: this.opts.file }, 'MemoryStore failed to persist')
    }
  }

  private messagesFor(chatId: string): Map<string, StoredMessage> {
    let m = this.messages.get(chatId)
    if (!m) {
      m = new Map()
      this.messages.set(chatId, m)
    }
    return m
  }

  private trimChat(chatId: string): void {
    const cap = this.opts.maxMessagesPerChat ?? 1000
    const m = this.messages.get(chatId)
    if (!m || m.size <= cap) return
    const overflow = m.size - cap
    let i = 0
    for (const k of m.keys()) {
      m.delete(k)
      if (++i >= overflow) break
    }
  }

  /* Messages -------------------------------------------------------------- */

  async saveMessage(msg: StoredMessage): Promise<void> {
    if (!msg.ref?.id || !msg.chatId) return
    const m = this.messagesFor(msg.chatId)
    m.set(msg.ref.id, msg)
    this.trimChat(msg.chatId)
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    return this.messages.get(ref.chatId)?.get(ref.id)
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<StoredMessage[]> {
    const m = this.messages.get(chatId)
    if (!m) return []
    const all = [...m.values()]
    return all.slice(Math.max(0, all.length - limit))
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    this.messages.get(ref.chatId)?.delete(ref.id)
  }

  /* Chats ----------------------------------------------------------------- */

  async upsertChat(chat: StoredChat): Promise<void> {
    const existing = this.chats.get(chat.id)
    this.chats.set(chat.id, { ...existing, ...chat })
  }

  async getChat(chatId: string): Promise<StoredChat | undefined> {
    return this.chats.get(chatId)
  }

  async listChats(): Promise<StoredChat[]> {
    return [...this.chats.values()]
  }

  async deleteChat(chatId: string): Promise<void> {
    this.chats.delete(chatId)
    this.messages.delete(chatId)
  }

  /* Contacts -------------------------------------------------------------- */

  async upsertContact(contact: StoredContact): Promise<void> {
    const existing = this.contacts.get(contact.id)
    this.contacts.set(contact.id, { ...existing, ...contact })
  }

  async getContact(userId: string): Promise<StoredContact | undefined> {
    return this.contacts.get(userId)
  }

  async listContacts(): Promise<StoredContact[]> {
    return [...this.contacts.values()]
  }

  async deleteContact(userId: string): Promise<void> {
    this.contacts.delete(userId)
  }

  /* Delivery cursor ------------------------------------------------------- */

  async getCursor(key: string): Promise<string | undefined> {
    return this.cursors.get(key)
  }

  async setCursor(key: string, value: string): Promise<void> {
    this.cursors.set(key, value)
  }

  /* Flow checkpoints ------------------------------------------------------ */

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    return this.checkpoints.get(key)
  }

  async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    this.checkpoints.set(key, cp)
  }

  async clearCheckpoint(key: string): Promise<void> {
    this.checkpoints.delete(key)
  }

  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    return [...this.checkpoints.entries()]
  }

  /* AI conversation history ----------------------------------------------- */

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    const c = this.conversations.get(key)
    return c ? [...c] : undefined
  }

  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    this.conversations.set(key, messages)
  }

  async clearConversation(key: string): Promise<void> {
    this.conversations.delete(key)
  }

  /* User data (ctx.user) — lazy expiry; persisted in the JSON file -------- */

  async getUserData(userId: UserId, namespace: string, key: string): Promise<UserDataEntry | undefined> {
    return this.userData.get(userId, namespace, key, Date.now())
  }

  async setUserData(entry: UserDataEntry): Promise<void> {
    this.userData.set(entry)
  }

  async deleteUserData(userId: UserId, namespace?: string, key?: string): Promise<void> {
    this.userData.delete(userId, namespace, key)
  }

  async listUserData(userId: UserId, namespace?: string): Promise<UserDataEntry[]> {
    return this.userData.list(userId, namespace, Date.now())
  }

  async purgeExpiredUserData(now: number = Date.now()): Promise<number> {
    return this.userData.purge(now)
  }
}
