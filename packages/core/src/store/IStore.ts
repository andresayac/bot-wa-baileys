/**
 * Storage interface — what the bot asks of its store.
 *
 * Implementations: MemoryStore (built-in), SQLiteStore, RedisStore, etc.
 */

import type { proto, WAMessage, WAMessageKey, Chat, Contact } from '@whiskeysockets/baileys'

export interface IStore {
  /* Messages -------------------------------------------------------------- */
  saveMessage(msg: WAMessage): Promise<void>
  getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined>
  getMessagesByChat(chatId: string, limit?: number): Promise<WAMessage[]>
  updateMessage(key: WAMessageKey, patch: Partial<WAMessage>): Promise<WAMessage | undefined>
  deleteMessage(key: WAMessageKey): Promise<void>

  /* Chats ----------------------------------------------------------------- */
  upsertChat(chat: Partial<Chat> & { id: string }): Promise<void>
  getChat(chatId: string): Promise<Chat | undefined>
  listChats(): Promise<Chat[]>
  deleteChat(chatId: string): Promise<void>

  /* Contacts -------------------------------------------------------------- */
  upsertContact(contact: Partial<Contact> & { id: string }): Promise<void>
  getContact(userId: string): Promise<Contact | undefined>
  listContacts(): Promise<Contact[]>

  /* Flow state ------------------------------------------------------------ */
  getFlowState(userId: string): Promise<Record<string, unknown> | undefined>
  setFlowState(userId: string, state: Record<string, unknown>): Promise<void>
  clearFlowState(userId: string): Promise<void>

  /* Flow checkpoints (Task 5) ----------------------------------------------
   * Persists the "next step to run" for `persistent()` DSL flows, so they can
   * survive a process restart via ConversationRuntime.loadDormant()/resumeDormant(). */
  getCheckpoint(key: string): Promise<FlowCheckpoint | undefined>
  setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void>
  clearCheckpoint(key: string): Promise<void>
  listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>>

  /* Lifecycle ------------------------------------------------------------- */
  start(): Promise<void>
  stop(): Promise<void>
}

/** Snapshot of a `persistent()` DSL flow: which step runs next and its accumulated state. */
export interface FlowCheckpoint {
  flowId: string
  step: number
  state: Record<string, unknown>
  updatedAt: number
}

/** Helper to make the `messages.upsert` ↔ `getMessage` round-trip id lighter. */
export function messageKey(key: WAMessageKey): string {
  return `${key.remoteJid}:${key.id}`
}
