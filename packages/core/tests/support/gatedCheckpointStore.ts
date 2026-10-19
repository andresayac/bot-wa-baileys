/**
 * A MemoryStore whose checkpoint writes a test can hold (in flight until released, or
 * forever — a write of a process that died), fail once, or count. Shared by the
 * hand-over tests.
 */
import { MemoryStore } from '../../src/store/MemoryStore.js'
import type { FlowCheckpoint } from '../../src/store/IStore.js'

type Match = (cp: FlowCheckpoint, key: string) => boolean

interface Gate {
  match: Match
  mode: 'hold' | 'fail'
  reached: () => void
  released: Promise<void>
}

export interface HeldWrite {
  /** Resolves once a matching write is in flight. */
  readonly reached: Promise<void>
  /** Let it land. */
  release(): void
}

export class GatedCheckpointStore extends MemoryStore {
  /** Every checkpoint write, in call order (`cp` copied at call time). */
  readonly writes: Array<{ key: string; cp: FlowCheckpoint }> = []
  /** Every checkpoint clear, in call order. */
  readonly clears: string[] = []
  private gates: Gate[] = []

  /** Hold the next write matching `match` until `release()` (never released = the writer died). */
  hold(match: Match): HeldWrite {
    let reached!: () => void
    let release!: () => void
    const reachedP = new Promise<void>((r) => { reached = r })
    const released = new Promise<void>((r) => { release = r })
    this.gates.push({ match, mode: 'hold', reached, released })
    return { reached: reachedP, release }
  }

  /** Fail the next write matching `match` (a store blip). */
  failNext(match: Match): Promise<void> {
    let reached!: () => void
    const reachedP = new Promise<void>((r) => { reached = r })
    this.gates.push({ match, mode: 'fail', reached, released: Promise.resolve() })
    return reachedP
  }

  override async setCheckpoint(key: string, cp: FlowCheckpoint): Promise<void> {
    this.writes.push({ key, cp: structuredClone(cp) })
    const i = this.gates.findIndex((g) => g.match(cp, key))
    if (i >= 0) {
      const [gate] = this.gates.splice(i, 1)
      gate.reached()
      if (gate.mode === 'fail') throw new Error('store unavailable (test)')
      await gate.released
    }
    return super.setCheckpoint(key, cp)
  }

  override async clearCheckpoint(key: string): Promise<void> {
    this.clears.push(key)
    return super.clearCheckpoint(key)
  }

  /** The checkpoint of conversation key `key` (the bot scopes store keys). */
  async checkpointOf(key: string): Promise<FlowCheckpoint | undefined> {
    return (await this.listCheckpoints()).find(([k]) => k === key || k.endsWith(`|${key}`))?.[1]
  }
}
