import { ProviderError } from '@bot-wa/core'

/**
 * Lazily import an optional peer dependency (`imapflow`, `nodemailer`) with an
 * actionable error when it is not installed. Never import these at top level.
 */
export async function loadModule<T = unknown>(name: string, purpose: string): Promise<T> {
  try {
    return (await import(name)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ProviderError(
      `@bot-wa/email needs the optional peer dependency "${name}" for ${purpose}. ` +
        `Install it with \`pnpm add ${name}\` (${detail})`,
    )
  }
}
