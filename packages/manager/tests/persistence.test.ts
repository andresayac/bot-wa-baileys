import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Bot } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'
import {
  BotManager,
  FileBotConfigStore,
  ManagerError,
  MemoryBotConfigStore,
  type BotConfigRecord,
  type BotFactory,
  type FlowDocument,
} from '../src/index.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botwa-manager-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }) })

const record = (over: Partial<BotConfigRecord> = {}): BotConfigRecord => ({
  id: 'a', tenantId: 'acme', desiredState: 'running', version: 1, createdAt: 1, updatedAt: 1, ...over,
})

describe('FileBotConfigStore', () => {
  it('round-trips records grouped by tenant directory', async () => {
    const dir = await tempDir()
    const store = new FileBotConfigStore({ dir })
    await store.put(record())
    await store.put(record({ id: 'b', tenantId: 'beta', provider: { type: 'mock', options: { x: 1 } } }))
    expect(await readdir(join(dir, 'acme'))).toEqual(['a.json'])
    const fresh = new FileBotConfigStore({ dir })
    expect((await fresh.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(await fresh.get('b')).toMatchObject({ tenantId: 'beta', provider: { type: 'mock', options: { x: 1 } } })
    expect(await fresh.delete('a')).toBe(true)
    expect(await fresh.delete('a')).toBe(false)
    expect(await fresh.get('a')).toBeUndefined()
  })

  it('moves the file when the tenant changes', async () => {
    const dir = await tempDir()
    const store = new FileBotConfigStore({ dir })
    await store.put(record())
    await store.put(record({ tenantId: 'other', version: 2 }))
    expect(await readdir(join(dir, 'acme'))).toEqual([])
    expect((await new FileBotConfigStore({ dir }).list())).toHaveLength(1)
  })

  it('rejects unsafe ids (path traversal) and skips corrupt files', async () => {
    const dir = await tempDir()
    const onCorrupt = vi.fn()
    const store = new FileBotConfigStore({ dir, onCorrupt })
    await expect(store.put(record({ id: '../evil' }))).rejects.toBeInstanceOf(ManagerError)
    await expect(store.put(record({ tenantId: '..' }))).rejects.toBeInstanceOf(ManagerError)
    expect(await store.get('../x')).toBeUndefined()
    await mkdir(join(dir, 'acme'), { recursive: true })
    await writeFile(join(dir, 'acme', 'broken.json'), '{nope')
    expect(await new FileBotConfigStore({ dir, onCorrupt }).list()).toEqual([])
    expect(onCorrupt).toHaveBeenCalledTimes(1)
  })
})

interface FakeBot { start(): Promise<void>; stop(): Promise<void>; config: BotConfigRecord; started: boolean }

function fakeFactory(): { factory: BotFactory; built: FakeBot[] } {
  const built: FakeBot[] = []
  const factory: BotFactory = (config) => {
    const bot: FakeBot = {
      config: config as BotConfigRecord,
      started: false,
      async start() { bot.started = true },
      async stop() { bot.started = false },
    }
    built.push(bot)
    return bot
  }
  return { factory, built }
}

const helloFlow: FlowDocument = { version: 1, id: 'hola', trigger: 'hola', steps: [{ kind: 'say', text: 'hola!' }] }

describe('BotManager multi-tenant persistence', () => {
  it('createBot builds through the factory, persists and starts', async () => {
    const store = new MemoryBotConfigStore()
    const { factory, built } = fakeFactory()
    const manager = new BotManager({ factory, configStore: store })
    const status = await manager.createBot({ id: 'acme-1', tenantId: 'acme', name: 'Acme', provider: { type: 'mock' }, meta: { plan: 'pro' } })
    expect(status).toEqual({ id: 'acme-1', running: true, tenantId: 'acme', name: 'Acme', meta: { plan: 'pro' } })
    expect(built[0].config).toMatchObject({ id: 'acme-1', tenantId: 'acme', provider: { type: 'mock' } })
    expect(await store.get('acme-1')).toMatchObject({ desiredState: 'running', version: 1 })
    await expect(manager.createBot({ id: 'acme-1' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(manager.createBot({ id: 'bad/id' })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(manager.createBot({ flows: [{ version: 1 }] })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('needs a factory', async () => {
    await expect(new BotManager().createBot({})).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('stop/start persist the desired state; restore() rebuilds after a restart', async () => {
    const dir = await tempDir()
    const first = fakeFactory()
    const m1 = new BotManager({ factory: first.factory, persistence: { dir } })
    await m1.createBot({ id: 'a', tenantId: 'acme' })
    await m1.createBot({ id: 'b', tenantId: 'beta' })
    await m1.createBot({ id: 'c', tenantId: 'beta', autoStart: false })
    await m1.stop('b')
    await m1.shutdown()
    const saved = JSON.parse(await readFile(join(dir, 'acme', 'a.json'), 'utf8')) as BotConfigRecord
    expect(saved.desiredState).toBe('running')

    const second = fakeFactory()
    const m2 = new BotManager({ factory: second.factory, persistence: { dir } })
    const outcome = await m2.restore()
    expect(outcome).toEqual({ a: 'started', b: 'stopped', c: 'stopped' })
    expect(m2.list().map((s) => [s.id, s.running, s.tenantId]).sort()).toEqual([['a', true, 'acme'], ['b', false, 'beta'], ['c', false, 'beta']])
    expect(m2.listConfigs('beta').map((r) => r.id).sort()).toEqual(['b', 'c'])
  })

  it('restore() reports factory failures per bot without rejecting', async () => {
    const store = new MemoryBotConfigStore()
    await store.put(record({ id: 'ok' }))
    await store.put(record({ id: 'boom' }))
    const manager = new BotManager({
      configStore: store,
      factory: (cfg) => {
        if (cfg.id === 'boom') throw new Error('bad provider')
        return { start: async () => {}, stop: async () => {} }
      },
    })
    const errors: string[] = []
    manager.on('error', ({ id }) => errors.push(id))
    const outcome = await manager.restore()
    expect(outcome.ok).toBe('started')
    expect(outcome.boom).toBeInstanceOf(Error)
    expect(errors).toEqual(['boom'])
  })

  it('updateBot rebuilds on provider change, honours expectedVersion, deleteBot forgets', async () => {
    const store = new MemoryBotConfigStore()
    const { factory, built } = fakeFactory()
    const manager = new BotManager({ factory, configStore: store })
    await manager.createBot({ id: 'a', provider: { type: 'v1' } })
    const updated = await manager.updateBot('a', { provider: { type: 'v2' } }, { expectedVersion: 1 })
    expect(updated.version).toBe(2)
    expect(built).toHaveLength(2)
    expect(built[0].started).toBe(false)
    expect(built[1].started).toBe(true)
    expect(manager.get('a')).toBe(built[1])
    await expect(manager.updateBot('a', { name: 'x' }, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
    const renamed = await manager.updateBot('a', { name: 'Nuevo' })
    expect(built).toHaveLength(2)
    expect(manager.status('a')!.name).toBe('Nuevo')
    expect(renamed.name).toBe('Nuevo')
    await manager.updateBot('a', { desiredState: 'stopped' })
    expect(manager.isRunning('a')).toBe(false)
    expect(await manager.deleteBot('a')).toBe(true)
    expect(await store.get('a')).toBeUndefined()
    expect(manager.has('a')).toBe(false)
    await expect(manager.updateBot('a', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('JSON flows are applied by the factory pipeline and persisted by the flow API', async () => {
    const store = new MemoryBotConfigStore()
    const providers: MockProvider[] = []
    const manager = new BotManager({
      configStore: store,
      factory: () => {
        const provider = new MockProvider()
        providers.push(provider)
        return new Bot({ provider })
      },
    })
    await manager.createBot({ id: 'real', flows: [helloFlow] })
    const bot = manager.get('real') as Bot
    expect(bot.hasFlow('hola')).toBe(true)

    await manager.addFlow('real', { version: 1, id: 'adios', trigger: 'adios', steps: [{ kind: 'say', text: 'bye' }] })
    await expect(manager.addFlow('real', helloFlow)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await store.get('real'))!.flows!.map((f) => f.id)).toEqual(['hola', 'adios'])

    expect(await manager.putFlow('real', 'hola', { ...helloFlow, steps: [{ kind: 'say', text: 'v2' }] })).toEqual({ created: false })
    await expect(manager.putFlow('real', 'otro', helloFlow)).rejects.toMatchObject({ code: 'INVALID' })
    providers[0].incoming('hola')
    await vi.waitFor(() => expect(providers[0].outbox.map((m) => (m.content as { text?: string }).text)).toContain('v2'))

    expect(await manager.removeFlow('real', 'adios')).toBe(true)
    expect(bot.hasFlow('adios')).toBe(false)
    expect(manager.listFlowDocuments('real').map((f) => f.id)).toEqual(['hola'])
    await manager.shutdown()
  })
})
