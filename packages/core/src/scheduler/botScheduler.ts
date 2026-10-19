/**
 * Builds the bot's {@link Scheduler} from `BotConfig.scheduler` (internal). Durable task
 * ids and the leader lease key are scoped by the bot's store namespace, so bots sharing
 * one schedule backend never collide.
 */

import type { StoreNamespace } from '../store/NamespacedStore.js'
import type { DurableSchedulerOptions } from './durable.js'
import type { SchedulerOptions } from './ScheduleStore.js'
import { Scheduler } from './Scheduler.js'

/** The namespace prefix, encoded as `NamespacedStore` encodes its keys. */
export function scheduleScope(ns: StoreNamespace): string {
  return Object.values(ns).map(encodeURIComponent).join('|') + '|'
}

export function createBotScheduler(opts: SchedulerOptions, ns: StoreNamespace): Scheduler {
  const scoped: DurableSchedulerOptions = { ...opts, scope: scheduleScope(ns) }
  return new Scheduler(scoped)
}
