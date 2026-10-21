/**
 * Shared conformance suite for `@bot-wa/tenant-kv`'s `TenantDocs` over a `DurableKv`
 * backend: tenant isolation, hostile tenant ids, insert-if-absent, compare-and-set
 * loss, the update loop under parallel writers, listing order/limit/index and corrupt
 * documents. Every backend a product store can run on (memory, file, SQLite,
 * Postgres, Redis) is expected to pass it.
 *
 * Type-only imports keep this file runtime-dependency-free (vitest is injected by the runner).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DurableKv } from '@bot-wa/core'

/** Structural view of `@bot-wa/tenant-kv` (no runtime or type dependency on the package). */
interface VersionedLike<T> { doc: T; version: string }
interface DocTableLike<T> {
  table: string
  get(id: string): Promise<VersionedLike<T> | undefined>
  insert(id: string, doc: T): Promise<VersionedLike<T> | undefined>
  replace(id: string, version: string, doc: T): Promise<VersionedLike<T> | undefined>
  remove(id: string, version: string): Promise<boolean>
  update(id: string, fn: (current: T | undefined) => T | undefined): Promise<VersionedLike<T> | undefined>
  delete(id: string): Promise<boolean>
  list(options?: { index?: 'all' | 'active'; limit?: number; max?: number }): Promise<T[]>
}
interface TenantDocsLike<T> { in(tenantId: string, ...sub: string[]): DocTableLike<T> }
interface TenantDocsOptionsLike<T> {
  family: readonly string[]
  parse: (value: unknown) => T
  order: (doc: T) => number
  active?: (doc: T) => number | null
  attempts?: number
}

export interface TenantDocsHarness {
  make(): Promise<{ kv: DurableKv; teardown: () => Promise<void> }>
}

interface Counter {
  n: number
  at: number
  open: boolean
}

type TenantDocsCtor = new <T>(kv: DurableKv, opts: TenantDocsOptionsLike<T>) => TenantDocsLike<T>

export interface TenantDocsDeps {
  TenantDocs: TenantDocsCtor
  /** The error class corrupt documents are reported with. */
  CorruptDocumentError: new (...args: never[]) => Error
}

const HOSTILE = ['a/b', '}{', '{durable:inbox}', 'x:y', '*', '..', 'ñandú 🦜', 'a b', '%2F']

function parseCounter(value: unknown): Counter {
  if (typeof value !== 'object' || value === null) throw new TypeError('not an object')
  const v = value as Record<string, unknown>
  if (typeof v.n !== 'number' || typeof v.at !== 'number' || typeof v.open !== 'boolean') throw new TypeError('bad counter')
  return { n: v.n, at: v.at, open: v.open }
}

export function runTenantDocsConformance(name: string, deps: TenantDocsDeps, harness: TenantDocsHarness): void {
  describe(`${name} — TenantDocs conformance`, () => {
    let kv: DurableKv
    let teardown: () => Promise<void>
    let docs: TenantDocsLike<Counter>
    beforeEach(async () => {
      ;({ kv, teardown } = await harness.make())
      docs = new deps.TenantDocs<Counter>(kv, {
        family: ['test', 'counter'],
        parse: parseCounter,
        order: (d) => -d.at,
        active: (d) => (d.open ? -d.at : null),
      })
    })
    afterEach(async () => { await teardown() })

    const c = (n: number, at = n, open = true): Counter => ({ n, at, open })

    it('isolates tenants: the same id in two tenants are two documents', async () => {
      expect(await docs.in('a').insert('x', c(1))).toMatchObject({ doc: c(1) })
      expect(await docs.in('b').insert('x', c(2))).toMatchObject({ doc: c(2) })
      expect((await docs.in('a').get('x'))?.doc).toEqual(c(1))
      expect((await docs.in('b').get('x'))?.doc).toEqual(c(2))
      expect(await docs.in('c').get('x')).toBeUndefined()
      expect(await docs.in('a').list()).toEqual([c(1)])
      expect(await docs.in('b').list()).toEqual([c(2)])
    })

    it('encodes hostile tenant ids and sub-scopes into distinct tables', async () => {
      for (const [i, t] of HOSTILE.entries()) await docs.in(t).insert('x', c(i))
      for (const [i, t] of HOSTILE.entries()) expect((await docs.in(t).get('x'))?.doc).toEqual(c(i))
      expect(await docs.in('a').get('x')).toBeUndefined()
      await docs.in('a', 'sub/1').insert('x', c(7))
      await docs.in('a', 'sub', '1').insert('x', c(8))
      expect((await docs.in('a', 'sub/1').get('x'))?.doc).toEqual(c(7))
      expect((await docs.in('a', 'sub', '1').get('x'))?.doc).toEqual(c(8))
      expect(await docs.in('a').get('x')).toBeUndefined()
      expect(() => docs.in('')).toThrow(TypeError)
    })

    it('insert only writes when absent; replace and remove are compare-and-set', async () => {
      const t = docs.in('a')
      const v1 = (await t.insert('x', c(1)))!
      expect(await t.insert('x', c(9))).toBeUndefined()
      const v2 = (await t.replace('x', v1.version, c(2)))!
      expect(v2.version).not.toBe(v1.version)
      expect(await t.replace('x', v1.version, c(3))).toBeUndefined()
      expect((await t.get('x'))?.doc).toEqual(c(2))
      expect(await t.remove('x', v1.version)).toBe(false)
      expect(await t.remove('x', v2.version)).toBe(true)
      expect(await t.get('x')).toBeUndefined()
      expect(await t.replace('x', v2.version, c(4))).toBeUndefined()
    })

    it('update applies every increment exactly once under 50 parallel writers', async () => {
      const t = docs.in('a')
      await Promise.all(Array.from({ length: 50 }, () => t.update('k', (cur) => (cur ? { ...cur, n: cur.n + 1 } : c(1, 0)))))
      expect((await t.get('k'))?.doc.n).toBe(50)
      // Another tenant's writers never touch it.
      await Promise.all(Array.from({ length: 10 }, () => docs.in('b').update('k', (cur) => (cur ? { ...cur, n: cur.n + 1 } : c(1, 0)))))
      expect((await t.get('k'))?.doc.n).toBe(50)
      expect((await docs.in('b').get('k'))?.doc.n).toBe(10)
    })

    it('update returning undefined leaves the document untouched; delete ignores the version', async () => {
      const t = docs.in('a')
      expect(await t.update('x', () => undefined)).toBeUndefined()
      expect(await t.get('x')).toBeUndefined()
      const v1 = (await t.insert('x', c(1)))!
      const same = await t.update('x', () => undefined)
      expect(same).toEqual(v1)
      expect(await t.delete('x')).toBe(true)
      expect(await t.delete('x')).toBe(false)
    })

    it('lists ascending by score, honours limit and max, and the active index', async () => {
      const t = docs.in('a')
      await t.insert('old', c(1, 10, false))
      await t.insert('mid', c(2, 20, true))
      await t.insert('new', c(3, 30, true))
      // order = -at → most recent first
      expect((await t.list()).map((d) => d.n)).toEqual([3, 2, 1])
      expect((await t.list({ limit: 2 })).map((d) => d.n)).toEqual([3, 2])
      expect(await t.list({ limit: 0 })).toEqual([])
      expect((await t.list({ max: -20 })).map((d) => d.n)).toEqual([3, 2])
      expect((await t.list({ index: 'active' })).map((d) => d.n)).toEqual([3, 2])
      const mid = (await t.get('mid'))!
      await t.replace('mid', mid.version, { ...mid.doc, open: false })
      expect((await t.list({ index: 'active' })).map((d) => d.n)).toEqual([3])
      expect((await t.list()).map((d) => d.n)).toEqual([3, 2, 1])
    })

    it('reports a corrupt or foreign document without exposing its contents', async () => {
      const t = docs.in('a')
      await kv.insert(t.table, 'bad', 'not json', { due: 0, done: null })
      await kv.insert(t.table, 'foreign', '{"something":"else"}', { due: 1, done: null })
      const error = await t.get('bad').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(deps.CorruptDocumentError)
      expect(error).toMatchObject({ table: t.table, id: 'bad' })
      expect((error as Error).message).not.toContain('not json')
      await expect(t.get('foreign')).rejects.toBeInstanceOf(deps.CorruptDocumentError)
      await expect(t.list()).rejects.toBeInstanceOf(deps.CorruptDocumentError)
    })

    it('hands out fresh copies: mutating a read never changes the stored document', async () => {
      const t = docs.in('a')
      const inserted = (await t.insert('x', c(1)))!
      inserted.doc.n = 99
      const read = (await t.get('x'))!
      read.doc.n = 42
      expect((await t.get('x'))?.doc.n).toBe(1)
    })
  })
}
