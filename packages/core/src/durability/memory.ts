import { KvDurability } from './journal.js'
import { MemoryKv } from './kv.js'

/**
 * In-process durability backend — the default of `BotConfig.durability` and the
 * reference implementation of the journal contract.
 *
 * It gives retries, backoff, the dead-letter queue and idempotent sends within one
 * process, but everything it holds is lost when the process dies: use
 * `FileDurability` (single process) or a store-backed backend
 * (`@bot-wa/postgres-store`, `@bot-wa/redis-store`) to survive a crash.
 */
export class MemoryDurability extends KvDurability {
  constructor() { super(new MemoryKv(), { exclusive: true }) }
}
