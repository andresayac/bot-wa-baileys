/**
 * Minimal multipart/form-data encoder. Built by hand (instead of `FormData`)
 * so the body is a plain `Buffer`: it works with any fetch implementation
 * `secureFetch` is given and is byte-for-byte assertable in tests.
 */

import { randomBytes } from 'node:crypto'

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; data: Buffer }

export interface MultipartBody {
  body: Buffer
  contentType: string
}

function escapeQuoted(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/"/g, '%22')
}

export function encodeMultipart(parts: MultipartPart[], boundary = `----botwa${randomBytes(12).toString('hex')}`): MultipartBody {
  const chunks: Buffer[] = []
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(part.name)}"`
    if ('data' in part) {
      header += `; filename="${escapeQuoted(part.filename)}"\r\nContent-Type: ${part.contentType}\r\n\r\n`
      chunks.push(Buffer.from(header, 'utf8'), part.data, Buffer.from('\r\n'))
    } else {
      header += '\r\n\r\n'
      chunks.push(Buffer.from(header, 'utf8'), Buffer.from(part.value, 'utf8'), Buffer.from('\r\n'))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}
