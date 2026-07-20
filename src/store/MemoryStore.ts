/**
 * MemoryStore — default in-process store.
 *
 * Buffered Map of messages per chat (LRU capped), full chat/contact maps.
 * Auto-optional JSON dump/load for restarts.
 */

import type { proto, WAMessage, WAMessageKey, Chat, Contact } from '@whiskeysockets/baileys'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import type { FlowCheckpoint, IStore } from './IStore.js'

/** Minimal logger surface — satisfied by pino and by a bare `console`. */
export interface MemoryStoreLogger {
  error?: (...args: unknown[]) => void
}

export interface MemoryStoreOptions {
  /** Max messages retained per chat. Default 1000. */
  maxMessagesPerChat?: number
  /** Optional JSON file for persistence across restarts. */
  file?: string
  /** Auto-save interval in ms. Set 0 to disable. Default 60_000. */
  autoSaveInterval?: number
  /** Optional logger for load/persist failures. Falls back to silence when omitted. */
  logger?: MemoryStoreLogger
}

export class MemoryStore implements IStore {
  private messages = new Map<string, Map<string, WAMessage>>() // chatJid -> messageId -> msg
  private chats = new Map<string, Chat>()
  private contacts = new Map<string, Contact>()
  private flowStates = new Map<string, Record<string, unknown>>()
  private checkpoints = new Map<string, FlowCheckpoint>()
  private autoSaveTimer: NodeJS.Timeout | null = null

  constructor(private opts: MemoryStoreOptions = {}) {}

  async start(): Promise<void> {
    if (this.opts.file && existsSync(this.opts.file)) {
      try {
        const raw = await readFile(this.opts.file, 'utf8')
        const data = JSON.parse(raw)
        if (data.chats) for (const c of data.chats) this.chats.set(c.id, c)
        if (data.contacts) for (const c of data.contacts) this.contacts.set(c.id, c)
        if (data.flowStates) for (const [k, v] of Object.entries(data.flowStates)) this.flowStates.set(k, v as Record<string, unknown>)
        if (data.checkpoints) for (const [k, v] of Object.entries(data.checkpoints)) this.checkpoints.set(k, v as FlowCheckpoint)
        // Messages are intentionally NOT restored (privacy + size).
      } catch (err) {
        this.opts.logger?.error?.({ err, file: this.opts.file }, 'MemoryStore failed to load file')
      }
    }
    const interval = this.opts.autoSaveInterval ?? 60_000
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

  private async persist(): Promise<void> {
    if (!this.opts.file) return
    const payload = {
      chats: [...this.chats.values()],
      contacts: [...this.contacts.values()],
      flowStates: Object.fromEntries(this.flowStates),
      checkpoints: Object.fromEntries(this.checkpoints),
    }
    try {
      await writeFile(this.opts.file, JSON.stringify(payload), 'utf8')
    } catch (err) {
      this.opts.logger?.error?.({ err, file: this.opts.file }, 'MemoryStore failed to persist')
    }
  }

  private messagesFor(chatId: string): Map<string, WAMessage> {
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

  async saveMessage(msg: WAMessage): Promise<void> {
    if (!msg.key?.id || !msg.key?.remoteJid || !msg.message) return
    const m = this.messagesFor(msg.key.remoteJid)
    m.set(msg.key.id, msg)
    this.trimChat(msg.key.remoteJid)
  }

  async getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    const m = this.messages.get(key.remoteJid ?? '')
    return m?.get(key.id ?? '')?.message ?? undefined
  }

  async getMessagesByChat(chatId: string, limit = 50): Promise<WAMessage[]> {
    const m = this.messages.get(chatId)
    if (!m) return []
    const all = [...m.values()]
    return all.slice(Math.max(0, all.length - limit))
  }

  async updateMessage(key: WAMessageKey, patch: Partial<WAMessage>): Promise<WAMessage | undefined> {
    const m = this.messages.get(key.remoteJid ?? '')
    const existing = m?.get(key.id ?? '')
    if (!existing) return undefined
    const updated = { ...existing, ...patch }
    m!.set(key.id!, updated)
    return updated
  }

  async deleteMessage(key: WAMessageKey): Promise<void> {
    this.messages.get(key.remoteJid ?? '')?.delete(key.id ?? '')
  }

  async upsertChat(chat: Partial<Chat> & { id: string }): Promise<void> {
    const existing = this.chats.get(chat.id)
    this.chats.set(chat.id, { ...(existing as any), ...chat } as Chat)
  }

  async getChat(chatId: string): Promise<Chat | undefined> {
    return this.chats.get(chatId)
  }

  async listChats(): Promise<Chat[]> {
    return [...this.chats.values()]
  }

  async deleteChat(chatId: string): Promise<void> {
    this.chats.delete(chatId)
    this.messages.delete(chatId)
  }

  async upsertContact(contact: Partial<Contact> & { id: string }): Promise<void> {
    const existing = this.contacts.get(contact.id)
    this.contacts.set(contact.id, { ...(existing as any), ...contact } as Contact)
  }

  async getContact(userId: string): Promise<Contact | undefined> {
    return this.contacts.get(userId)
  }

  async listContacts(): Promise<Contact[]> {
    return [...this.contacts.values()]
  }

  async getFlowState(userId: string): Promise<Record<string, unknown> | undefined> {
    return this.flowStates.get(userId)
  }

  async setFlowState(userId: string, state: Record<string, unknown>): Promise<void> {
    this.flowStates.set(userId, state)
  }

  async clearFlowState(userId: string): Promise<void> {
    this.flowStates.delete(userId)
  }

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
}
