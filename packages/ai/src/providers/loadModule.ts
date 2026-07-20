export async function loadModule<T = unknown>(name: string, installHint: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ name)) as T
  } catch {
    throw new Error(`El proveedor requiere el paquete "${name}", que no está instalado. Instálalo: ${installHint}`)
  }
}
