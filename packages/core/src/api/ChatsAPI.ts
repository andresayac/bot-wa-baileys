/**
 * ChatsAPI — archive, mute, pin, star, delete, markRead.
 *
 * Accessible via `bot.chats`. chatModify-based operations require the LAST
 * message known by your store.
 *
 * @example
 * ```ts
 * await bot.chats.archive(chatId)
 * await bot.chats.mute(chatId, 24 * 60 * 60_000)  // mute 24h
 * await bot.chats.pin(chatId)
 * await bot.chats.markRead(chatId)
 * ```
 */

import type { makeWASocket, WAMessageKey } from '@whiskeysockets/baileys'
import type { ChatsAPI, ChatId } from '../core/types.js'
import type { IStore } from '../store/IStore.js'

type Socket = ReturnType<typeof makeWASocket>

export class ChatsAPIImpl implements ChatsAPI {
  constructor(
    private getSocket: () => Socket,
    private store: IStore
  ) {}

  async archive(chatId: ChatId, archive = true): Promise<void> {
    const last = await this.lastMessage(chatId)
    await this.getSocket().chatModify({ archive, lastMessages: last ? [last] : [] }, chatId)
  }

  async mute(chatId: ChatId, ms: number | null): Promise<void> {
    await this.getSocket().chatModify({ mute: ms }, chatId)
  }

  async pin(chatId: ChatId, pin = true): Promise<void> {
    await this.getSocket().chatModify({ pin }, chatId)
  }

  async unpin(chatId: ChatId): Promise<void> {
    await this.pin(chatId, false)
  }

  async star(messageKeys: WAMessageKey[], star = true): Promise<void> {
    if (!messageKeys.length) return
    const chatId = messageKeys[0].remoteJid!
    await this.getSocket().chatModify(
      {
        star: {
          messages: messageKeys.map((k) => ({ id: k.id!, fromMe: !!k.fromMe })),
          star,
        },
      },
      chatId
    )
  }

  async delete(chatId: ChatId): Promise<void> {
    const last = await this.lastMessage(chatId)
    await this.getSocket().chatModify(
      {
        delete: true,
        lastMessages: last
          ? [{ key: last.key, messageTimestamp: last.messageTimestamp }]
          : [],
      },
      chatId
    )
    await this.store.deleteChat(chatId)
  }

  async clear(chatId: ChatId, messageKeys: WAMessageKey[]): Promise<void> {
    await this.getSocket().chatModify(
      {
        clear: {
          messages: messageKeys.map((k) => ({
            id: k.id!,
            fromMe: !!k.fromMe,
            timestamp: String(Date.now()),
          })),
        },
      } as any,
      chatId
    )
    for (const k of messageKeys) await this.store.deleteMessage(k)
  }

  async markRead(_chatId: ChatId, messageKeys: WAMessageKey[]): Promise<void> {
    await this.getSocket().readMessages(messageKeys)
  }

  async list(): Promise<any[]> {
    return this.store.listChats()
  }

  private async lastMessage(chatId: ChatId) {
    const list = await this.store.getMessagesByChat(chatId, 1)
    return list[0]
  }
}
