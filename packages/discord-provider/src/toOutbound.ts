/**
 * toOutbound — map a transport-neutral {@link OutboundContent} to a Discord
 * REST "Create Message" JSON payload (+ optional resolved file for multipart).
 *
 * Media is resolved by the provider BEFORE this is called (MediaSource →
 * bytes). Discord uploads are multipart: the provider appends `files[0]` plus
 * `payload_json` (the object returned here, with `attachments[0]` referencing
 * the file id `0`).
 *
 * Routes this can't express (reactions go to PUT .../reactions/{emoji}/@me) are
 * handled directly by DiscordProvider; `template` is unsupported on Discord.
 */

import { UnsupportedContentError, type OutboundContent } from '@bot-wa/core'

/** A resolved file ready to append as `files[n]` on the multipart request. */
export interface DiscordFile {
  name: string
  buffer: Buffer
  contentType?: string
}

export interface DiscordOutboundPayload {
  /** JSON body — or the `payload_json` part when `files` is present. */
  payload: Record<string, unknown>
  /** Files to upload alongside the payload (multipart). */
  files?: DiscordFile[]
}

function mediaPayload(content: OutboundContent & { caption?: string }, file: DiscordFile | undefined): DiscordOutboundPayload {
  if (!file) {
    throw new UnsupportedContentError(content.kind, 'Discord media requires resolved bytes (MediaSource → DiscordFile) — pass them via DiscordProvider.send.')
  }
  const attachment: Record<string, unknown> = { id: 0, filename: file.name }
  if (content.caption) attachment.description = content.caption
  return {
    payload: {
      ...(content.caption ? { content: content.caption } : {}),
      attachments: [attachment],
    },
    files: [file],
  }
}

function buttonRow(buttons: Array<{ id: string; title: string; url?: string }>): Array<Record<string, unknown>> {
  return buttons.slice(0, 5).map((b) =>
    b.url
      ? { type: 2, style: 5, label: b.title.slice(0, 80), url: b.url }
      : { type: 2, style: 1, label: b.title.slice(0, 80), custom_id: b.id.slice(0, 100) },
  )
}

/** Map neutral content → Discord Create-Message payload (+ files when media). */
export function toOutbound(content: OutboundContent, file?: DiscordFile): DiscordOutboundPayload {
  switch (content.kind) {
    case 'text':
      return { payload: { content: content.text } }

    case 'image':
    case 'video':
    case 'audio':
    case 'voice':
    case 'document':
    case 'sticker':
      return mediaPayload(content, file)

    case 'buttons':
      return {
        payload: {
          content: content.text,
          components: [{ type: 1, components: buttonRow(content.buttons) }],
        },
      }

    case 'list': {
      const options = content.sections
        .flatMap((s) => s.rows)
        .slice(0, 25)
        .map((r) => ({
          label: r.title.slice(0, 100),
          value: r.id.slice(0, 100),
          ...(r.description ? { description: r.description.slice(0, 100) } : {}),
        }))
      const customId = (content.buttonText || 'select').slice(0, 100)
      return {
        payload: {
          content: content.text,
          components: [{
            type: 1,
            components: [{ type: 3, custom_id: customId, placeholder: content.buttonText.slice(0, 150), options }],
          }],
        },
      }
    }

    case 'card': {
      const embed: Record<string, unknown> = { title: content.title.slice(0, 256) }
      if (content.body) embed.description = content.body.slice(0, 4096)
      if (content.imageUrl) embed.image = { url: content.imageUrl }
      const payload: Record<string, unknown> = { embeds: [embed] }
      if (content.buttons?.length) {
        payload.components = [{ type: 1, components: buttonRow(content.buttons) }]
      }
      return { payload }
    }

    case 'poll':
      return {
        payload: {
          poll: {
            question: { text: content.question.slice(0, 300) },
            answers: content.options.slice(0, 10).map((o) => ({ poll_media: { text: o.slice(0, 55) } })),
            duration: 24,
            allow_multiselect: content.multiSelect ?? false,
          },
        },
      }

    case 'reaction':
      throw new UnsupportedContentError('reaction', 'Reactions use the PUT .../reactions route — DiscordProvider.send handles this kind directly.')

    case 'location':
      // Explicit degradation: Discord has no location primitive.
      return {
        payload: {
          content: [
            content.name,
            `https://maps.google.com/?q=${content.lat},${content.lng}`,
            content.address,
          ].filter(Boolean).join('\n'),
        },
      }

    case 'contact':
      // Explicit degradation: Discord has no contact primitive.
      return { payload: { content: `📇 ${content.displayName ?? content.phone}\n${content.phone}` } }

    case 'template':
      throw new UnsupportedContentError('template', 'Discord has no template messages.')

    case 'native':
      return { payload: content.payload as Record<string, unknown> }
  }
}
