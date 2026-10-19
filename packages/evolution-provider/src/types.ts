/**
 * @bot-wa/evolution — config + Evolution API v2 wire types (the subset used).
 *
 * Wire shapes are deliberately loose: Evolution relays Baileys' protobuf JSON,
 * which is additive and version-dependent.
 */

import type { Logger } from 'pino'
import type { IdentityPersistence, RestHttpOptions } from '@bot-wa/wa-gateway-kit'

export interface EvolutionProviderConfig {
  /** Evolution API base URL, e.g. `http://localhost:8080`. */
  baseUrl: string
  /** API key sent as the `apikey` header (global key or the instance token). */
  apiKey: string
  /** Instance name (`/message/sendText/{instance}`). */
  instance: string
  /**
   * Static shared secret for webhook ingest. Configure the instance webhook with
   * a custom header (`webhook.headers`) carrying it; `ingest()` accepts it in
   * the {@link webhookSecretHeader} header or as `Authorization: Bearer <secret>`.
   */
  webhookSecret?: string
  /** Header carrying {@link webhookSecret}. Default `x-webhook-secret`. */
  webhookSecretHeader?: string
  /**
   * The `jwt_key` configured in the instance webhook headers. Evolution then
   * sends `Authorization: Bearer <HS256 JWT>` (10 min expiry, `app: 'evolution'`),
   * which `ingest()` verifies.
   */
  webhookJwtKey?: string
  /** Explicit local-development escape hatch: accept webhooks without any check. */
  allowUnsignedWebhooks?: boolean
  /** The connected number's JID; resolved from `/instance/fetchInstances` when omitted. */
  selfId?: string
  /** Network policy for REST calls to the Evolution server. */
  http?: RestHttpOptions
  /** Max aliases kept by the LID↔PN identity map. Default 10 000. */
  identityCacheSize?: number
  /**
   * Durable LID↔PN map (sync read-through + write-on-change). Without it the
   * canonical id of a contact first seen LID-only can differ after a restart;
   * back it with persistent storage to keep `senderId` stable across restarts.
   */
  identityPersistence?: IdentityPersistence
  /** Ask Evolution to transcode inbound audio to MP4 when downloading. Default false. */
  convertAudioToMp4?: boolean
  debug?: boolean
  logger?: Logger
}

/** Baileys message key as Evolution relays it (plus the LID/PN twins newer versions attach). */
export interface EvolutionMessageKey {
  remoteJid?: string
  remoteJidAlt?: string
  fromMe?: boolean
  id?: string
  participant?: string
  participantAlt?: string
  participantPn?: string
  senderPn?: string
  senderLid?: string
  addressingMode?: string
}

export interface EvolutionContextInfo {
  stanzaId?: string
  participant?: string
  quotedMessage?: Record<string, unknown>
  mentionedJid?: string[]
}

/** `data` of a `messages.upsert` webhook. */
export interface EvolutionMessage {
  key: EvolutionMessageKey
  pushName?: string
  message?: Record<string, unknown> & { base64?: string }
  messageType?: string
  messageTimestamp?: number | string | { low?: number }
  contextInfo?: EvolutionContextInfo
  instanceId?: string
  source?: string
  status?: string
}

/** Envelope every Evolution webhook POST carries. */
export interface EvolutionWebhook {
  event: string
  instance?: string
  data?: unknown
  destination?: string
  date_time?: string
  sender?: string
  server_url?: string
  apikey?: string
}

/** Opaque handle stored in `MediaRef.token`. */
export interface EvolutionMediaToken {
  key: EvolutionMessageKey
  /** Present when the instance has `webhookBase64` enabled. */
  base64?: string
}
