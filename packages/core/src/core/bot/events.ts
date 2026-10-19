/**
 * The bot's error / observability outlet. Every lookup on the bot is late-bound
 * (`bot.emit(...)` at call time, never a captured reference), so a `vi.spyOn(bot, 'emit')`
 * or a subclass override installed after construction still sees every event.
 */
import type { Logger } from 'pino'

import type { MetricsCollector } from '../../ops/metrics.js'
import type { MessageContext } from '../types.js'
import type { BotEventSink } from './kernel.js'

/** The slice of the bot the sink needs (the real `Bot`, an `EventEmitter`). */
export interface EventHost {
  emit(event: string, ...args: unknown[]): boolean
  listenerCount(event: string): number
}

export function createEventSink(bot: EventHost, counters: MetricsCollector, logger: () => Logger): BotEventSink {
  const sink: BotEventSink = {
    emit: (event, ...args) => bot.emit(event, ...args),
    listenerCount: (event) => bot.listenerCount(event),
    error(payload: { error: unknown; ctx?: MessageContext }): void {
      counters.error()
      if (bot.listenerCount('error') > 0) bot.emit('error', payload)
      else logger().error({ err: payload.error }, 'unhandled bot error')
    },
    safely(event, payload): void {
      try { bot.emit(event, payload) } catch (error) { sink.error({ error }) }
    },
  }
  return sink
}

/** `DispatcherDeps.emit`: `'error'` goes through the sink (counted, logged when unheard). */
export function dispatcherEmit(sink: BotEventSink): (event: string, payload: unknown) => boolean {
  return (event, payload) => {
    if (event === 'error') {
      sink.error(payload as { error: unknown; ctx?: MessageContext })
      return sink.listenerCount('error') > 0
    }
    return sink.emit(event, payload)
  }
}
