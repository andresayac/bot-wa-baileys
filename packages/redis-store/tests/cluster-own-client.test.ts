/**
 * Own cluster client creation (`cluster` option) — node-redis mocked, no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const created: Array<{ options: Record<string, unknown>; client: MockCluster }> = []

class MockCluster {
  masters: unknown[] = []
  isOpen = false
  listeners = new Map<string, (err: unknown) => void>()
  quitCalls = 0
  constructor(readonly options: Record<string, unknown>) {}
  nodeClient(): unknown { return {} }
  on(event: string, l: (err: unknown) => void): this { this.listeners.set(event, l); return this }
  async connect(): Promise<void> { this.isOpen = true }
  async quit(): Promise<void> { this.quitCalls++; this.isOpen = false }
  async disconnect(): Promise<void> { this.isOpen = false }
  data = new Map<string, string>()
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null }
  async set(key: string, value: string): Promise<string> { this.data.set(key, value); return 'OK' }
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => ({ on: vi.fn(), isOpen: false, connect: vi.fn(), quit: vi.fn() })),
  createCluster: vi.fn((options: Record<string, unknown>) => {
    const client = new MockCluster(options)
    created.push({ options, client })
    return client
  }),
}))

const { RedisStore, RedisCoordinator, RedisDurability } = await import('../src/index.js')

beforeEach(() => { created.length = 0 })

describe('cluster connect options', () => {
  it('creates a node-redis cluster client: masters only, seeds, address map, credentials, error listener', async () => {
    const errors: unknown[] = []
    const map = (a: string) => ({ host: '127.0.0.1', port: Number(a.split(':')[1]) })
    const store = new RedisStore({
      cluster: { rootNodes: ['redis://n1:7000', 'redis://n2:7001'], nodeAddressMap: map, defaults: { password: 'pw', socket: { connectTimeout: 1234 } }, maxCommandRedirections: 3 },
      logger: { error: (...args: unknown[]) => errors.push(args) },
    })
    expect(store.layout).toBe('cluster')
    expect(created).toHaveLength(1)
    const o = created[0]!.options as {
      rootNodes: Array<{ url: string }>; useReplicas: boolean; nodeAddressMap: unknown; maxCommandRedirections: number
      defaults: { password: string; socket: { connectTimeout: number; reconnectStrategy: (n: number, e: Error) => number | Error } }
    }
    expect(o.rootNodes).toEqual([{ url: 'redis://n1:7000' }, { url: 'redis://n2:7001' }])
    expect(o.useReplicas).toBe(false)
    expect(o.nodeAddressMap).toBe(map)
    expect(o.maxCommandRedirections).toBe(3)
    expect(o.defaults.password).toBe('pw')
    expect(o.defaults.socket.connectTimeout).toBe(1234)
    // Before the first connect the strategy gives up at once (start() fails fast)…
    const cause = new Error('ECONNREFUSED')
    expect(o.defaults.socket.reconnectStrategy(1, cause)).toBe(cause)
    created[0]!.client.listeners.get('error')!(new Error('boom'))
    expect(errors).toHaveLength(1)
    await store.start()
    // …and retries with backoff once connected.
    expect(o.defaults.socket.reconnectStrategy(3, cause)).toBe(150)
    expect(created[0]!.client.isOpen).toBe(true)
    await store.stop()
    expect(created[0]!.client.quitCalls).toBe(1)
  })

  it('the coordinator and the durability backend create and own one too', async () => {
    const coord = new RedisCoordinator({ cluster: { rootNodes: ['redis://n1:7000'] } })
    expect(coord.layout).toBe('cluster')
    new RedisDurability({ cluster: { rootNodes: ['redis://n1:7000'] } })
    expect(created).toHaveLength(2)
  })

  it('the coordinator and the durability backend listen for client errors (a dropped node never crashes the process)', () => {
    const warned: unknown[] = []
    const failed: unknown[] = []
    new RedisCoordinator({ cluster: { rootNodes: ['redis://n1:7000'] }, logger: { warn: (o) => warned.push(o) } })
    new RedisDurability({ cluster: { rootNodes: ['redis://n1:7000'] }, logger: { error: (o: unknown) => failed.push(o) } })
    new RedisDurability({ cluster: { rootNodes: ['redis://n1:7000'] } })                  // no logger: errors dropped
    expect(created).toHaveLength(3)
    for (const { client } of created) expect(client.listeners.get('error')).toBeTypeOf('function')
    const boom = new Error('Socket closed unexpectedly')
    created[0]!.client.listeners.get('error')!(boom)
    created[1]!.client.listeners.get('error')!(boom)
    expect(() => created[2]!.client.listeners.get('error')!(boom)).not.toThrow()
    expect(warned).toEqual([{ err: boom }])
    expect(failed).toEqual([{ err: boom }])
  })

  it('a url-created client gets an error listener too', async () => {
    const { createClient } = await import('redis')
    const mocked = vi.mocked(createClient)
    mocked.mockClear()
    new RedisCoordinator({ url: 'redis://x:6379' })
    new RedisDurability({ url: 'redis://x:6379' })
    expect(mocked).toHaveBeenCalledTimes(2)
    for (const r of mocked.mock.results) {
      const on = (r.value as { on: ReturnType<typeof vi.fn> }).on
      expect(on).toHaveBeenCalledWith('error', expect.any(Function))
    }
  })
})
