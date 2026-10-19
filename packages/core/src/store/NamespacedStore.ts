/**
 * `NamespacedStore`: wraps any `IStore` so every key is isolated by tenant / environment /
 * bot / provider / connection, while callers keep seeing the plain, unprefixed ids. It
 * holds no data of its own.
 */
import type {
  AIMessage,
  ChatId,
  FlowCheckpoint,
  IStore,
  MessageRef,
  StoredChat,
  StoredContact,
  StoredMessage,
  UserDataEntry,
  UserId,
} from '../core/provider.js'

export interface StoreNamespace {
  tenantId: string
  environmentId: string
  botId: string
  providerId: string
  connectionId: string
}

/**
 * Isolates every opaque store key by tenant/bot/provider connection while
 * preserving the public, unprefixed ids seen by callers.
 */
export class NamespacedStore implements IStore {
  private readonly prefix: string

  /* User data (ctx.user): defined ONLY when the inner store implements the
   * contract, so `typeof store.getUserData === 'function'` stays an honest
   * capability check. Subject ids are prefixed like contacts; namespace and key
   * pass through. `purgeExpiredUserData` is store-wide (expired entries are
   * logically gone for every bot sharing the backend). */
  readonly getUserData?: (userId: UserId, namespace: string, key: string) => Promise<UserDataEntry | undefined>
  readonly setUserData?: (entry: UserDataEntry) => Promise<void>
  readonly deleteUserData?: (userId: UserId, namespace?: string, key?: string) => Promise<void>
  readonly listUserData?: (userId: UserId, namespace?: string) => Promise<UserDataEntry[]>
  readonly purgeExpiredUserData?: (now?: number) => Promise<number>

  constructor(
    readonly innerStore: IStore,
    readonly namespace: StoreNamespace,
  ) {
    for (const [field, value] of Object.entries(namespace)) {
      if (!value || /[\u0000-\u001f]/.test(value)) {
        throw new Error(
          `Invalid store namespace ${field}: expected a non-empty string without control characters, got ${JSON.stringify(value)}`,
        )
      }
    }
    this.prefix = Object.values(namespace).map(encodeURIComponent).join('|') + '|'
    this.bindUserData(innerStore)
  }

  /** Install the namespaced user-data methods when `inner` supports them. */
  private bindUserData(inner: IStore): void {
    const { getUserData, setUserData, deleteUserData, listUserData, purgeExpiredUserData } = inner
    if (!getUserData || !setUserData || !deleteUserData || !listUserData) return
    const self = this as { -readonly [K in UserDataMethod]: NamespacedStore[K] }
    const publicEntry = (entry: UserDataEntry): UserDataEntry => ({ ...entry, userId: this.unprefix(entry.userId, 'user') })
    self.getUserData = async (userId, namespace, key) => {
      const entry = await getUserData.call(inner, this.user(userId), namespace, key)
      return entry ? publicEntry(entry) : undefined
    }
    self.setUserData = (entry) => setUserData.call(inner, { ...entry, userId: this.user(entry.userId) })
    self.deleteUserData = (userId, namespace, key) => deleteUserData.call(inner, this.user(userId), namespace, key)
    self.listUserData = async (userId, namespace) =>
      (await listUserData.call(inner, this.user(userId), namespace)).map(publicEntry)
    if (purgeExpiredUserData) self.purgeExpiredUserData = (now) => purgeExpiredUserData.call(inner, now)
  }

  private chat(id: ChatId): ChatId { return `${this.prefix}chat|${id}` }
  private user(id: UserId): UserId { return `${this.prefix}user|${id}` }
  private key(kind: string, value: string): string { return `${this.prefix}${kind}|${value}` }
  private owns(value: string, kind: 'chat' | 'user'): boolean {
    return value.startsWith(`${this.prefix}${kind}|`)
  }
  private unprefix(value: string, kind: 'chat' | 'user'): string {
    const prefix = `${this.prefix}${kind}|`
    return value.startsWith(prefix) ? value.slice(prefix.length) : value
  }
  private ref(ref: MessageRef): MessageRef {
    return { ...ref, chatId: this.chat(ref.chatId) }
  }
  private publicRef(ref: MessageRef): MessageRef {
    return { ...ref, chatId: this.unprefix(ref.chatId, 'chat') }
  }
  private metadata() {
    return {
      tenantId: this.namespace.tenantId,
      environmentId: this.namespace.environmentId,
      botId: this.namespace.botId,
      providerId: this.namespace.providerId,
      connectionId: this.namespace.connectionId,
    }
  }

  private storedMessage(message: StoredMessage): StoredMessage {
    return {
      ...message,
      ...this.metadata(),
      ref: this.ref(message.ref),
      chatId: this.chat(message.chatId),
      senderId: message.senderId ? this.user(message.senderId) : undefined,
      quoted: message.quoted ? this.ref(message.quoted) : undefined,
    }
  }

  private publicMessage(message: StoredMessage | undefined): StoredMessage | undefined {
    if (!message) return undefined
    return {
      ...message,
      ref: this.publicRef(message.ref),
      chatId: this.unprefix(message.chatId, 'chat'),
      senderId: message.senderId ? this.unprefix(message.senderId, 'user') : undefined,
      quoted: message.quoted ? this.publicRef(message.quoted) : undefined,
    }
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    await this.innerStore.saveMessage(this.storedMessage(message))
  }
  async getMessage(ref: MessageRef): Promise<StoredMessage | undefined> {
    return this.publicMessage(await this.innerStore.getMessage(this.ref(ref)))
  }
  async getMessagesByChat(chatId: ChatId, limit?: number): Promise<StoredMessage[]> {
    const messages = await this.innerStore.getMessagesByChat(this.chat(chatId), limit)
    return messages.map((message) => this.publicMessage(message)!)
  }
  async deleteMessage(ref: MessageRef): Promise<void> {
    await this.innerStore.deleteMessage(this.ref(ref))
  }

  async upsertChat(chat: StoredChat): Promise<void> {
    await this.innerStore.upsertChat({ ...chat, ...this.metadata(), id: this.chat(chat.id) })
  }
  async getChat(chatId: ChatId): Promise<StoredChat | undefined> {
    const chat = await this.innerStore.getChat(this.chat(chatId))
    return chat ? { ...chat, id: this.unprefix(chat.id, 'chat') } : undefined
  }
  async listChats(): Promise<StoredChat[]> {
    return (await this.innerStore.listChats())
      .filter((chat) => this.owns(chat.id, 'chat'))
      .map((chat) => ({ ...chat, id: this.unprefix(chat.id, 'chat') }))
  }
  async deleteChat(chatId: ChatId): Promise<void> {
    await this.innerStore.deleteChat(this.chat(chatId))
  }

  async upsertContact(contact: StoredContact): Promise<void> {
    await this.innerStore.upsertContact({ ...contact, ...this.metadata(), id: this.user(contact.id) })
  }
  async getContact(userId: UserId): Promise<StoredContact | undefined> {
    const contact = await this.innerStore.getContact(this.user(userId))
    return contact ? { ...contact, id: this.unprefix(contact.id, 'user') } : undefined
  }
  async listContacts(): Promise<StoredContact[]> {
    return (await this.innerStore.listContacts())
      .filter((contact) => this.owns(contact.id, 'user'))
      .map((contact) => ({ ...contact, id: this.unprefix(contact.id, 'user') }))
  }
  async deleteContact(userId: UserId): Promise<void> {
    await this.innerStore.deleteContact(this.user(userId))
  }

  async getCursor(key: string): Promise<string | undefined> {
    return this.innerStore.getCursor?.(this.key('cursor', key))
  }
  async setCursor(key: string, value: string): Promise<void> {
    await this.innerStore.setCursor?.(this.key('cursor', key), value)
  }

  async getConversation(key: string): Promise<AIMessage[] | undefined> {
    return this.innerStore.getConversation(this.key('conversation', key))
  }
  async setConversation(key: string, messages: AIMessage[]): Promise<void> {
    await this.innerStore.setConversation(this.key('conversation', key), messages)
  }
  async clearConversation(key: string): Promise<void> {
    await this.innerStore.clearConversation(this.key('conversation', key))
  }

  async getCheckpoint(key: string): Promise<FlowCheckpoint | undefined> {
    return this.innerStore.getCheckpoint(this.key('checkpoint', key))
  }
  async setCheckpoint(key: string, checkpoint: FlowCheckpoint): Promise<void> {
    await this.innerStore.setCheckpoint(this.key('checkpoint', key), checkpoint)
  }
  async clearCheckpoint(key: string): Promise<void> {
    await this.innerStore.clearCheckpoint(this.key('checkpoint', key))
  }
  async listCheckpoints(): Promise<Array<[string, FlowCheckpoint]>> {
    const prefix = this.key('checkpoint', '')
    return (await this.innerStore.listCheckpoints())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, checkpoint]) => [key.slice(prefix.length), checkpoint])
  }

  async start(): Promise<void> { await this.innerStore.start() }
  async stop(): Promise<void> { await this.innerStore.stop() }
}

type UserDataMethod = 'getUserData' | 'setUserData' | 'deleteUserData' | 'listUserData' | 'purgeExpiredUserData'
