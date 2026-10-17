import { describe, expect, it } from 'vitest'

import { Bot, type IProvider } from '@bot-wa/core'
import { createTranscript, type Transcript } from '@bot-wa/core/testing'

import { DeploymentGateError, DeploymentRegistry, goldenTranscriptGate, type DeploymentCandidate } from '../src/index.js'

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

describe('publish gate', () => {
  it('activates the version only when the gate passes', async () => {
    const r = new DeploymentRegistry()
    r.publish('a', 'bot', '1.0.0', 'sha:good')

    const published = await r.publish('a', 'bot', '1.1.0', 'sha:good', { gate: () => ({ ok: true, summary: 'all green' }) })
    expect(published).toMatchObject({ version: '1.1.0', active: true, gate: { passed: true, summary: 'all green' } })
    expect(r.active('a', 'bot')?.version).toBe('1.1.0')
  })

  it('rejects a failing gate and keeps the previous active version', async () => {
    const r = new DeploymentRegistry()
    r.publish('a', 'bot', '1.0.0', 'sha:good')

    const error = await r.publish('a', 'bot', '2.0.0', 'sha:bad', { gate: () => ({ ok: false, reason: 'golden diff' }) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeploymentGateError)
    expect(error).toMatchObject({ candidate: { version: '2.0.0' }, result: { ok: false, reason: 'golden diff' } })
    expect((error as Error).message).toContain('golden diff')
    expect(r.active('a', 'bot')?.version).toBe('1.0.0')
    expect(r.list('a', 'bot').map((d) => d.version)).toEqual(['1.0.0'])
    // A rejected version can be fixed and published again.
    await expect(r.publish('a', 'bot', '2.0.0', 'sha:good', { gate: () => true })).resolves.toMatchObject({ active: true })
  })

  it('accepts boolean gates and wraps gate exceptions', async () => {
    const r = new DeploymentRegistry()
    await expect(r.publish('a', 'bot', '1', 'x', { gate: async () => false })).rejects.toBeInstanceOf(DeploymentGateError)
    const boom = new Error('replay crashed')
    const error = await r.publish('a', 'bot', '1', 'x', { gate: () => { throw boom } }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeploymentGateError)
    expect((error as Error).cause).toBe(boom)
    expect(r.list('a', 'bot')).toEqual([])
  })

  it('validates input before running the gate and blocks concurrent duplicates', async () => {
    const r = new DeploymentRegistry()
    let runs = 0
    const gate = () => { runs++; return true }
    await expect(r.publish('a', 'bot', '', 'x', { gate })).rejects.toThrow('version and artifact are required')
    r.publish('a', 'bot', '1.0.0', 'x')
    await expect(r.publish('a', 'bot', '1.0.0', 'y', { gate })).rejects.toThrow(/already/)
    expect(runs).toBe(0)

    let release!: () => void
    const slow = r.publish('a', 'bot', '2.0.0', 'x', { gate: () => new Promise<boolean>((resolve) => { release = () => resolve(true) }) })
    await expect(r.publish('a', 'bot', '2.0.0', 'x', { gate })).rejects.toThrow(/already/)
    expect(() => r.publish('a', 'bot', '2.0.0', 'x')).toThrow(/already/)
    release()
    await expect(slow).resolves.toMatchObject({ version: '2.0.0', active: true })
  })

  it('activates a gated version when its gate finishes, even if another publish landed meanwhile (last activation wins)', async () => {
    const r = new DeploymentRegistry()
    let release!: () => void
    const slow = r.publish('a', 'bot', '1.0.0', 'x', { gate: () => new Promise<boolean>((resolve) => { release = () => resolve(true) }) })
    r.publish('a', 'bot', '0.9.0', 'x')
    release()
    await slow
    expect(r.list('a', 'bot').filter((d) => d.active).map((d) => d.version)).toEqual(['1.0.0'])
  })
})

describe('goldenTranscriptGate', () => {
  it('publishes when every golden transcript replays cleanly', async () => {
    const r = new DeploymentRegistry()
    const gate = goldenTranscriptGate({ transcripts: [golden], createBot: botFor })
    await expect(r.publish('acme', 'support', '1.0.0', 'sha:good', { gate })).resolves.toMatchObject({
      active: true,
      gate: { passed: true, summary: '1/1 golden transcript(s) passed' },
    })
  })

  it('blocks the publish with the replay diffs when a transcript breaks', async () => {
    const r = new DeploymentRegistry()
    r.publish('acme', 'support', '1.0.0', 'sha:good')
    const gate = goldenTranscriptGate({ transcripts: [golden], createBot: botFor })

    const error = await r.publish('acme', 'support', '1.1.0', 'sha:bad', { gate }).catch((e: unknown) => e) as DeploymentGateError
    expect(error).toBeInstanceOf(DeploymentGateError)
    expect(error.message).toContain('transcript "saludo"')
    expect(error.message).toContain('+ actual   text: "hola"')
    const details = error.result.details as { results: Array<{ name: string; ok: boolean }> }
    expect(details.results).toMatchObject([{ name: 'saludo', ok: false }])
    expect(r.active('acme', 'support')?.version).toBe('1.0.0')
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
})
