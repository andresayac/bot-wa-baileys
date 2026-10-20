import { describe, expect, it } from 'vitest'

import { Bot, MemoryKv, type IProvider } from '@bot-wa/core'
import { createTranscript, type Transcript } from '@bot-wa/core/testing'

import {
  DeploymentGateError,
  DeploymentRegistry,
  KvDeploymentStore,
  MemoryDeploymentStore,
  goldenTranscriptGate,
  toJsonValue,
  type DeploymentCandidate,
} from '../src/index.js'

const golden: Transcript = createTranscript([
  { dir: 'in', chatId: '<user:1>', senderId: '<user:1>', type: 'text', text: 'hola' },
  { dir: 'out', chatId: '<user:1>', kind: 'text', text: '¡Hola! Soy el bot de soporte' },
], { name: 'saludo' })

/** Pretend artifacts: each "build" answers `hola` differently. */
const builds: Record<string, string> = {
  'sha:good': '¡Hola! Soy el bot de soporte',
  'sha:bad': 'hola',
}

function botFor(candidate: DeploymentCandidate) {
  return (provider: IProvider) => {
    const bot = new Bot({ provider })
    bot.when('hola', async (ctx) => { await ctx.reply(builds[candidate.artifact] ?? '?') })
    return bot
  }
}

const stores = [
  ['MemoryDeploymentStore', (clock?: () => number) => new DeploymentRegistry(new MemoryDeploymentStore({ ...(clock ? { clock } : {}) }), { ...(clock ? { clock } : {}) })],
  ['KvDeploymentStore', (clock?: () => number) => new DeploymentRegistry(new KvDeploymentStore(new MemoryKv(), { ...(clock ? { clock } : {}) }), { ...(clock ? { clock } : {}) })],
] as const

describe.each(stores)('publish gate over %s', (_name, make) => {
  it('activates the version only when the gate passes, recording the run', async () => {
    const r = make()
    await r.publish('a', 'bot', '1.0.0', 'sha:good')

    const published = await r.publish('a', 'bot', '1.1.0', 'sha:good', { gate: () => ({ ok: true, summary: 'all green', details: { n: 1 } }) })
    expect(published).toMatchObject({ version: '1.1.0', active: true, gate: { passed: true, summary: 'all green', runId: expect.any(String) } })
    expect((await r.active('a', 'bot'))?.version).toBe('1.1.0')
    const runs = await r.gateRuns('a', 'bot', '1.1.0')
    expect(runs).toMatchObject([{ id: published.gate!.runId, version: '1.1.0', artifact: 'sha:good', ok: true, summary: 'all green', details: { n: 1 } }])
    expect(runs[0]!.finishedAt).toBeGreaterThanOrEqual(runs[0]!.startedAt)
  })

  it('rejects a failing gate, keeps the previous active version and persists the failed run', async () => {
    const r = make()
    await r.publish('a', 'bot', '1.0.0', 'sha:good')

    const error = await r.publish('a', 'bot', '2.0.0', 'sha:bad', { gate: () => ({ ok: false, reason: 'golden diff', details: { diffs: 1 } }) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeploymentGateError)
    expect(error).toMatchObject({ candidate: { version: '2.0.0' }, result: { ok: false, reason: 'golden diff' }, runId: expect.any(String) })
    expect((error as Error).message).toContain('golden diff')
    expect((await r.active('a', 'bot'))?.version).toBe('1.0.0')
    expect((await r.list('a', 'bot')).map((d) => d.version)).toEqual(['1.0.0'])
    expect(await r.gateRuns('a', 'bot', '2.0.0')).toMatchObject([{ id: (error as DeploymentGateError).runId, ok: false, reason: 'golden diff', details: { diffs: 1 } }])
    // A rejected version can be fixed and published again; both runs stay auditable.
    await expect(r.publish('a', 'bot', '2.0.0', 'sha:good', { gate: () => true })).resolves.toMatchObject({ active: true })
    expect((await r.gateRuns('a', 'bot', '2.0.0')).map((run) => run.ok)).toEqual([false, true])
  })

  it('accepts boolean gates and wraps gate exceptions (recorded as failed runs)', async () => {
    const r = make()
    await expect(r.publish('a', 'bot', '1', 'x', { gate: async () => false })).rejects.toBeInstanceOf(DeploymentGateError)
    const boom = new Error('replay crashed')
    const error = await r.publish('a', 'bot', '1', 'x', { gate: () => { throw boom } }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeploymentGateError)
    expect((error as Error).cause).toBe(boom)
    expect(await r.list('a', 'bot')).toEqual([])
    expect((await r.gateRuns('a', 'bot', '1')).map((run) => [run.ok, run.reason])).toEqual([[false, undefined], [false, 'replay crashed']])
  })

  it('validates input before running the gate and blocks concurrent duplicates', async () => {
    const r = make()
    let runs = 0
    const gate = () => { runs++; return true }
    await expect(r.publish('a', 'bot', '', 'x', { gate })).rejects.toThrow('version and artifact are required')
    await r.publish('a', 'bot', '1.0.0', 'x')
    await expect(r.publish('a', 'bot', '1.0.0', 'y', { gate })).rejects.toThrow(/already/)
    expect(runs).toBe(0)

    let release!: () => void
    const slow = r.publish('a', 'bot', '2.0.0', 'x', { gate: () => new Promise<boolean>((resolve) => { release = () => resolve(true) }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(r.publish('a', 'bot', '2.0.0', 'x', { gate })).rejects.toThrow(/already/)
    await expect(r.publish('a', 'bot', '2.0.0', 'x')).rejects.toThrow(/already/)
    release()
    await expect(slow).resolves.toMatchObject({ version: '2.0.0', active: true })
  })

  it('activates a gated version when its gate finishes, even if another publish landed meanwhile (last activation wins)', async () => {
    const r = make()
    let release!: () => void
    const slow = r.publish('a', 'bot', '1.0.0', 'x', { gate: () => new Promise<boolean>((resolve) => { release = () => resolve(true) }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await r.publish('a', 'bot', '0.9.0', 'x')
    release()
    await slow
    expect((await r.list('a', 'bot')).filter((d) => d.active).map((d) => d.version)).toEqual(['1.0.0'])
  })

  it('frees a version whose gate never finished once gateTimeoutMs elapses', async () => {
    let now = 1_000
    const r = new DeploymentRegistry(new MemoryDeploymentStore({ clock: () => now }), { clock: () => now, gateTimeoutMs: 500 })
    const stuck = r.publish('a', 'bot', '1.0.0', 'x', { gate: () => new Promise<boolean>(() => {}) })
    void stuck
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(r.publish('a', 'bot', '1.0.0', 'y')).rejects.toThrow(/already/)
    now += 501
    await expect(r.publish('a', 'bot', '1.0.0', 'y')).resolves.toMatchObject({ artifact: 'y', active: true })
  })

  it('truncates oversized gate details without changing the decision', async () => {
    const r = new DeploymentRegistry(new MemoryDeploymentStore(), { maxGateDetailsBytes: 64 })
    const details = { report: 'x'.repeat(1000) }
    await expect(r.publish('a', 'bot', '1', 'x', { gate: () => ({ ok: true, details }) })).resolves.toMatchObject({ active: true })
    const [run] = await r.gateRuns('a', 'bot', '1')
    expect(run).toMatchObject({ ok: true, truncated: true })
    expect(typeof run!.details).toBe('string')
    expect((run!.details as string).length).toBe(64)
    expect(run!.details).toBe(JSON.stringify(details).slice(0, 64))
  })
})

describe('toJsonValue', () => {
  it('projects values to JSON and drops what JSON cannot carry', () => {
    expect(toJsonValue({ a: 1, f: () => 1, u: undefined, d: new Date(0) })).toEqual({ a: 1, d: '1970-01-01T00:00:00.000Z' })
    expect(toJsonValue(undefined)).toBeUndefined()
    expect(toJsonValue(() => 1)).toBeUndefined()
    expect(toJsonValue(10n)).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(toJsonValue(cyclic)).toBeUndefined()
    expect(toJsonValue('text')).toBe('text')
    expect(toJsonValue(null)).toBeNull()
  })
})

describe('goldenTranscriptGate', () => {
  it('publishes when every golden transcript replays cleanly and persists the results', async () => {
    const r = new DeploymentRegistry(new KvDeploymentStore(new MemoryKv()))
    const gate = goldenTranscriptGate({ transcripts: [golden], createBot: botFor })
    await expect(r.publish('acme', 'support', '1.0.0', 'sha:good', { gate })).resolves.toMatchObject({
      active: true,
      gate: { passed: true, summary: '1/1 golden transcript(s) passed' },
    })
    expect(await r.gateRuns('acme', 'support', '1.0.0')).toMatchObject([{ ok: true, details: { results: [{ name: 'saludo', ok: true, diffs: [], report: expect.stringContaining('matches') }] } }])
  })

  it('blocks the publish with the replay diffs when a transcript breaks, keeping the diffs in the run', async () => {
    const r = new DeploymentRegistry(new KvDeploymentStore(new MemoryKv()))
    await r.publish('acme', 'support', '1.0.0', 'sha:good')
    const gate = goldenTranscriptGate({ transcripts: [golden], createBot: botFor })

    const error = await r.publish('acme', 'support', '1.1.0', 'sha:bad', { gate }).catch((e: unknown) => e) as DeploymentGateError
    expect(error).toBeInstanceOf(DeploymentGateError)
    expect(error.message).toContain('transcript "saludo"')
    expect(error.message).toContain('+ actual   text: "hola"')
    const details = error.result.details as { results: Array<{ name: string; ok: boolean }> }
    expect(details.results).toMatchObject([{ name: 'saludo', ok: false }])
    expect((await r.active('acme', 'support'))?.version).toBe('1.0.0')
    const [run] = await r.gateRuns('acme', 'support', '1.1.0')
    expect(run).toMatchObject({ ok: false, artifact: 'sha:bad', details: { results: [{ name: 'saludo', ok: false, diffs: [{ kind: 'mismatch', field: 'text' }] }] } })
    expect((run!.details as { results: Array<{ report: string }> }).results[0]!.report).toContain('actual')
  })

  it('loads transcripts per candidate and passes replay options through', async () => {
    const seen: string[] = []
    const dated = createTranscript([
      { dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'hola' },
      { dir: 'out', chatId: 'u', kind: 'text', text: '¡HOLA! SOY EL BOT DE SOPORTE' },
    ])
    const gate = goldenTranscriptGate({
      transcripts: async (candidate) => { seen.push(candidate.version); return [dated] },
      createBot: botFor,
      replay: { normalizeText: (text) => text.toLowerCase() },
    })
    const r = new DeploymentRegistry()
    await expect(r.publish('a', 'b', '3.0.0', 'sha:good', { gate })).resolves.toMatchObject({ active: true })
    expect(seen).toEqual(['3.0.0'])
  })

  it('refuses to pass with no transcripts unless allowed', async () => {
    const r = new DeploymentRegistry()
    await expect(r.publish('a', 'b', '1', 'sha:good', { gate: goldenTranscriptGate({ transcripts: [], createBot: botFor }) }))
      .rejects.toThrow(/no golden transcripts/)
    await expect(r.publish('a', 'b', '1', 'sha:good', { gate: goldenTranscriptGate({ transcripts: [], createBot: botFor, allowEmpty: true }) }))
      .resolves.toMatchObject({ active: true })
  })

  it('blocks vacuous transcripts (no turns, or no expected replies) unless allowed', async () => {
    const r = new DeploymentRegistry()
    const empty = goldenTranscriptGate({ transcripts: [createTranscript([], { name: 'vacía' })], createBot: botFor })
    const error = await r.publish('a', 'b', '1', 'sha:good', { gate: empty }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeploymentGateError)
    expect((error as Error).message).toMatch(/vacía/)

    const silent = goldenTranscriptGate({
      transcripts: [createTranscript([{ dir: 'in', chatId: 'u', senderId: 'u', type: 'text', text: 'hola' }])],
      createBot: botFor,
    })
    await expect(r.publish('a', 'b', '1', 'sha:good', { gate: silent })).rejects.toBeInstanceOf(DeploymentGateError)
    expect(await r.list('a', 'b')).toEqual([])

    const allowed = goldenTranscriptGate({ transcripts: [createTranscript([])], createBot: botFor, allowEmpty: true })
    await expect(r.publish('a', 'b', '1', 'sha:good', { gate: allowed })).resolves.toMatchObject({ active: true })
  })
})
