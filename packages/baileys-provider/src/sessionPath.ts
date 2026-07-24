import {
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import {
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function isContained(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve a session directory without allowing an identifier to escape its
 * configured root. Session identifiers are deliberately opaque: callers that
 * need hierarchy should configure a different `sessionsDir`, not put path
 * separators in `session`.
 */
export function resolveSessionDirectory(sessionsDir = './sessions', session = 'default'): string {
  if (!SESSION_ID.test(session) || session === '.' || session === '..') {
    throw new Error(
      'Invalid Baileys session id. Use 1-128 letters, numbers, dots, underscores or hyphens; path segments are not allowed.',
    )
  }

  const base = resolve(sessionsDir)
  if (base === parse(base).root) {
    throw new Error('Baileys sessionsDir must not be a filesystem root')
  }

  const target = resolve(base, session)
  if (!isContained(base, target)) {
    throw new Error('Baileys session directory escaped its configured root')
  }

  return target
}

/**
 * Reject an existing session symlink and verify real-path containment. This
 * prevents auth reads/writes from being redirected outside `sessionsDir`.
 */
export function assertSessionDirectorySafe(sessionsDir = './sessions', session = 'default'): string {
  const target = resolveSessionDirectory(sessionsDir, session)
  if (!existsSync(target)) return target

  if (lstatSync(target).isSymbolicLink()) {
    throw new Error('Baileys session directory must not be a symbolic link')
  }

  const base = resolve(sessionsDir)
  const realBase = existsSync(base) ? realpathSync(base) : base
  const realTarget = realpathSync(target)
  if (!isContained(realBase, realTarget)) {
    throw new Error('Baileys session directory escaped its configured root through a symbolic link')
  }
  return target
}

/** Remove exactly one validated session directory. */
export function removeSessionDirectory(sessionsDir = './sessions', session = 'default'): void {
  const target = assertSessionDirectorySafe(sessionsDir, session)
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
}

