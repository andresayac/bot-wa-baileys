/**
 * Chat / contact / handoff writes of one bot, ordered per chat.
 */
import type { IStore, StoredChat, StoredContact } from '../../store/IStore.js'
import type { StoredHandoff } from '../../gates/handoff.js'
import { definedFields } from '../../utils/definedFields.js'
import type { KeyedQueue } from '../../utils/keyedQueue.js'
import type { ChatId } from '../types.js'

export class Persistence {
  constructor(private readonly store: IStore, private readonly chatWrites: KeyedQueue) {}

  /**
   * Upsert a chat record, one write at a time per chat. Stores merge with a non-atomic
   * read-modify-write, so overlapping upserts (inbound, outbound ledger, handoff) could
   * otherwise drop a field such as `handoff`. Undefined fields are omitted: stores read an
   * explicit `undefined` as "unset", which would wipe e.g. a stored name.
   */
  persistChat(chat: StoredChat): Promise<void> {
    const record = definedFields(chat)
    return this.chatWrites.run(chat.id, () => this.store.upsertChat(record))
  }

  /** Upsert a contact record, omitting undefined fields (same reason as {@link persistChat}). */
  persistContact(contact: StoredContact): Promise<void> {
    return this.store.upsertContact(definedFields(contact))
  }

  /**
   * Write a chat's handoff state in order with its other upserts. Clearing it (`null`)
   * skips a chat that has no record, so a resume never recreates a deleted chat.
   */
  writeHandoff(chatId: ChatId, handoff: StoredHandoff | null): Promise<void> {
    return this.chatWrites.run(chatId, async () => {
      if (handoff === null && !(await this.store.getChat(chatId))) return
      await this.store.upsertChat({ id: chatId, handoff })
    })
  }
}
