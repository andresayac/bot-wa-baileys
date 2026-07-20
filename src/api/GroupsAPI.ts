/**
 * GroupsAPI — wraps Baileys group management methods.
 *
 * Accessible via `bot.groups`. Create groups, manage members, promote/demote
 * admins, fetch metadata and leave groups.
 *
 * @example
 * ```ts
 * const { id } = await bot.groups.create('My group', ['573001234567@s.whatsapp.net'])
 * await bot.groups.addMember(id, '573009876543@s.whatsapp.net')
 * const admins = await bot.groups.admins(id)
 * await bot.groups.leave(id)
 * ```
 */

import type { makeWASocket } from '@whiskeysockets/baileys'
import type { GroupsAPI, UserId, ChatId } from '../core/types'

type Socket = ReturnType<typeof makeWASocket>

export class GroupsAPIImpl implements GroupsAPI {
  constructor(private getSocket: () => Socket) {}

  async create(name: string, participants: UserId[]): Promise<{ id: string }> {
    const sock = this.getSocket()
    const result = await sock.groupCreate(name, participants)
    const id = ((result as any).id ?? (result as any).gid) as string
    return { id }
  }

  async metadata(groupId: ChatId): Promise<any> {
    return this.getSocket().groupMetadata(groupId)
  }

  async members(groupId: ChatId): Promise<UserId[]> {
    const meta = await this.metadata(groupId)
    return (meta.participants ?? []).map((p: any) => p.id)
  }

  async admins(groupId: ChatId): Promise<UserId[]> {
    const meta = await this.metadata(groupId)
    return (meta.participants ?? [])
      .filter((p: any) => p.admin)
      .map((p: any) => p.id)
  }

  async addMember(groupId: ChatId, userId: UserId | UserId[]): Promise<void> {
    const ids = Array.isArray(userId) ? userId : [userId]
    await this.getSocket().groupParticipantsUpdate(groupId, ids, 'add')
  }

  async removeMember(groupId: ChatId, userId: UserId | UserId[]): Promise<void> {
    const ids = Array.isArray(userId) ? userId : [userId]
    await this.getSocket().groupParticipantsUpdate(groupId, ids, 'remove')
  }

  async promote(groupId: ChatId, userId: UserId | UserId[]): Promise<void> {
    const ids = Array.isArray(userId) ? userId : [userId]
    await this.getSocket().groupParticipantsUpdate(groupId, ids, 'promote')
  }

  async demote(groupId: ChatId, userId: UserId | UserId[]): Promise<void> {
    const ids = Array.isArray(userId) ? userId : [userId]
    await this.getSocket().groupParticipantsUpdate(groupId, ids, 'demote')
  }

  async leave(groupId: ChatId): Promise<void> {
    await this.getSocket().groupLeave(groupId)
  }

  async setName(groupId: ChatId, name: string): Promise<void> {
    await this.getSocket().groupUpdateSubject(groupId, name)
  }

  async setDescription(groupId: ChatId, desc: string): Promise<void> {
    await this.getSocket().groupUpdateDescription(groupId, desc)
  }

  async setSetting(groupId: ChatId, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'): Promise<void> {
    await this.getSocket().groupSettingUpdate(groupId, setting)
  }

  async inviteLink(groupId: ChatId): Promise<string> {
    const code = await this.getSocket().groupInviteCode(groupId)
    return `https://chat.whatsapp.com/${code}`
  }

  async revokeInviteLink(groupId: ChatId): Promise<string> {
    const code = await this.getSocket().groupRevokeInvite(groupId)
    return `https://chat.whatsapp.com/${code}`
  }

  async join(inviteCode: string): Promise<string> {
    // Strip prefix if passed a full URL
    const code = inviteCode.replace(/^https?:\/\/chat\.whatsapp\.com\//, '')
    return (await this.getSocket().groupAcceptInvite(code)) as string
  }

  async infoFromInvite(inviteCode: string): Promise<any> {
    const code = inviteCode.replace(/^https?:\/\/chat\.whatsapp\.com\//, '')
    return this.getSocket().groupGetInviteInfo(code)
  }
  async listAll(): Promise<Record<string, any>> {
    return this.getSocket().groupFetchAllParticipating()
  }

  async setEphemeral(groupId: ChatId, seconds: 0 | 86400 | 604800 | 7776000): Promise<void> {
    await this.getSocket().groupToggleEphemeral(groupId, seconds)
  }

  async setMemberAddMode(groupId: ChatId, mode: 'all_member_add' | 'admin_add'): Promise<void> {
    await this.getSocket().groupMemberAddMode(groupId, mode)
  }

  async listJoinRequests(groupId: ChatId): Promise<any[]> {
    return this.getSocket().groupRequestParticipantsList(groupId)
  }

  async resolveJoinRequests(groupId: ChatId, userIds: UserId[], action: 'approve' | 'reject'): Promise<any> {
    return this.getSocket().groupRequestParticipantsUpdate(groupId, userIds, action)
  }
}
