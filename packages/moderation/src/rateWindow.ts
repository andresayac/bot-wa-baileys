/**
 * Sliding-window message counter per key (chat + sender). Memory-bounded:
 * timestamps older than the window are dropped on every hit, and idle keys
 * are swept once the map grows past `sweepAt` entries.
 */
export class RateWindow {
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly sweepAt = 10_000) {}

  /** Record a hit at `now` and return how many hits fall inside `windowMs`. */
  hit(key: string, now: number, windowMs: number): number {
    const from = now - windowMs
    const list = (this.hits.get(key) ?? []).filter((t) => t > from)
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > this.sweepAt) this.sweep(now, windowMs)
    return list.length
  }

  /** Forget a key's hits (after a violation, so one burst triggers one action). */
  reset(key: string): void {
    this.hits.delete(key)
  }

  /** Forget every key starting with `prefix`. */
  resetPrefix(prefix: string): void {
    for (const key of this.hits.keys()) if (key.startsWith(prefix)) this.hits.delete(key)
  }

  get size(): number {
    return this.hits.size
  }

  private sweep(now: number, windowMs: number): void {
    for (const [key, list] of this.hits) {
      if (list.length === 0 || list[list.length - 1] <= now - windowMs) this.hits.delete(key)
    }
  }
}
