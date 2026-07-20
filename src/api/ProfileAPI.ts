/**
 * ProfileAPI — manage profile info (your own & others).
 *
 * Accessible via `bot.profile`. Set name/status/photo, fetch profile pictures.
 *
 * @example
 * ```ts
 * await bot.profile.setName('My Bot')
 * await bot.profile.setStatus('online')
 * await bot.profile.setPhoto('https://example.com/avatar.png')
 * const url = await bot.profile.getPhoto('573001234567@s.whatsapp.net')
 * ```
 */

import type { makeWASocket, AuthenticationCreds } from '@whiskeysockets/baileys'
import type { ProfileAPI, MediaSource, UserId } from '../core/types.js'
import { toMediaUpload } from '../media/MediaProcessor.js'

type Socket = ReturnType<typeof makeWASocket>

export class ProfileAPIImpl implements ProfileAPI {
  constructor(
    private getSocket: () => Socket,
    private getAuthCreds: () => AuthenticationCreds
  ) {}

  async setName(name: string): Promise<void> {
    await this.getSocket().updateProfileName(name)
  }

  async setStatus(text: string): Promise<void> {
    await this.getSocket().updateProfileStatus(text)
  }

  async setPhoto(source: MediaSource): Promise<void> {
    const creds = this.getAuthCreds()
    await this.getSocket().updateProfilePicture(creds.me?.id ?? '', toMediaUpload(source) as any)
  }

  async removePhoto(): Promise<void> {
    const creds = this.getAuthCreds()
    await this.getSocket().removeProfilePicture(creds.me?.id ?? '')
  }

  async getPhoto(userId: UserId, highRes = false): Promise<string | null> {
    try {
      return (await this.getSocket().profilePictureUrl(userId, highRes ? 'image' : 'preview')) ?? null
    } catch {
      return null
    }
  }

  async getStatus(userId: UserId): Promise<string> {
    try {
      const status = await this.getSocket().fetchStatus(userId)
      return (status as any)?.status ?? ''
    } catch {
      return ''
    }
  }

  async getBusiness(userId: UserId): Promise<any> {
    return this.getSocket().getBusinessProfile(userId)
  }

  getMe(): { id: UserId; name?: string; pushName?: string } {
    const creds = this.getAuthCreds()
    return {
      id: creds.me?.id ?? '',
      name: (creds.me as any)?.name,
      pushName: (creds.me as any)?.notify,
    }
  }
}
