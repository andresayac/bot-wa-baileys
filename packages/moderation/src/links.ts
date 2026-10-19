/**
 * Link and invite-link detection over message TEXT (never over ids).
 *
 * Group invite links are recognized for WhatsApp (`chat.whatsapp.com/<code>`),
 * Telegram (`t.me/+<code>`, `t.me/joinchat/<code>`) and Discord
 * (`discord.gg/<code>`, `discord.com/invite/<code>`). Extra patterns can be
 * supplied by the caller; the first capture group is taken as the invite code.
 */

/** A group invite link found in a message. */
export interface InviteLink {
  /** `'whatsapp' | 'telegram' | 'discord'`, or `'custom'` for caller-supplied patterns. */
  platform: string
  /** The invite code (first capture group). */
  code: string
  /** The matched text. */
  url: string
}

const INVITE_PATTERNS: Array<{ platform: string; re: RegExp }> = [
  { platform: 'whatsapp', re: /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{6,})/gi },
  { platform: 'telegram', re: /(?:https?:\/\/)?(?:t|telegram)\.me\/(?:joinchat\/|\+)([\w-]{4,})/gi },
  { platform: 'discord', re: /(?:https?:\/\/)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]{2,})/gi },
]

/** Find every group invite link in `text` (built-in platforms plus `extra` patterns). */
export function findInviteLinks(text: string, extra: readonly RegExp[] = []): InviteLink[] {
  const out: InviteLink[] = []
  for (const { platform, re } of INVITE_PATTERNS) collect(text, re, platform, out)
  for (const re of extra) collect(text, re, 'custom', out)
  return out
}

function collect(text: string, re: RegExp, platform: string, out: InviteLink[]): void {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  for (const m of text.matchAll(global)) {
    out.push({ platform, code: m[1] ?? m[0], url: m[0] })
  }
}

/**
 * Scheme links (`http://…`, `https://…`) and bare `www.` links. Bare
 * `domain.tld` words are NOT treated as links to avoid false positives on
 * ordinary text like `hola.que`.
 */
const LINK_RE = /\b(?:https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi
/** Bare-host invite domains are links too, even without a scheme. */
const BARE_INVITE_RE = /\b(?:chat\.whatsapp\.com|t\.me|telegram\.me|discord\.gg|discord(?:app)?\.com)\/[^\s<>"']*/gi

/** Every link-like token in `text` (scheme links, `www.` links and bare invite hosts). */
export function findLinks(text: string): string[] {
  const seen = new Set<string>()
  // Spans of scheme/www links, in text order: a bare invite inside one of them is
  // part of that link. Both scans run left to right, so one pointer keeps this linear
  // (comparing every bare match with every link was O(n²) on a crafted body).
  const spans: Array<[start: number, end: number]> = []
  for (const m of text.matchAll(LINK_RE)) {
    seen.add(m[0])
    spans.push([m.index, m.index + m[0].length])
  }
  let span = 0
  for (const m of text.matchAll(BARE_INVITE_RE)) {
    while (span < spans.length && spans[span]![1] <= m.index) span++
    const inside = span < spans.length && spans[span]![0] <= m.index
    if (!inside) seen.add(m[0])
  }
  return [...seen]
}

/** Lower-cased hostname of a link token, or `undefined` when it cannot be parsed. */
export function linkHost(link: string): string | undefined {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`)
    return url.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\.+/, '')
  return host === d || host.endsWith(`.${d}`)
}

/**
 * Normalize `allowInvites` entries to the set of allowed invite codes. An
 * entry may be a bare code (`'ABC123'`) or a full invite link with or without
 * scheme (`'https://chat.whatsapp.com/ABC123'`); for a link, its code is used,
 * so the same invite matches however it is typed.
 */
export function allowedInviteCodes(entries: readonly string[], extra: readonly RegExp[] = []): Set<string> {
  const codes = new Set<string>()
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry) continue
    const invites = findInviteLinks(entry, extra)
    if (invites.length > 0) for (const invite of invites) codes.add(invite.code)
    else codes.add(entry)
  }
  return codes
}

/**
 * True when `link` IS an allowed invite link: it starts with an invite (so its
 * host is the invite host) whose code is exactly an allowed code. An allowed
 * code that merely appears somewhere in another URL (query string, path) does
 * not whitelist that URL.
 */
export function isAllowedInviteLink(link: string, allowed: ReadonlySet<string>, extra: readonly RegExp[] = []): boolean {
  if (allowed.size === 0) return false
  const lower = link.toLowerCase()
  return findInviteLinks(link, extra).some(
    (invite) => allowed.has(invite.code) && lower.startsWith(invite.url.toLowerCase()),
  )
}
