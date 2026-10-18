/**
 * Strip the quoted history and signature from a reply, so a bot sees only what
 * the human just wrote ("Sí, gracias") instead of the whole thread.
 *
 * Heuristic, by design: it cuts at the first attribution line ("On … wrote:",
 * "El … escribió:", Outlook's "From:/Sent:" block or separator, "-----Original
 * Message-----") and then drops trailing `>`-quoted lines and an RFC 3676
 * signature ("-- "). The untouched text is always available on `raw.text`.
 */

const ATTRIBUTION: RegExp[] = [
  /^On\b.{0,300}\bwrote:\s*$/i,
  /^El\b.{0,300}\bescribi[oó]:\s*$/i,
  /^Em\b.{0,300}\bescreveu:\s*$/i,
  /^Le\b.{0,300}\ba écrit\s*:\s*$/i,
  /^Am\b.{0,300}\bschrieb.{0,60}:\s*$/i,
  /^Il giorno\b.{0,300}\bha scritto:\s*$/i,
  /^-{2,}\s*(Original Message|Mensaje original|Message d'origine|Ursprüngliche Nachricht|Mensagem original)\s*-{2,}\s*$/i,
  /^-{2,}\s*(Forwarded message|Mensaje reenviado)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
]

const OUTLOOK_HEADER = /^(From|De|Von):\s.+/i
const OUTLOOK_FOLLOW = /^(Sent|Date|Enviado|Fecha|Gesendet|To|Para|Subject|Asunto):\s/i

function cutIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (ATTRIBUTION.some((re) => re.test(line))) return i
    // Attribution wrapped over two lines ("El mar, 14 oct … <x>\nescribió:").
    const next = lines[i + 1]?.trim()
    if (next !== undefined && line && ATTRIBUTION.some((re) => re.test(`${line} ${next}`))) return i
    if (OUTLOOK_HEADER.test(line) && OUTLOOK_FOLLOW.test(lines[i + 1]?.trim() ?? '') && i > 0) return i
  }
  return -1
}

/** Return the new content of a reply (quoted history and signature removed). */
export function stripQuotedReply(text: string): string {
  let lines = text.replace(/\r\n?/g, '\n').split('\n')
  const cut = cutIndex(lines)
  if (cut !== -1) lines = lines.slice(0, cut)
  const sig = lines.findIndex((l) => l === '-- ' || l === '--')
  if (sig !== -1) lines = lines.slice(0, sig)
  while (lines.length && (lines[lines.length - 1]!.trim() === '' || lines[lines.length - 1]!.trimStart().startsWith('>'))) lines.pop()
  return lines.join('\n').trim()
}
