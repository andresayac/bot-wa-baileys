/**
 * Durable media references (opt-in with `BotConfig.durability`).
 *
 * A `MediaRef.token` is a provider-internal handle and is often a live object (a Baileys
 * `WAMessage`). The durable inbox replaces it in the journal with a {@link StoredMediaToken}
 * marker that holds the provider's {@link SerializedMediaRef}; a replay asks the provider
 * to rebuild the live token (`IProvider.rehydrateMediaRef`). When that is impossible the
 * replayed message still runs, and only its media download rejects with
 * {@link MediaUnavailableError}.
 *
 * The core never reads the provider's data: it is an opaque, versioned JSON value.
 */

import type { JsonValue } from '../testing/transcripts/format.js'
import { ProviderError, type MediaRef } from './provider.js'

/**
 * What a provider writes for one `MediaRef` (`IProvider.serializeMediaRef`): JSON-safe,
 * versioned, provider-defined. It is read back from storage, so the provider must treat
 * it as UNTRUSTED in `rehydrateMediaRef` and validate it.
 */
export interface SerializedMediaRef {
  /** Provider-defined format version; a provider rejects versions it does not know. */
  v: number
  /** Provider-defined data. Never include credentials. */
  data: JsonValue
}

/**
 * The journaled marker that replaces `media.token` in a durable inbox record (internal shape,
 * documented for operators reading the journal).
 */
export interface StoredMediaToken {
  $botwaMedia: 1
  /** `IProvider.id` that wrote it; another provider never rehydrates it. */
  provider: string
  /** Absent: the provider declined to serialize this ref (the media is not durable). */
  ref?: SerializedMediaRef
}

/**
 * Why replayed media cannot be downloaded again:
 * - `'not-durable'`: the provider did not serialize the reference (e.g. Baileys view-once media);
 * - `'provider-mismatch'`: the record was journaled by another provider;
 * - `'rehydrate-failed'`: the provider could not rebuild the reference (invalid, unknown
 *   version, tampered), or it has no `rehydrateMediaRef` (any more).
 */
export type MediaUnavailableReason = 'not-durable' | 'provider-mismatch' | 'rehydrate-failed'

/**
 * The media of a replayed message (durable inbox) cannot be downloaded again. Rejected by
 * `loadMediaOf(ctx, { throwOnError: true })`. Extends {@link ProviderError}, so existing
 * `instanceof ProviderError` checks still match.
 */
export class MediaUnavailableError extends ProviderError {
  constructor(readonly reason: MediaUnavailableReason, message?: string) {
    super(message ?? `Media of a replayed message is not available (${reason})`)
    this.name = 'MediaUnavailableError'
  }
}

const UNAVAILABLE = Symbol('botwa.mediaUnavailable')

/** `token` is a journaled {@link StoredMediaToken} marker (shape check only). */
export function isStoredMediaToken(token: unknown): token is StoredMediaToken {
  if (typeof token !== 'object' || token === null) return false
  const t = token as Record<string, unknown>
  return t.$botwaMedia === 1 && typeof t.provider === 'string'
}

/** A frozen token that makes the download guard reject with `MediaUnavailableError(reason)`. */
export function unavailableMediaToken(reason: MediaUnavailableReason): object {
  return Object.freeze({ [UNAVAILABLE]: reason })
}

function unavailableReason(token: unknown): MediaUnavailableReason | undefined {
  if (typeof token !== 'object' || token === null) return undefined
  return (token as { [UNAVAILABLE]?: MediaUnavailableReason })[UNAVAILABLE]
}

type Download = (ref: MediaRef) => Promise<Buffer | NodeJS.ReadableStream>

/**
 * Wrap a provider download so an unavailable replayed token rejects with
 * {@link MediaUnavailableError} before it reaches the provider. Any other token is passed
 * through unchanged; `undefined` stays `undefined` (no downloader).
 */
export function guardDownload(download: Download | undefined): Download | undefined {
  if (!download) return undefined
  return (ref) => {
    const reason = unavailableReason(ref?.token)
    return reason ? Promise.reject(new MediaUnavailableError(reason)) : download(ref)
  }
}
