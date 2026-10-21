/**
 * `@botmesh/core/testing/vitest` — vitest matchers for bots (`toHaveReplied`,
 * `toHaveRepliedMatching`, `toHaveRepliedTimes`) plus the type augmentation that
 * makes them visible on `expect(...)`. `vitest` is an optional peer: this module
 * never imports it at runtime (the `declare module` below is type-only), so the
 * subpath loads in a project without vitest and the augmentation only applies
 * where vitest's types are present.
 *
 * @example
 * ```ts
 * import { expect } from 'vitest'
 * import { botMatchers } from '@botmesh/core/testing/vitest'
 * expect.extend(botMatchers)          // once (a setupFiles entry) or per test file
 * expect(chat).toHaveReplied(/hola/)
 * ```
 *
 * @packageDocumentation
 */

// Types only (kept in the .d.ts, nothing at runtime): brings vitest's types into the
// program so the `declare module` below augments them instead of failing to resolve.
/// <reference types="vitest" preserve="true" />
import type { BotMatchers } from './matchers.js'

export { botMatchers } from './matchers.js'
export type { BotMatchers, BotMatcherContext, BotMatcherResult, RepliesSource, ReplyPredicate } from './matchers.js'

declare module 'vitest' {
  interface Matchers<T> extends BotMatchers<T> {}
}
