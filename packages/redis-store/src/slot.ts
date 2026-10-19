/**
 * Redis Cluster hash slots (internal): CRC16-XMODEM over the key's UTF-8 bytes,
 * modulo 16384, honouring the hash-tag rule (only the part between the first `{`
 * and the first `}` after it is hashed, when that part is non-empty). Used to fail
 * fast, before the network call, when a multi-key command or script would span
 * several slots (the server would reply CROSSSLOT).
 */

const SLOTS = 16384

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i << 8
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    table[i] = crc
  }
  return table
})()

function crc16(bytes: Uint8Array): number {
  let crc = 0
  for (const b of bytes) crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ b) & 0xff]!
  return crc
}

/** The hash tag Redis uses for `key`, or `undefined` when the whole key is hashed. */
export function hashTagOf(key: string): string | undefined {
  const open = key.indexOf('{')
  if (open < 0) return undefined
  const close = key.indexOf('}', open + 1)
  if (close < 0 || close === open + 1) return undefined
  return key.slice(open + 1, close)
}

/** The cluster hash slot of `key` (0…16383), exactly as `CLUSTER KEYSLOT` computes it. */
export function hashSlot(key: string): number {
  const bytes = Buffer.from(key, 'utf8')
  const open = bytes.indexOf(0x7b) // '{'
  if (open >= 0) {
    const close = bytes.indexOf(0x7d, open + 1) // '}'
    if (close > open + 1) return crc16(bytes.subarray(open + 1, close)) % SLOTS
  }
  return crc16(bytes) % SLOTS
}

/** Throws when `keys` do not all hash to one slot (a cluster would reject the command with CROSSSLOT). */
export function assertOneSlot(keys: readonly string[]): void {
  if (keys.length < 2) return
  const first = hashSlot(keys[0]!)
  for (let i = 1; i < keys.length; i++) {
    if (hashSlot(keys[i]!) !== first) {
      throw new Error(`redis-store: keys span several hash slots (${keys[0]} and ${keys[i]}); this is a bug in the cluster key layout`)
    }
  }
}
