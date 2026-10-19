/**
 * Subject data export / erasure behind `bot.exportSubject()` and `bot.deleteSubject()`
 * (data-protection requests). Everything is scoped to the bot's store namespace.
 */

import type { AIMessage, FlowCheckpoint, StoredChat, StoredContact, StoredMessage, UserId } from './types.js'
import type { UserDataEntry } from './provider.js'
import type { IStore } from '../store/IStore.js'
import type { StoreNamespace } from '../store/NamespacedStore.js'
import type { KeyedQueue } from '../utils/keyedQueue.js'

/** Every message of a chat (the store APIs take a limit). */
const ALL = 2_147_483_647

export interface SubjectDataExport {
  namespace: Readonly<StoreNamespace>
  userId: UserId
  contact?: StoredContact
  chats: StoredChat[]
  messages: StoredMessage[]
  conversation?: AIMessage[]
  checkpoints: Array<[string, FlowCheckpoint]>
  /** Live `ctx.user` profile entries (every namespace), sorted by namespace then key. */
  userData: UserDataEntry[]
  exportedAt: number
}

export interface SubjectDeletionResult {
  contacts: number
  chats: number
  messages: number
  conversations: number
  checkpoints: number
  /** Live `ctx.user` profile entries erased (every namespace). */
  userData: number
}

/** What the export/erasure needs from the Bot. Internal. */
export interface SubjectDataDeps {
  store: IStore
  namespace: Readonly<StoreNamespace>
  runtime: { abortWhere(match: (key: string) => boolean): number }
  handoffs: { forget(chatId: string): Promise<void> }
  /** The Bot's per-chat write queue: a chat is deleted behind any upsert still queued. */
  chatWrites: KeyedQueue
  i18n: { forget(sender: string): boolean }
  welcome: { forget(userId: string, chatIds: Iterable<string>): Promise<void> }
  users: { list(userId: UserId): Promise<UserDataEntry[]>; erase(userId: UserId): Promise<number> }
}

/**
 * Does a conversation checkpoint key belong to `userId`? Keys are `keyFor(ctx)`:
 * the bare subject id (DM) or `${chatJid}:${participantJid}` (group scope). Match
 * on boundaries — NOT substring — so `5511999...` does not falsely match
 * `15511999...` (one JID being a substring of another), which would leak/delete
 * an unrelated subject's data in the export/erasure APIs.
 */
export function checkpointBelongsToSubject(key: string, userId: string): boolean {
  return key === userId || key.startsWith(`${userId}:`) || key.endsWith(`:${userId}`)
}

/** Export normalized data associated with one subject. */
export async function exportSubjectData(deps: SubjectDataDeps, userId: UserId): Promise<SubjectDataExport> {
  const { store } = deps
  const contact = await store.getContact(userId)
  const chats = await store.listChats()
  const messages: StoredMessage[] = []
  for (const chat of chats) {
    const history = await store.getMessagesByChat(chat.id, ALL)
    messages.push(...history.filter((message) => message.senderId === userId || message.chatId === userId))
  }
  const checkpoints = (await store.listCheckpoints())
    .filter(([key]) => checkpointBelongsToSubject(key, userId))
  const chatsWithMessages = new Set(messages.map((message) => message.chatId))
  return {
    namespace: deps.namespace,
    userId,
    contact,
    chats: chats.filter((chat) => chat.id === userId || chatsWithMessages.has(chat.id)),
    messages,
    conversation: await store.getConversation(userId),
    checkpoints,
    userData: await deps.users.list(userId),
    exportedAt: Date.now(),
  }
}

/** Delete normalized subject data, including the handoff of chat `userId` and its conversations. */
export async function deleteSubjectData(deps: SubjectDataDeps, userId: UserId): Promise<SubjectDeletionResult> {
  const { store } = deps
  const result: SubjectDeletionResult = {
    contacts: 0,
    chats: 0,
    messages: 0,
    conversations: 0,
    checkpoints: 0,
    userData: 0,
  }
  // Live and dormant conversations of the subject go first: a running flow would
  // otherwise keep writing its checkpoint, and an in-memory dormant one would resume
  // the erased state on the subject's next message.
  deps.runtime.abortWhere((key) => checkpointBelongsToSubject(key, userId))
  // The subject's chat handoff (and its host meta) goes too — silently, without
  // rewriting the chat record we are about to delete.
  await deps.handoffs.forget(userId)
  if (await store.getContact(userId)) {
    await store.deleteContact(userId)
    result.contacts++
  }
  const chats = await store.listChats()
  for (const chat of chats) {
    if (chat.id === userId) {
      result.messages += (await store.getMessagesByChat(chat.id, ALL)).length
      // Behind any upsert of this chat still queued, so none can recreate the record.
      await deps.chatWrites.run(chat.id, () => store.deleteChat(chat.id))
      result.chats++
      continue
    }
    const messages = await store.getMessagesByChat(chat.id, ALL)
    for (const message of messages) {
      if (message.senderId !== userId) continue
      await store.deleteMessage(message.ref)
      result.messages++
    }
  }
  if (await store.getConversation(userId)) {
    await store.clearConversation(userId)
    result.conversations++
  }
  for (const [key] of await store.listCheckpoints()) {
    if (!checkpointBelongsToSubject(key, userId)) continue
    await store.clearCheckpoint(key)
    result.checkpoints++
  }
  // The language remembered from the provider's reports (in memory) goes as well.
  deps.i18n.forget(userId)
  // WELCOME markers (hashed keys): a returning erased subject is a first contact again.
  await deps.welcome.forget(userId, chats.map((chat) => chat.id))
  result.userData = await deps.users.erase(userId)
  return result
}
