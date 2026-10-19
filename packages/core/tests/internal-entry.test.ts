import { describe, expect, it } from 'vitest'

import * as main from '../src/index.js'
import * as internal from '../src/internal.js'

/** The engine internals moved to `@bot-wa/core/internal` (deferred item 1 of docs/api-review.md). */
const INTERNAL_NAMES = [
  'buildMessageContext', 'createControls', 'createPacer', 'runBroadcast', 'runFormStep',
  'newFormToken', 'resolveFormMode', 'resolveReplyTyping', 'normalizeTypingConfig',
  'typingDuration', 'parseReplyDelay', 'ExternalSendClock', 'MetricsCollector',
  'formatUptime', 'TYPING_REFRESH_MS',
] as const

describe('@bot-wa/core/internal', () => {
  it('exports exactly the engine internals', () => {
    expect(Object.keys(internal).sort()).toEqual([...INTERNAL_NAMES].sort())
  })

  it('the main entry still re-exports each one as the very same value (deprecated until v3)', () => {
    for (const name of INTERNAL_NAMES) {
      expect(internal[name], name).toBeDefined()
      expect((main as Record<string, unknown>)[name], name).toBe(internal[name])
    }
  })

  it('a class imported from either entry is the same class', () => {
    const collector = new main.MetricsCollector()
    expect(collector).toBeInstanceOf(internal.MetricsCollector)
    expect(new internal.ExternalSendClock()).toBeInstanceOf(main.ExternalSendClock)
  })
})
