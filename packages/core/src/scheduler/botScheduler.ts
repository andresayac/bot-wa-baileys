/**
 * Builds the bot's {@link Scheduler} from `BotConfig.scheduler` (internal). Durable task
 * ids and the leader lease key are scoped by the bot's store namespace, so bots sharing
 * one schedule backend never collide.
 */

import type { StoreNamespace } from '../store/NamespacedStore.js'
import type { DurableSchedulerOptions } from './durable.js'
import type { SchedulerOptions } from './ScheduleStore.js'
import { Scheduler } from './Scheduler.js'
import type { Coordinator } from '../coordination/types.js'

/** The namespace prefix, encoded as `NamespacedStore` encodes its keys. */
export function scheduleScope(ns: StoreNamespace): string {
  return Object.values(ns).map(encodeURIComponent).join('|') + '|'
}

/**
 * `coordinator` (from `BotConfig.coordination`) becomes the leadership backend when
 * `opts.lease` is not set, so a multi-replica bot needs one coordination backend only.
 */
export function createBotScheduler(opts: SchedulerOptions, ns: StoreNamespace, coordinator?: Coordinator): Scheduler {
  const scoped: DurableSchedulerOptions = { ...opts, scope: scheduleScope(ns) }
  if (scoped.lease === undefined && coordinator) scoped.lease = coordinator
  return new Scheduler(scoped)
}
