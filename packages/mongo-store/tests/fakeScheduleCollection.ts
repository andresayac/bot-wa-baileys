/**
 * In-memory fake of a MongoDB collection for the commands MongoScheduleStore sends.
 *
 * It evaluates the filter/update operators the store uses (and throws on any other, so a
 * drifted command fails the tests): equality (with `null` matching a missing field, like
 * MongoDB), `$ne`, `$lte`, `$type: 'string'`, `$or`; `$set`, `$unset`, `$inc`. A duplicate
 * `_id` insert rejects with `{ code: 11000 }`. Each command is atomic, as a single-document
 * write is on the server. Documents are copied in and out.
 */
import type { MongoScheduleCollectionLike, ScheduleDoc } from '../src/schedules.js'

type Doc = Record<string, unknown>

const clone = <T>(d: T): T => structuredClone(d)

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond as Doc)) {
      switch (op) {
        case '$ne':
          if (arg === null ? actual === null || actual === undefined : actual === arg) return false
          break
        case '$lte':
          if (typeof actual !== 'number' || actual > (arg as number)) return false
          break
        case '$type':
          if (arg !== 'string') throw new Error(`fake: unsupported $type ${String(arg)}`)
          if (typeof actual !== 'string') return false
          break
        default:
          throw new Error(`fake: unsupported operator ${op}`)
      }
    }
    return true
  }
  if (cond === null) return actual === null || actual === undefined
  return actual === cond
}

export function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(cond as Doc[]).some((f) => matches(doc, f))) return false
      continue
    }
    if (key.startsWith('$')) throw new Error(`fake: unsupported top-level ${key}`)
    if (!matchValue(doc[key], cond)) return false
  }
  return true
}

function applyUpdate(doc: Doc, update: Doc): void {
  for (const [op, fields] of Object.entries(update)) {
    for (const [k, v] of Object.entries(fields as Doc)) {
      if (op === '$set') doc[k] = v
      else if (op === '$unset') delete doc[k]
      else if (op === '$inc') doc[k] = ((doc[k] as number | undefined) ?? 0) + (v as number)
      else throw new Error(`fake: unsupported update ${op}`)
    }
  }
}

export class FakeScheduleCollection implements MongoScheduleCollectionLike {
  readonly docs = new Map<string, Doc>()
  readonly commands: string[] = []

  private async tick(name: string): Promise<void> {
    this.commands.push(name)
    await Promise.resolve()
  }

  async findOne(filter: Doc): Promise<ScheduleDoc | null> {
    await this.tick('findOne')
    for (const d of this.docs.values()) if (matches(d, filter)) return clone(d) as unknown as ScheduleDoc
    return null
  }

  async insertOne(doc: ScheduleDoc): Promise<unknown> {
    await this.tick('insertOne')
    if (this.docs.has(doc._id)) throw Object.assign(new Error(`E11000 duplicate key error collection: _id: "${doc._id}"`), { code: 11000 })
    this.docs.set(doc._id, clone(doc) as unknown as Doc)
    return { insertedId: doc._id }
  }

  async findOneAndUpdate(filter: Doc, update: Doc, options: { returnDocument: 'after' }): Promise<ScheduleDoc | null> {
    await this.tick('findOneAndUpdate')
    if (options?.returnDocument !== 'after') throw new Error('fake: expected returnDocument after')
    for (const d of this.docs.values()) {
      if (!matches(d, filter)) continue
      applyUpdate(d, update)
      return clone(d) as unknown as ScheduleDoc
    }
    return null
  }

  async updateOne(filter: Doc, update: Doc): Promise<{ matchedCount: number }> {
    await this.tick('updateOne')
    for (const d of this.docs.values()) {
      if (!matches(d, filter)) continue
      applyUpdate(d, update)
      return { matchedCount: 1 }
    }
    return { matchedCount: 0 }
  }

  find(filter: Doc): { toArray(): Promise<ScheduleDoc[]> } {
    return {
      toArray: async () => {
        await this.tick('find')
        return [...this.docs.values()].filter((d) => matches(d, filter)).map((d) => clone(d) as unknown as ScheduleDoc)
      },
    }
  }
}
