/**
 * Module-resolution hooks that make `botmesh dev` hot reload reach the WHOLE
 * local import graph, not just the entry file.
 *
 * ESM modules are cached by URL, so re-importing `bot.js?botwa_v=2` re-runs the
 * entry but would still reuse the cached `./flows/menu.js`. These hooks copy the
 * importer's `botwa_v` query onto every RELATIVE import (`./x`, `../y`), so each
 * reload gets a fresh copy of your own modules. Package imports (`@botmesh/core`,
 * `node:*`, anything under `node_modules`) are never re-versioned, and
 * `require()` is left alone.
 *
 * This file is self-contained on purpose: on runtimes without
 * `module.registerHooks`, it is loaded off-thread through `module.register()`.
 * Old module versions cannot be unloaded by Node, so a very long dev session
 * slowly accumulates memory — restart it now and then.
 */

/** Query parameter carrying the reload generation (`bot.js?botwa_v=3`). */
export const RELOAD_PARAM = 'botwa_v'

/** The subset of Node's resolve-hook context these hooks read. */
export interface ResolveContextLike {
  parentURL?: string
  conditions?: readonly string[]
}

/** The subset of Node's resolve-hook result these hooks read/rewrite. */
export interface ResolveResultLike {
  url: string
  format?: string | null
  shortCircuit?: boolean
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
}

/**
 * Pure core of the hooks: given the import `specifier`, the URL Node resolved it
 * to and the importer's URL, return the URL to actually load — the resolved URL
 * carrying the importer's reload generation when the import is a relative,
 * local (`file:`, outside `node_modules`) one; otherwise unchanged.
 */
export function propagateVersion(specifier: string, resolvedUrl: string, parentUrl: string | undefined): string {
  if (!parentUrl || !isRelativeSpecifier(specifier)) return resolvedUrl
  if (!resolvedUrl.startsWith('file:') || !parentUrl.startsWith('file:')) return resolvedUrl
  let version: string | null
  let target: URL
  try {
    version = new URL(parentUrl).searchParams.get(RELOAD_PARAM)
    target = new URL(resolvedUrl)
  } catch {
    return resolvedUrl
  }
  if (!version || target.pathname.includes('/node_modules/')) return resolvedUrl
  target.searchParams.set(RELOAD_PARAM, version)
  return target.href
}

function rewrite(specifier: string, context: ResolveContextLike, result: ResolveResultLike): ResolveResultLike {
  // CommonJS require() caches by filename; a query string would only confuse it.
  if (context.conditions?.includes('require')) return result
  const url = propagateVersion(specifier, result.url, context.parentURL)
  return url === result.url ? result : { ...result, url }
}

/** Synchronous resolve hook for `module.registerHooks()` (Node >= 22.15 / 23.5). */
export function resolveSync(
  specifier: string,
  context: ResolveContextLike,
  nextResolve: (specifier: string, context?: ResolveContextLike) => ResolveResultLike,
): ResolveResultLike {
  return rewrite(specifier, context, nextResolve(specifier, context))
}

/** Asynchronous resolve hook for `module.register()` (loaded off-thread by Node). */
export async function resolve(
  specifier: string,
  context: ResolveContextLike,
  nextResolve: (specifier: string, context?: ResolveContextLike) => ResolveResultLike | Promise<ResolveResultLike>,
): Promise<ResolveResultLike> {
  return rewrite(specifier, context, await nextResolve(specifier, context))
}
