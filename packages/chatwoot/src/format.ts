/** Text renderings used when mirroring messages into Chatwoot (text only, no uploads). */

import type { MessageContext, OutboundContent } from '@botmesh/core'

/** Render an inbound message as Chatwoot text: the body, or `[type]` for bodiless media. */
export function inboundText(ctx: Pick<MessageContext, 'body' | 'type' | 'isGroup' | 'pushName' | 'senderInfo' | 'sender'>): string {
  const body = ctx.body?.trim() ? ctx.body : `[${ctx.type}]`
  const media = ctx.type !== 'text' && ctx.body?.trim() ? `[${ctx.type}] ${ctx.body}` : body
  if (!ctx.isGroup) return media
  const who = ctx.senderInfo?.displayName ?? ctx.pushName ?? ctx.sender
  return `${who}: ${media}`
}

/** Render outbound bot content as Chatwoot text. */
export function outboundText(content: OutboundContent): string {
  switch (content.kind) {
    case 'text': return content.text
    case 'image':
    case 'video':
    case 'document':
      return content.caption ? `[${content.kind}] ${content.caption}` : `[${content.kind}]`
    case 'audio':
    case 'voice':
    case 'sticker':
      return `[${content.kind}]`
    case 'location':
      return `[location] ${content.lat},${content.lng}${content.name ? ` ${content.name}` : ''}`
    case 'contact':
      return `[contact] ${content.displayName ? `${content.displayName} ` : ''}${content.phone}`
    case 'poll':
      return `${content.question}\n${content.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    case 'reaction':
      return `[reaction] ${content.emoji}`
    case 'buttons':
      return `${content.text}\n${content.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n')}`
    case 'list':
      return `${content.text}\n${content.sections.flatMap((s) => s.rows).map((r, i) => `${i + 1}. ${r.title}`).join('\n')}`
    case 'card':
      return [content.title, content.body].filter(Boolean).join('\n')
    case 'template':
      return `[template] ${content.name}`
    case 'native':
      return `[${content.provider}]`
    case 'form':
      return `[form] ${content.form.title ?? content.form.id}`
  }
}
