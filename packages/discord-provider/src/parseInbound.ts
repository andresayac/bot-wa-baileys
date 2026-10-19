/**
 * parseInbound — turn Discord gateway DISPATCH frames into normalized
 * {@link InboundEvent}s. Identity is the Discord user snowflake (`author.id` /
 * `member.user.id`): stable, no member-vs-user aliasing leaks out.
 *
 *   MESSAGE_CREATE     → kind 'message'   (bots are ignored)
 *   INTERACTION_CREATE → kind 'interaction' (button / select / slash command)
 */

import type {
  InboundEvent,
  InboundInteraction,
  InboundMessage,
  MediaRef,
  MessageType,
} from '@bot-wa/core'
import {
  ComponentType,
  InteractionType,
  type DiscordInteractionPayload,
  type DiscordMessagePayload,
} from './types.js'

const DISCORD_EPOCH = 1_420_070_400_000n

/** Epoch ms encoded in a snowflake id (Discord's timestamp extraction). */
export function snowflakeTimestamp(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
  } catch {
    return Date.now()
  }
}

/** Parse one DISPATCH frame; undefined for events we don't normalize. */
export function parseDispatch(t: string, d: unknown, selfId?: string | null): InboundEvent | undefined {
  switch (t) {
    case 'MESSAGE_CREATE':
      return parseMessageCreate(d as DiscordMessagePayload, selfId)
    case 'INTERACTION_CREATE':
      return parseInteractionCreate(d as DiscordInteractionPayload)
    default:
      return undefined
  }
}

/* --- MESSAGE_CREATE -------------------------------------------------------- */

function describeContent(d: DiscordMessagePayload): { type: MessageType; body: string; media?: MediaRef } {
  const body = d.content ?? ''
  const att = d.attachments?.[0]
  if (!att) return { type: 'text', body }
  const mime = att.content_type ?? ''
  const type: MessageType =
    mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : 'document'
  return {
    type,
    body,
    media: {
      kind: type as MediaRef['kind'],
      mimetype: att.content_type,
      filename: att.filename,
      size: att.size,
      token: att.url,
    },
  }
}

/** ISO `timestamp` of the message, else the time encoded in its snowflake id. */
function messageTimestamp(d: DiscordMessagePayload): number {
  const parsed = d.timestamp ? Date.parse(d.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : snowflakeTimestamp(d.id)
}

function parseMessageCreate(d: DiscordMessagePayload, selfId?: string | null): InboundEvent | undefined {
  if (!d?.author || d.author.bot) return undefined // ignore own + other bots

  const chatId = d.channel_id
  const isGroup = Boolean(d.guild_id)
  const { type, body, media } = describeContent(d)

  const message: InboundMessage<DiscordMessagePayload> = {
    ref: { id: d.id, chatId, native: d },
    chat: {
      id: chatId,
      kind: isGroup ? 'group' : 'dm',
      isGroup,
      isBroadcast: false,
      ...(d.guild_id ? { platformData: { guildId: d.guild_id } } : {}),
    },
    senderInfo: {
      id: d.author.id,
      username: d.author.username,
      displayName: d.member?.nick ?? d.author.global_name ?? d.author.username,
      isBot: d.author.bot,
    },
    from: chatId,
    sender: d.author.id,
    chatId,
    senderId: d.author.id,
    isGroup,
    isBroadcast: false,
    fromMe: Boolean(selfId && d.author.id === selfId),
    type,
    body,
    timestamp: messageTimestamp(d),
    mentions: (d.mentions ?? []).map((m) => m.id),
    media,
    raw: d,
  }

  if (d.message_reference?.message_id) {
    message.quoted = {
      ref: { id: d.message_reference.message_id, chatId: d.message_reference.channel_id ?? chatId },
      body: d.referenced_message?.content,
      senderId: d.referenced_message?.author?.id,
    }
  }

  return { kind: 'message', message }
}

/* --- INTERACTION_CREATE ---------------------------------------------------- */

function parseInteractionCreate(d: DiscordInteractionPayload): InboundEvent | undefined {
  if (!d?.id || !d.token) return undefined
  const user = d.member?.user ?? d.user
  if (!user || user.bot) return undefined

  // Newer payloads also carry the partial `channel` object; without either
  // there is no chat to route to (never emit an empty chatId).
  const chatId = d.channel_id ?? d.channel?.id
  if (!chatId) return undefined
  const isGroup = Boolean(d.guild_id)
  const timestamp = snowflakeTimestamp(d.id)

  let kind: InboundInteraction['kind']
  let data = ''
  switch (d.type) {
    case InteractionType.ApplicationCommand:
      kind = 'command'
      data = d.data?.name ?? ''
      break
    case InteractionType.MessageComponent:
      if (d.data?.component_type === ComponentType.StringSelect) {
        // A choose()/list menu answers with the selected option value (the row id).
        kind = 'list'
        data = d.data.values?.[0] ?? d.data.custom_id ?? ''
      } else {
        kind = 'button'
        data = d.data?.custom_id ?? ''
      }
      break
    case InteractionType.ModalSubmit:
      kind = 'modal'
      data = d.data?.custom_id ?? ''
      break
    case InteractionType.ApplicationCommandAutocomplete:
      kind = 'autocomplete'
      data = d.data?.name ?? ''
      break
    default:
      return undefined // Ping etc. — internal to the gateway/REST layer
  }

  const interaction: InboundInteraction<DiscordInteractionPayload> = {
    // `<id>:<token>` — acknowledgeInteraction splits it back to POST the callback.
    interactionId: `${d.id}:${d.token}`,
    ref: { id: d.message?.id ?? d.id, chatId, native: d },
    chat: { id: chatId, kind: isGroup ? 'group' : 'dm', isGroup, isBroadcast: false },
    senderInfo: {
      id: user.id,
      username: user.username,
      displayName: d.member?.nick ?? user.global_name ?? user.username,
      isBot: user.bot,
    },
    from: chatId,
    sender: user.id,
    chatId,
    senderId: user.id,
    isGroup,
    kind,
    data,
    // Discord requires an interaction response within ~3s.
    respondBy: timestamp + 3_000,
    timestamp,
    raw: d,
  }
  return { kind: 'interaction', interaction }
}
