/**
 * PresenceAPI — broadcast own presence & subscribe to contact presence.
 */

import type { makeWASocket } from '@whiskeysockets/baileys'
import type { PresenceAPI, ChatId } from '../core/types.js'

type Socket = ReturnType<typeof makeWASocket>

export class PresenceAPIImpl implements PresenceAPI {
  constructor(private getSocket: () => Socket) {}

  async update(state: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused', chatId?: ChatId): Promise<void> {
    await this.getSocket().sendPresenceUpdate(state, chatId)
  }

  async subscribe(chatId: ChatId): Promise<void> {
    await this.getSocket().presenceSubscribe(chatId)
  }
}
