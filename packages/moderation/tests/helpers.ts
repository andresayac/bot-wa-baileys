import { Bot, type MessageRef } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'

/** MockProvider with the optional moderation capabilities (delete + group admin). */
export class AdminMockProvider extends MockProvider {
  deleted: MessageRef[] = []
  kicked: Array<{ chatId: string; userIds: string[] }> = []
  admins: Record<string, string[]> = {}
  adminLookups = 0

  // A property (not a method): MockProvider declares deleteMessage as an optional property.
  override deleteMessage?: (ref: MessageRef) => Promise<void> = async (ref) => {
    this.deleted.push(ref)
  }

  groups = {
    removeParticipants: async (chatId: string, userIds: string[]) => {
      this.kicked.push({ chatId, userIds })
    },
    getAdmins: async (chatId: string) => {
      this.adminLookups++
      return this.admins[chatId] ?? []
    },
  }
}

export async function startBot<P extends MockProvider>(provider: P): Promise<Bot> {
  const bot = new Bot({ provider })
  await bot.start()
  return bot
}

/** Let the per-chat queue, hooks and async actions settle. */
export const flush = () => new Promise((r) => setTimeout(r, 15))

export function groupMsg(provider: MockProvider, text: string, sender = 'u1', group = 'g1', pushName = 'Ana'): void {
  provider.incoming(text, { from: group, sender, isGroup: true, pushName })
}

export function textsTo(provider: MockProvider, chatId: string): string[] {
  return provider.outbox
    .filter((m) => m.chatId === chatId && m.content.kind === 'text')
    .map((m) => (m.content.kind === 'text' ? m.content.text : ''))
}
