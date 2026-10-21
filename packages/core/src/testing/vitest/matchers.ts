/**
 * Vitest matchers over what a bot sent: `toHaveReplied`, `toHaveRepliedMatching` and
 * `toHaveRepliedTimes`. They read a {@link TestChat}, a {@link MockProvider}, an outbox
 * array or a plain `string[]`, run synchronously (waiting is `chat.expectReply`) and
 * depend on nothing from `vitest` itself: the structural context they take is a subset
 * of its `MatcherState`, so `expect.extend(botMatchers)` is all that is needed.
 */

import type { OutboundContent } from '../../core/provider.js'
import { MockProvider, type MockOutgoing } from '../MockProvider.js'
import { textOf, type TestChat } from '../testChat.js'

/** What a bot matcher can receive. */
export type RepliesSource = TestChat | MockProvider | MockOutgoing[] | string[]

/** Structural subset of vitest's `MatcherState` the matchers use (no import from `vitest`). */
export interface BotMatcherContext {
  isNot?: boolean
  utils?: {
    /** Used to render the received replies in failure messages (`JSON.stringify` otherwise). */
    printReceived?(value: unknown): string
  }
}

/** Structural subset of vitest's `ExpectationResult`. */
export interface BotMatcherResult {
  pass: boolean
  message(): string
  actual?: unknown
  expected?: unknown
}

/** A predicate over one reply: its readable text and the full outbound content. */
export type ReplyPredicate = (text: string, content: OutboundContent) => boolean

/** The matchers as `expect(received).toX(...)` sees them (merged into vitest's `Matchers`). */
export interface BotMatchers<R = unknown> {
  /** Some reply's text includes `expected` (string) or matches it (RegExp). */
  toHaveReplied(expected: string | RegExp): R
  /** Some reply satisfies the regexp (on its text) or the predicate (text + full content). */
  toHaveRepliedMatching(matcher: RegExp | ReplyPredicate): R
  /** Exactly `n` replies were sent (every outbound entry counts, text-bearing or not). */
  toHaveRepliedTimes(n: number): R
}

interface Reply {
  text: string
  content: OutboundContent
}

function isOutgoing(value: unknown): value is MockOutgoing {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.chatId === 'string' && typeof v.content === 'object' && v.content !== null
    && typeof (v.content as Record<string, unknown>).kind === 'string'
}

function isTestChat(value: unknown): value is TestChat {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.chatId === 'string' && typeof v.sent === 'function'
}

/** The replies behind a receiver, or `undefined` when it is not a {@link RepliesSource}. */
function repliesOf(received: unknown): Reply[] | undefined {
  if (Array.isArray(received)) {
    if (received.every((item) => typeof item === 'string')) {
      return (received as string[]).map((text) => ({ text, content: { kind: 'text', text } }))
    }
    if (received.every(isOutgoing)) return (received as MockOutgoing[]).map((m) => ({ text: textOf(m), content: m.content }))
    return undefined
  }
  if (received instanceof MockProvider) return received.outbox.map((m) => ({ text: textOf(m), content: m.content }))
  if (isTestChat(received)) return received.sent().map((m) => ({ text: textOf(m), content: m.content }))
  return undefined
}

function printReceived(ctx: BotMatcherContext, value: unknown): string {
  return ctx.utils?.printReceived ? ctx.utils.printReceived(value) : JSON.stringify(value)
}

/** Inline rendering of the expectation (plain, so failure messages stay greppable). */
function printExpected(value: unknown): string {
  if (value instanceof RegExp) return String(value)
  if (typeof value === 'function') return 'the predicate'
  return JSON.stringify(value)
}

function invalid(ctx: BotMatcherContext, name: string, received: unknown): BotMatcherResult {
  return {
    // Never passes: under `.not` a wrong receiver must fail as well.
    pass: ctx.isNot === true,
    message: () => `${name} expects a TestChat, MockProvider, outbox array or string[], got: ${printReceived(ctx, received)}`,
  }
}

function some(
  ctx: BotMatcherContext,
  name: string,
  received: unknown,
  what: string,
  expected: unknown,
  test: (reply: Reply) => boolean,
): BotMatcherResult {
  const replies = repliesOf(received)
  if (!replies) return invalid(ctx, name, received)
  const texts = replies.map((reply) => reply.text)
  const pass = replies.some(test)
  return {
    pass,
    actual: texts,
    expected,
    message: () => pass
      ? `expected no reply ${what} ${printExpected(expected)}, got: ${printReceived(ctx, texts)}`
      : `expected a reply ${what} ${printExpected(expected)}, got: ${printReceived(ctx, texts)}`,
  }
}

/**
 * Pass to `expect.extend(botMatchers)` (in a `setupFiles` entry or at the top of a test
 * file) to get `toHaveReplied`, `toHaveRepliedMatching` and `toHaveRepliedTimes`.
 */
export const botMatchers = {
  toHaveReplied(this: BotMatcherContext, received: unknown, expected: string | RegExp): BotMatcherResult {
    const test = typeof expected === 'string'
      ? (reply: Reply) => reply.text.includes(expected)
      : (reply: Reply) => expected.test(reply.text)
    return some(this, 'toHaveReplied', received, typeof expected === 'string' ? 'including' : 'matching', expected, test)
  },

  toHaveRepliedMatching(this: BotMatcherContext, received: unknown, matcher: RegExp | ReplyPredicate): BotMatcherResult {
    const test = matcher instanceof RegExp
      ? (reply: Reply) => matcher.test(reply.text)
      : (reply: Reply) => matcher(reply.text, reply.content)
    return some(this, 'toHaveRepliedMatching', received, 'matching', matcher, test)
  },

  toHaveRepliedTimes(this: BotMatcherContext, received: unknown, n: number): BotMatcherResult {
    const replies = repliesOf(received)
    if (!replies) return invalid(this, 'toHaveRepliedTimes', received)
    const pass = replies.length === n
    const texts = replies.map((reply) => reply.text)
    return {
      pass,
      actual: replies.length,
      expected: n,
      message: () => pass
        ? `expected not ${n} replies, got ${replies.length}: ${printReceived(this, texts)}`
        : `expected ${n} replies, got ${replies.length}: ${printReceived(this, texts)}`,
    }
  },
}
