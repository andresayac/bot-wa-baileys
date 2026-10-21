/**
 * @botmesh/email — email transport (IMAP IDLE inbound + SMTP outbound) for @botmesh/core.
 */

export { EmailProvider } from './EmailProvider.js'
export type { EmailIngestResult, EmailSkipReason } from './EmailProvider.js'
export type {
  EmailLoopProtectionOptions,
  EmailMediaToken,
  EmailProviderConfig,
  EmailRaw,
  ImapClientLike,
  ImapConnectionOptions,
  ImapFetchedMessage,
  ImapMailboxLock,
  SmtpAttachment,
  SmtpConnectionOptions,
  SmtpMailOptions,
  SmtpSendInfo,
  SmtpTransportLike,
} from './types.js'

export { normalizeAddress, parseAddressList } from './address.js'
export type { EmailAddress } from './address.js'
export { parseEmail, decodeEncodedWords } from './mime.js'
export type { ParsedEmail, ParsedAttachment, MimePart } from './mime.js'
export { htmlToText } from './html.js'
export { stripQuotedReply } from './reply.js'
export { detectAutomated, SenderFloodGuard } from './loop.js'
export type { AutomatedReason, FloodGuardOptions } from './loop.js'
export { detectBounce } from './bounce.js'
export type { BounceInfo, BounceRecipient } from './bounce.js'
export { toEmailProviderError } from './errors.js'
export { baseSubject, cursorThreadStore, MemoryThreadStore } from './threading.js'
export type { EmailMailboxCursor, EmailThreadingMode, EmailThreadState, EmailThreadStore, MemoryThreadStoreOptions } from './threading.js'
