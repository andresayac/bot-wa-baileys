/**
 * Lazily import an optional peer SDK. Only a failure to *find* `name` is turned
 * into the actionable "install it" error (with the original error as `cause`);
 * any other failure — the SDK is installed but throws while loading, or one of
 * its own dependencies is missing — is rethrown untouched so it is not
 * misreported as "not installed".
 */
export async function loadModule<T = unknown>(name: string, installHint: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ name)) as T
  } catch (err) {
    if (!isNotFound(err, name)) throw err
    throw new Error(`El proveedor requiere el paquete "${name}", que no está instalado. Instálalo: ${installHint}`, {
      cause: err,
    })
  }
}

/** True when `err` reports that `name` itself (not a transitive dependency) could not be resolved. */
function isNotFound(err: unknown, name: string): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false
  return err.message.includes(`'${name}'`) || err.message.includes(`"${name}"`)
}
