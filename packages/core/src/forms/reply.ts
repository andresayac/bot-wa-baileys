/**
 * Wire format of a native form submission on an inbound message of type `'form'`.
 * Providers build the body with {@link formReplyBody}; the core reads it back with
 * {@link parseFormReply}. Keeping it a plain JSON body means the message flows
 * through dedupe, hooks, stores and the conversation runtime unchanged.
 */

import { randomBytes } from 'node:crypto'
import type { FormReply } from './types.js'

/** Fresh, unguessable correlation token for one native form message (`<formId>.<random>`). */
export function newFormToken(formId: string): string {
  return `${formId}.${randomBytes(9).toString('base64url')}`
}

/** Serialize a normalized submission into the `body` of a `'form'` inbound message. */
export function formReplyBody(reply: FormReply): string {
  return JSON.stringify(reply.token === undefined ? { values: reply.values } : { token: reply.token, values: reply.values })
}

/** Parse the `body` of a `'form'` inbound message; `undefined` when it is not a form reply. */
export function parseFormReply(body: string): FormReply | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { token, values } = parsed as { token?: unknown; values?: unknown }
  if (!values || typeof values !== 'object' || Array.isArray(values)) return undefined
  return typeof token === 'string' ? { token, values: values as Record<string, unknown> } : { values: values as Record<string, unknown> }
}
