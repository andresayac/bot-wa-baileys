/**
 * Schema validation for waits (`c.ask` / `c.waitText` / `flow().ask(..., { schema })`).
 *
 * Any object exposing a zod-style `safeParse()` works — zod v3/v4, valibot adapters, or a
 * hand-written validator. Core never imports zod: the contract is purely structural.
 *
 * @example
 * ```ts
 * import { z } from 'zod'
 * flow('registro')
 *   .ask('¿Tu edad?', 'edad', { schema: z.coerce.number().min(18, 'Debes ser mayor de edad') })
 *   .say((_ctx, c) => `Tienes ${c.state.edad + 1} el año que viene`)   // c.state.edad: number
 * ```
 */

/** One validation issue, as reported by zod-like libraries. */
export interface SchemaIssueLike {
  message?: string
}

/** Result of {@link SchemaLike.safeParse}: zod's `SafeParseReturnType` shape. */
export type SchemaParseResult<T> =
  | { success: true; data: T }
  | { success: false; error?: { issues?: ReadonlyArray<SchemaIssueLike>; message?: string } | unknown }

/**
 * Structural, zod-compatible schema: anything with `safeParse(input)`. When `safeParseAsync`
 * exists it is preferred (zod schemas with async refinements throw from `safeParse`).
 * `T` is the parsed (output) type stored in `c.state` / returned by `c.ask`.
 */
export interface SchemaLike<T = unknown> {
  safeParse(input: unknown): SchemaParseResult<T> | Promise<SchemaParseResult<T>>
  safeParseAsync?(input: unknown): Promise<SchemaParseResult<T>>
}

/** Output type of a {@link SchemaLike}. */
export type InferSchema<Sch> = Sch extends SchemaLike<infer T> ? T : never

/**
 * Spanish default retry text when a schema rejects an answer without a usable issue
 * message. The runtime now sends the localized `core.wait.invalid` built-in message
 * (`CORE_MESSAGES.waitInvalid`, same Spanish text); kept for compatibility.
 * @deprecated Use `ctx.t(CORE_MESSAGES.waitInvalid)`.
 */
export const DEFAULT_SCHEMA_MESSAGE = '❌ Entrada inválida, intenta de nuevo.'

/** @internal Run a schema; returns the parsed value or the first issue message (if any). */
export async function parseWithSchema<T>(
  schema: SchemaLike<T>,
  input: unknown,
): Promise<{ ok: true; value: T } | { ok: false; message?: string }> {
  const result = typeof schema.safeParseAsync === 'function'
    ? await schema.safeParseAsync(input)
    : await schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  return { ok: false, message: issueMessage(result.error) }
}

function issueMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return typeof error === 'string' && error ? error : undefined
  const issues = (error as { issues?: unknown }).issues
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      const message = (issue as SchemaIssueLike | null)?.message
      if (typeof message === 'string' && message) return message
    }
  }
  const message = (error as { message?: unknown }).message
  // zod v3's ZodError.message is the JSON dump of its issues — never show that to a user.
  if (typeof message === 'string' && message && !message.trimStart().startsWith('[')) return message
  return undefined
}

/** Whether `x` looks like a {@link SchemaLike}. */
export function isSchemaLike(x: unknown): x is SchemaLike {
  return typeof x === 'object' && x !== null && typeof (x as { safeParse?: unknown }).safeParse === 'function'
}
