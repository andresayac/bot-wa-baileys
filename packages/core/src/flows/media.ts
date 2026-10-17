/**
 * `flow().media(kind, source, caption?, opts?)` — send any media kind from a DSL flow.
 *
 * Maps each kind onto the matching `MessageContext` helper (`photo`, `video`, `audio`,
 * `voice`, `file`, `sticker`, `location`). Kinds whose transports carry no caption
 * (`audio`, `voice`, `sticker`) send the caption as a follow-up text message.
 */

import type { MediaSource } from '../core/provider.js'
import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'
import type { ConversationControls } from '../conversations/controls.js'

/** Kinds accepted by `flow().media()`. `'voice'` is a voice note (PTT). */
export const FLOW_MEDIA_KINDS = ['image', 'video', 'audio', 'voice', 'document', 'sticker', 'location'] as const
export type FlowMediaKind = (typeof FLOW_MEDIA_KINDS)[number]
/** Every kind but `location` (they take a {@link MediaSource}). */
export type FlowFileMediaKind = Exclude<FlowMediaKind, 'location'>

/** A location for `.media('location', …)`. `name` is overridden by the step caption, when given. */
export interface FlowLocation { lat: number; lng: number; name?: string }

/** Per-step media options. */
export interface FlowMediaOptions {
  /** Pause before sending (`'2s'`, `1500`). */
  delay?: string | number
  /** Document file name (`.media('document', …)`). */
  filename?: string
  /** Video as a round video note (PTV). */
  ptv?: boolean
  /** Video played as a looping GIF. */
  gifPlayback?: boolean
  /** Sticker pack / author metadata. */
  pack?: string
  author?: string
}

/** A source computed at runtime from the message and the conversation controls. */
export type DynamicMediaSource<T> = (ctx: RuntimeMessage, c: ConversationControls) => T | Promise<T>

/** What a compiled media step sends. */
export type FlowMediaSource = MediaSource | FlowLocation | DynamicMediaSource<MediaSource | FlowLocation>

const MEDIA_KIND_SET: ReadonlySet<string> = new Set(FLOW_MEDIA_KINDS)

/** Whether `x` names a {@link FlowMediaKind}. */
export function isFlowMediaKind(x: unknown): x is FlowMediaKind {
  return typeof x === 'string' && MEDIA_KIND_SET.has(x)
}

type MediaHelpers = {
  photo?(s: MediaSource, caption?: string): Promise<unknown>
  video?(s: MediaSource, caption?: string, o?: { gifPlayback?: boolean; ptv?: boolean }): Promise<unknown>
  audio?(s: MediaSource): Promise<unknown>
  voice?(s: MediaSource): Promise<unknown>
  file?(s: MediaSource, filename?: string, caption?: string): Promise<unknown>
  sticker?(s: MediaSource, o?: { pack?: string; author?: string }): Promise<unknown>
  location?(lat: number, lng: number, name?: string): Promise<unknown>
}

function helper<K extends keyof MediaHelpers>(ctx: RuntimeMessage, name: K): NonNullable<MediaHelpers[K]> {
  const fn = (ctx as RuntimeMessage & MediaHelpers)[name]
  if (typeof fn !== 'function') {
    throw new TypeError(`flow().media(): this conversation context has no ctx.${name}() — media steps need a Bot message context`)
  }
  return fn.bind(ctx) as NonNullable<MediaHelpers[K]>
}

function isLocation(x: unknown): x is FlowLocation {
  return typeof x === 'object' && x !== null && typeof (x as FlowLocation).lat === 'number' && typeof (x as FlowLocation).lng === 'number'
}

/** @internal Interpreter: send one media step. */
export async function sendFlowMedia(
  ctx: RuntimeMessage,
  c: ConversationControls,
  step: { type: FlowMediaKind; source: FlowMediaSource; caption?: string; opts?: FlowMediaOptions },
): Promise<void> {
  const source = typeof step.source === 'function' ? await step.source(ctx, c) : step.source
  const { caption, opts } = step
  if (step.type === 'location') {
    if (!isLocation(source)) throw new TypeError('flow().media("location", …) needs a { lat, lng } source')
    await helper(ctx, 'location')(source.lat, source.lng, caption ?? source.name)
    return
  }
  if (isLocation(source)) throw new TypeError(`flow().media("${step.type}", …) got a location; use .media("location", …)`)
  const media = source as MediaSource
  switch (step.type) {
    case 'image': await helper(ctx, 'photo')(media, caption); return
    case 'video': await helper(ctx, 'video')(media, caption, { ptv: opts?.ptv, gifPlayback: opts?.gifPlayback }); return
    case 'document': await helper(ctx, 'file')(media, opts?.filename, caption); return
    case 'audio': await helper(ctx, 'audio')(media); break
    case 'voice': await helper(ctx, 'voice')(media); break
    case 'sticker': await helper(ctx, 'sticker')(media, { pack: opts?.pack, author: opts?.author }); break
  }
  // audio / voice / sticker carry no caption on the wire: follow up with a text.
  if (caption) await c.say(caption)
}

/** @internal Introspection: a short, byte-free description of a media source. */
export function describeFlowMediaSource(source: FlowMediaSource, name?: (fn: unknown) => string | undefined): string {
  if (typeof source === 'function') {
    const n = name?.(source)
    return n ? `${n}()` : '(dynamic)'
  }
  if (typeof source === 'string') return source
  if (Buffer.isBuffer(source)) return '(buffer)'
  if (isLocation(source)) return `${source.lat}, ${source.lng}${source.name ? ` (${source.name})` : ''}`
  if ('url' in source && typeof source.url === 'string') return source.url
  if ('path' in source && typeof source.path === 'string') return source.path
  if ('buffer' in source) return '(buffer)'
  if ('stream' in source) return '(stream)'
  return '(media)'
}
