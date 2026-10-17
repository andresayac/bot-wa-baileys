/**
 * The FakePool must reject and return what a real MySQL 8 + mysql2 rejects
 * and returns, otherwise the hermetic suites pass on behaviour production
 * never sees. Every expectation here was checked against a live server
 * (tests/integration.test.ts exercises the same paths end to end).
 */
import { describe, it, expect } from 'vitest'
import { FakePool, mysqlJsonIn } from './fakePool.js'

const BS = '\\'

async function started(): Promise<FakePool> {
  const fake = new FakePool()
  for (const t of ['messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors']) {
    await fake.query(`CREATE TABLE IF NOT EXISTS \`${t}\` (x INT)`)
  }
  return fake
}

describe('FakePool — JSON columns behave like MySQL JSON', () => {
  it('rejects escaped unpaired surrogates (values and keys) with ER_INVALID_JSON_TEXT', async () => {
    const fake = await started()
    const bad = [`{"x":"${BS}ud83d"}`, `{"x":"${BS}ude00"}`, `{"${BS}ud83d":1}`, `{"x":"${BS}ud83d${BS}ud83d"}`]
    for (const json of bad) {
      await expect(fake.query('INSERT INTO `chats` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id', ['c', json]))
        .rejects.toMatchObject({ code: 'ER_INVALID_JSON_TEXT', errno: 3140, sqlState: '22032' })
      await expect(fake.query('INSERT INTO `checkpoints` (`key`, cp) VALUES (?, ?) ON DUPLICATE KEY UPDATE cp = VALUES(cp)', ['k', json]))
        .rejects.toThrow(/The surrogate pair in string is invalid/)
    }
    expect(fake.tables.get('chats')?.size).toBe(0)
  })

  it('rejects malformed JSON text', () => {
    expect(() => mysqlJsonIn('{bad', 't.c')).toThrow(/Invalid JSON text/)
  })

  it('accepts a valid escaped pair and literal (escaped-backslash) text', () => {
    expect(mysqlJsonIn(`{"x":"${BS}ud83d${BS}ude00"}`, 't.c')).toBe(`{"x":"${BS}ud83d${BS}ude00"}`)
    expect(mysqlJsonIn(`{"x":"${BS}${BS}ud83d"}`, 't.c')).toBe(`{"x":"${BS}${BS}ud83d"}`)
  })

  it('stores a RAW lone surrogate as U+FFFD (parameters travel as UTF-8)', async () => {
    const fake = await started()
    await fake.query('INSERT INTO `chats` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id', ['c', '{"x":"\ud83d"}'])
    const [rows] = await fake.query('SELECT data FROM `chats` WHERE id = ?', ['c'])
    expect(rows[0]?.data).toEqual({ x: '�' })
  })
})

describe('FakePool — VARBINARY keys', () => {
  it('returns VARBINARY columns as Buffers, like mysql2', async () => {
    const fake = await started()
    await fake.query('INSERT INTO `checkpoints` (`key`, cp) VALUES (?, ?) ON DUPLICATE KEY UPDATE cp = VALUES(cp)', ['chat-😀:ñ', '{}'])
    const [rows] = await fake.query('SELECT `key`, cp FROM `checkpoints`')
    expect(Buffer.isBuffer(rows[0]?.key)).toBe(true)
    expect((rows[0]?.key as Buffer).toString('utf8')).toBe('chat-😀:ñ')
  })

  it('compares ids byte-wise as received (case/space-sensitive; lone surrogates arrive as U+FFFD)', async () => {
    const fake = await started()
    const insert = 'INSERT INTO `chats` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id'
    for (const id of ['abc', 'ABC', 'k', 'k ']) await fake.query(insert, [id, '{}'])
    expect(fake.tables.get('chats')?.size).toBe(4)
    await fake.query(insert, ['x\ud83d', '{"n":1}'])
    const [rows] = await fake.query('SELECT data FROM `chats` WHERE id = ?', ['x\ude00'])
    expect(rows[0]?.data).toEqual({ n: 1 })
  })
})

describe('FakePool — connections and transactions', () => {
  it('SELECT ... FOR UPDATE blocks other writers until COMMIT', async () => {
    const fake = await started()
    await fake.query('INSERT INTO `chats` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id', ['c', '{"v":0}'])
    const tx = await fake.getConnection()
    await tx.query('START TRANSACTION')
    await tx.query('SELECT data FROM `chats` WHERE id = ? FOR UPDATE', ['c'])
    let done = false
    const other = fake.query('UPDATE `chats` SET data = ? WHERE id = ?', ['{"v":2}', 'c']).then(() => { done = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    await tx.query('UPDATE `chats` SET data = ? WHERE id = ?', ['{"v":1}', 'c'])
    await tx.query('COMMIT')
    await other
    const [rows] = await fake.query('SELECT data FROM `chats` WHERE id = ?', ['c'])
    expect(rows[0]?.data).toEqual({ v: 2 })
    tx.release()
    expect(fake.checkedOut).toBe(0)
  })

  it('ROLLBACK undoes the transaction\'s writes', async () => {
    const fake = await started()
    const tx = await fake.getConnection()
    await tx.query('START TRANSACTION')
    await tx.query('INSERT INTO `contacts` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id', ['u', '{"a":1}'])
    await tx.query('ROLLBACK')
    tx.release()
    const [rows] = await fake.query('SELECT data FROM `contacts` WHERE id = ?', ['u'])
    expect(rows).toEqual([])
  })

  it('refuses to release a connection with an open transaction (it would leak locks into the pool)', async () => {
    const fake = await started()
    const tx = await fake.getConnection()
    await tx.query('START TRANSACTION')
    expect(() => tx.release()).toThrow(/open transaction/)
    tx.destroy()
    expect(fake.checkedOut).toBe(0)
  })

  it('reports affectedRows like mysql2 (FOUND_ROWS: a no-op duplicate still reports 1)', async () => {
    const fake = await started()
    const insert = 'INSERT INTO `chats` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id'
    expect((await fake.query(insert, ['c', '{}']))[0]).toMatchObject({ affectedRows: 1 })
    expect((await fake.query(insert, ['c', '{}']))[0]).toMatchObject({ affectedRows: 1 })
    expect((await fake.query('UPDATE `chats` SET data = ? WHERE id = ?', ['{}', 'nope']))[0]).toMatchObject({ affectedRows: 0 })
  })
})
