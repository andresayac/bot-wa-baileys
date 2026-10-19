/**
 * Durable media references in the inbox journal (internal).
 *
 * On admit, a message's `media.token` (a provider-internal, possibly live handle) is replaced
 * in the JOURNALED copy by a {@link StoredMediaToken} marker holding the provider's
 * serialized reference; the live event keeps its token. On replay, the marker is turned back
 * into a live token by the provider, or into a sentinel the download guard rejects with
 * `MediaUnavailableError`. A media failure never fails the inbound record.
 *
 * Without a provider hook (or with `durability.inbox.mediaRefs: false`) nothing here runs and
 * the journal holds exactly what `encodeInbound` produced before.
 */

import type { InboundEvent, IProvider, MediaRef } from '../core/provider.js'
import {
  isStoredMediaToken, unavailableMediaToken, type MediaUnavailableReason, type SerializedMediaRef, type StoredMediaToken,
} from '../core/mediaRefs.js'
import { encodedSize, encodeInbound, encodeJson } from './codec.js'
import type { JsonValue } from './types.js'

/** Serialized references larger than this are not journaled (the media is then not durable). */
const MAX_REF_BYTES = 64 * 1024

interface LoggerLike {
  debug(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

/** The provider hooks the engine uses (bound to one provider). */
export interface InboundMediaCodec {
  providerId: string
  /** Absent: journal media tokens as before (no hook, or `inbox.mediaRefs: false`). */
  serialize?(ref: MediaRef): SerializedMediaRef | undefined
  rehydrate?(stored: SerializedMediaRef, ref: Omit<MediaRef, 'token'>): MediaRef | Promise<MediaRef>
}

/**
 * The codec of `provider`, or `undefined` when it has neither hook. `serialize` is left out when
 * `enabled` is false (records are written as before, but markers already journaled still replay).
 */
export function providerMediaCodec(provider: IProvider, enabled = true): InboundMediaCodec | undefined {
  const canSerialize = typeof provider.serializeMediaRef === 'function'
  const canRehydrate = typeof provider.rehydrateMediaRef === 'function'
  if (!canSerialize && !canRehydrate) return undefined
  return {
    providerId: provider.id,
    ...(enabled && canSerialize ? { serialize: (ref: MediaRef) => provider.serializeMediaRef!(ref) } : {}),
    ...(canRehydrate ? { rehydrate: (s: SerializedMediaRef, ref: Omit<MediaRef, 'token'>) => provider.rehydrateMediaRef!(s, ref) } : {}),
  }
}

function serializedRef(codec: InboundMediaCodec, media: MediaRef, log: LoggerLike): SerializedMediaRef | undefined {
  let out: SerializedMediaRef | undefined
  try { out = codec.serialize!(media) } catch (error) {
    log.debug({ provider: codec.providerId, err: { name: (error as Error)?.name } }, 'serializeMediaRef threw: media not durable')
    return undefined
  }
  if (out === undefined || out === null || typeof out !== 'object' || !Number.isInteger(out.v)) return undefined
  const data = encodeJson(out.data)
  if (data === undefined) return undefined
  const ref: SerializedMediaRef = { v: out.v, data }
  if (encodedSize(ref as unknown as JsonValue) > MAX_REF_BYTES) {
    log.debug({ provider: codec.providerId }, 'serialized media reference too large: media not durable')
    return undefined
  }
  return ref
}

/**
 * The journaled form of `event`: as {@link encodeInbound}, with the media token replaced by a
 * {@link StoredMediaToken} when the codec can serialize. `event` itself is never mutated.
 */
export function encodeInboundWithMedia(event: InboundEvent, codec: InboundMediaCodec | undefined, log: LoggerLike): JsonValue | undefined {
  if (!codec?.serialize || event.kind !== 'message' || !event.message.media) return encodeInbound(event)
  const media = event.message.media
  const ref = serializedRef(codec, media, log)
  const marker: StoredMediaToken = { $botwaMedia: 1, provider: codec.providerId, ...(ref ? { ref } : {}) }
  return encodeInbound({ kind: 'message', message: { ...event.message, media: { ...media, token: marker } } })
}

/** The replayed event carries a media marker that must be rehydrated before it runs. */
export function hasStoredMedia(event: InboundEvent): boolean {
  return event.kind === 'message' && isStoredMediaToken(event.message.media?.token)
}

/**
 * Turn a replayed event's media marker back into a live token (provider hook), or into an
 * unavailable sentinel. Never rejects: a failure only makes the media download reject.
 */
export async function rehydrateInbound(event: InboundEvent, codec: InboundMediaCodec | undefined, log: LoggerLike): Promise<InboundEvent> {
  if (event.kind !== 'message' || !event.message.media) return event
  const { token, ...rest } = event.message.media
  if (!isStoredMediaToken(token)) return event
  const withToken = (next: MediaRef): InboundEvent => ({ kind: 'message', message: { ...event.message, media: next } })
  const unavailable = (reason: MediaUnavailableReason) => withToken({ ...rest, token: unavailableMediaToken(reason) })

  if (codec && token.provider !== codec.providerId) return unavailable('provider-mismatch')
  if (!token.ref) return unavailable('not-durable')
  if (!codec?.rehydrate) return unavailable('rehydrate-failed')
  try {
    const rebuilt = await codec.rehydrate(token.ref, rest)
    if (!rebuilt || typeof rebuilt !== 'object' || rebuilt.token === undefined || rebuilt.token === null) {
      throw new TypeError('rehydrateMediaRef returned no token')
    }
    return withToken({ ...rest, ...rebuilt })
  } catch (error) {
    log.warn({ provider: codec.providerId, err: { name: (error as Error)?.name } }, 'replayed media reference could not be rehydrated')
    return unavailable('rehydrate-failed')
  }
}
