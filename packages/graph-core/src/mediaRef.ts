/**
 * Durable media references for transports whose `MediaRef.token` is a hosted attachment URL
 * (Messenger, Instagram): the URL is journaled as `{ v: 1, data: { url } }` and accepted back
 * only when it passes the provider's host allow-list. No credentials are stored (the Graph
 * attachment URLs are signed by Meta and fetched without the access token).
 */

import { ProviderError, type MediaRef, type SerializedMediaRef } from '@botmesh/core'

/** Hosts (and their subdomains) that serve Messenger / Instagram attachment URLs. */
export const META_MEDIA_HOSTS: readonly string[] = Object.freeze(['fbcdn.net', 'fbsbx.com', 'cdninstagram.com'])

/** The URL check a provider applies (e.g. `isAllowedHostUrl` of `@botmesh/http`). */
export type MediaUrlCheck = (url: string) => boolean

/** `{ v: 1, data: { url } }` for an allowed URL token; `undefined` otherwise (not durable). */
export function serializeUrlMediaRef(ref: MediaRef, allowed: MediaUrlCheck): SerializedMediaRef | undefined {
  return typeof ref.token === 'string' && allowed(ref.token) ? { v: 1, data: { url: ref.token } } : undefined
}

/**
 * Rebuild a URL token journaled by {@link serializeUrlMediaRef}. The stored value is untrusted.
 * @throws {ProviderError} on an invalid, unknown-version or disallowed value.
 */
export function rehydrateUrlMediaRef(stored: SerializedMediaRef, ref: Omit<MediaRef, 'token'>, allowed: MediaUrlCheck, label: string): MediaRef {
  const data = stored?.data as { url?: unknown } | null | undefined
  const url = stored?.v === 1 && data !== null && typeof data === 'object' && !Array.isArray(data) ? data.url : undefined
  if (typeof url !== 'string' || !allowed(url)) throw new ProviderError(`Invalid ${label} media reference`)
  return { ...ref, token: url }
}
