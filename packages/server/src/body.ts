import type { IncomingMessage } from 'node:http'
import { BodyAbortedError, BodyTimeoutError, BodyTooLargeError, BodyUnavailableError } from './errors.js'

/** A Node request, possibly already handled by a body parser (Express). */
export type NodeRequestLike = IncomingMessage & { body?: unknown; _body?: boolean }

/**
 * Read the raw body of a Node request with a byte limit and a timeout. A
 * Buffer/string already left by `express.raw()`/`express.text()` is reused;
 * a parsed object (express.json()) means the bytes are gone → BodyUnavailableError.
 */
export function readNodeBody(req: NodeRequestLike, limit: number, timeoutMs: number): Promise<Buffer> {
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf8')
    return buf.length > limit ? Promise.reject(new BodyTooLargeError(limit)) : Promise.resolve(buf)
  }
  if (req._body === true || req.readableEnded) return Promise.reject(new BodyUnavailableError())

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => finish(new BodyTimeoutError(timeoutMs)), timeoutMs)
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += bytes.length
      if (size > limit) { finish(new BodyTooLargeError(limit)); return }
      chunks.push(bytes)
    }
    const onEnd = () => finish()
    const onError = () => finish(new BodyAbortedError())
    const onClose = () => { if (!req.readableEnded) finish(new BodyAbortedError()) }
    function finish(err?: Error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
      if (err) {
        // Stop pulling bytes; the adapter answers with `Connection: close`.
        req.pause()
        reject(err)
      } else {
        resolve(Buffer.concat(chunks, size))
      }
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })
}

/** Read a WHATWG `Request` body with a byte limit and a timeout. */
export async function readWebBody(request: Request, limit: number, timeoutMs: number): Promise<Buffer> {
  if (request.bodyUsed) throw new BodyUnavailableError()
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout])
      if (done) break
      size += value.byteLength
      if (size > limit) throw new BodyTooLargeError(limit)
      chunks.push(value)
    }
  } catch (err) {
    reader.cancel().catch(() => {})
    if (err instanceof BodyTooLargeError || err instanceof BodyTimeoutError) throw err
    throw new BodyAbortedError()
  } finally {
    clearTimeout(timer)
  }
  return Buffer.concat(chunks, size)
}
