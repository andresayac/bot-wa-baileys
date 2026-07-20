/**
 * PrivacyAPI — block, lastSeen, read receipts, profile picture, etc.
 */

import type { makeWASocket } from '@whiskeysockets/baileys'
import type { PrivacyAPI, UserId } from '../core/types.js'

type Socket = ReturnType<typeof makeWASocket>

export class PrivacyAPIImpl implements PrivacyAPI {
  constructor(private getSocket: () => Socket) {}

  async block(userId: UserId): Promise<void> {
    await this.getSocket().updateBlockStatus(userId, 'block')
  }

  async unblock(userId: UserId): Promise<void> {
    await this.getSocket().updateBlockStatus(userId, 'unblock')
  }

  async listBlocked(): Promise<UserId[]> {
    try {
      const list = await this.getSocket().fetchBlocklist()
      return list as unknown as UserId[]
    } catch {
      return []
    }
  }

  async setLastSeen(visibility: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<void> {
    await this.getSocket().updateLastSeenPrivacy(visibility)
  }

  async setOnline(visibility: 'all' | 'match_last_seen'): Promise<void> {
    await this.getSocket().updateOnlinePrivacy(visibility)
  }

  async setProfilePicture(visibility: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<void> {
    await this.getSocket().updateProfilePicturePrivacy(visibility)
  }

  async setStatus(visibility: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<void> {
    await this.getSocket().updateStatusPrivacy(visibility)
  }

  async setReadReceipts(visibility: 'all' | 'none'): Promise<void> {
    await this.getSocket().updateReadReceiptsPrivacy(visibility)
  }

  async setGroupsAdd(visibility: 'all' | 'contacts' | 'contact_blacklist'): Promise<void> {
    await this.getSocket().updateGroupsAddPrivacy(visibility)
  }

  async setDefaultDisappearing(seconds: 0 | 86400 | 604800 | 7776000): Promise<void> {
    await this.getSocket().updateDefaultDisappearingMode(seconds)
  }
}
