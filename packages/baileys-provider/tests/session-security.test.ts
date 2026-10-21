import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'

import { BaileysProvider } from '../src/BaileysProvider.js'
import {
  assertSessionDirectorySafe,
  removeSessionDirectory,
  resolveSessionDirectory,
} from '../src/sessionPath.js'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmesh-session-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('Baileys session path safety', () => {
  it.each(['..', '.', '../outside', 'nested/session', 'C:\\outside', '/outside', ''])(
    'rejects unsafe session id %j',
    (session) => {
      expect(() => resolveSessionDirectory(tempRoot(), session)).toThrow(/session|path/i)
    },
  )

  it('resolves a valid opaque id inside the configured root', () => {
    const root = tempRoot()
    expect(resolveSessionDirectory(root, 'tenant_1.bot-2')).toBe(resolve(root, 'tenant_1.bot-2'))
  })

  it('refuses a filesystem root as sessionsDir', () => {
    const filesystemRoot = parse(resolve(tempRoot())).root
    expect(() => resolveSessionDirectory(filesystemRoot, 'safe')).toThrow(/filesystem root/i)
  })

  it('rejects an existing session symlink', () => {
    const root = tempRoot()
    const outside = tempRoot()
    symlinkSync(outside, join(root, 'linked'), 'junction')
    expect(() => assertSessionDirectorySafe(root, 'linked')).toThrow(/symbolic link/i)
  })

  it('removes only the selected session', () => {
    const root = tempRoot()
    const selected = join(root, 'selected')
    const sibling = join(root, 'sibling')
    mkdirSync(selected)
    mkdirSync(sibling)
    writeFileSync(join(selected, 'creds.json'), '{}')
    writeFileSync(join(sibling, 'keep.txt'), 'keep')

    removeSessionDirectory(root, 'selected')

    expect(existsSync(selected)).toBe(false)
    expect(existsSync(join(sibling, 'keep.txt'))).toBe(true)
  })
})

describe('Baileys lifecycle semantics', () => {
  it('stop closes the socket without logging out', async () => {
    const provider = new BaileysProvider({ sessionsDir: tempRoot(), session: 'safe' })
    const socket = { end: vi.fn(), logout: vi.fn(async () => {}) }
    ;(provider as unknown as { sock: typeof socket }).sock = socket

    await provider.stop()

    expect(socket.end).toHaveBeenCalledOnce()
    expect(socket.logout).not.toHaveBeenCalled()
  })

  it('logoutAndDeleteSession is explicit and destructive', async () => {
    const root = tempRoot()
    const sessionDir = join(root, 'safe')
    mkdirSync(sessionDir)
    writeFileSync(join(sessionDir, 'creds.json'), '{}')
    const provider = new BaileysProvider({ sessionsDir: root, session: 'safe' })
    const socket = { end: vi.fn(), logout: vi.fn(async () => {}) }
    ;(provider as unknown as { sock: typeof socket }).sock = socket

    await provider.logoutAndDeleteSession()

    expect(socket.logout).toHaveBeenCalledOnce()
    expect(socket.end).not.toHaveBeenCalled()
    expect(existsSync(sessionDir)).toBe(false)
  })

  it('debug logging can be enabled without an optional transport dependency', () => {
    expect(() => new BaileysProvider({ sessionsDir: tempRoot(), session: 'debug', debug: true })).not.toThrow()
  })
})
