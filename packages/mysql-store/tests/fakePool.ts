/**
 * In-memory fake of the mysql2/promise pool surface used by MysqlStore.
 *
 * Hermetic: no network, no real MySQL. `query(sql, params)` implements
 * EXACTLY the statements MysqlStore issues — it switches on the normalized
 * (whitespace-collapsed) SQL shape and returns mysql2-style `[rows]` tuples.
 * Any statement the fake does not recognize throws, so the suite fails loudly
 * if the store ever drifts to new SQL.
 *
 * Like real mysql2, JSON-typed columns (msg/data/cp/messages) come back
 * already parsed into objects; set `jsonAsString: true` to return the raw
 * stored string instead (TEXT-column behavior / older driver behavior) so the
 * store's defensive parsing is exercised on both paths.
 */
import type { MysqlQueryResult, PoolLike } from '../src/MysqlStore.js'

type Row = Record<string, unknown>

/** Collapse whitespace so multi-line/template SQL matches its canonical shape. */
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

export interface FakePoolOptions {
  /** Must match the tablePrefix the store under test uses. Default: ''. */
  tablePrefix?: string
  /** Return JSON columns as raw stored strings instead of parsed objects. Default: false. */
  jsonAsString?: boolean
}

export class FakePool implements PoolLike {
  /** Table name -> primary key -> row (column -> value). */
  readonly tables = new Map<string, Map<string, Row>>()
  /** Every statement received, in order (for assertions). */
  readonly queries: Array<{ sql: string; params?: readonly unknown[] }> = []
  /** True after end() was called (real pool: connections released). */
  ended = false

  private readonly jsonAsString: boolean
  private readonly t: Record<'messages' | 'chats' | 'contacts' | 'checkpoints' | 'conversations' | 'cursors', string>

  constructor(opts: FakePoolOptions = {}) {
    this.jsonAsString = opts.jsonAsString === true
    const p = opts.tablePrefix ?? ''
    this.t = {
      messages: `${p}messages`,
      chats: `${p}chats`,
      contacts: `${p}contacts`,
      checkpoints: `${p}checkpoints`,
      conversations: `${p}conversations`,
      cursors: `${p}cursors`,
    }
  }

  /** JSON column read: parsed object by default, raw string under `jsonAsString`. */
  private jsonOut(stored: string): unknown {
    return this.jsonAsString ? stored : JSON.parse(stored)
  }

  private table(name: string): Map<string, Row> {
    let map = this.tables.get(name)
    if (!map) {
      map = new Map()
      this.tables.set(name, map)
    }
    return map
  }

  async query(sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult> {
    if (this.ended) throw new Error('FakePool: pool is closed')
    this.queries.push({ sql, params })
    const s = norm(sql)
    const p = params ?? []
    const { messages, chats, contacts, checkpoints, conversations, cursors } = this.t

    /* DDL ------------------------------------------------------------------ */
    if (s.startsWith('CREATE TABLE IF NOT EXISTS')) {
      const m = /^CREATE TABLE IF NOT EXISTS `([^`]+)`/.exec(s)
      if (m == null) throw new Error(`FakePool: unrecognized CREATE: ${s}`)
      this.table(m[1]) // create empty table
      return [[], []]
    }

    /* messages -------------------------------------------------------------- */
    if (
      s ===
      `INSERT INTO \`${messages}\` (id, chat_id, timestamp, msg) VALUES (?, ?, ?, ?) ` +
        'ON DUPLICATE KEY UPDATE chat_id = VALUES(chat_id), timestamp = VALUES(timestamp), msg = VALUES(msg)'
    ) {
      const [id, chatId, timestamp, msg] = p
      this.table(messages).set(String(id), { id, chat_id: chatId, timestamp: Number(timestamp), msg: String(msg) })
      return [[], []]
    }
    if (s === `SELECT msg FROM \`${messages}\` WHERE id = ?`) {
      const row = this.table(messages).get(String(p[0]))
      return [row ? [{ msg: this.jsonOut(String(row.msg)) }] : [], []]
    }
    if (s === `SELECT msg FROM \`${messages}\` WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`) {
      const rows = [...this.table(messages).values()]
        .filter((r) => r.chat_id === p[0])
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
        .slice(0, Number(p[1]))
        .map((r) => ({ msg: this.jsonOut(String(r.msg)) }))
      return [rows, []]
    }
    if (s === `DELETE FROM \`${messages}\` WHERE id = ?`) {
      this.table(messages).delete(String(p[0]))
      return [[], []]
    }
    if (s === `DELETE FROM \`${messages}\` WHERE chat_id = ?`) {
      for (const [k, r] of this.table(messages)) if (r.chat_id === p[0]) this.table(messages).delete(k)
      return [[], []]
    }
    if (
      s ===
      `DELETE FROM \`${messages}\` WHERE chat_id = ? AND id NOT IN ` +
        `(SELECT id FROM (SELECT id FROM \`${messages}\` WHERE chat_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?) keep)`
    ) {
      const chatId = p[0]
      const keep = Number(p[2])
      const matching = [...this.table(messages).values()].filter((r) => r.chat_id === chatId)
      matching.sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || (String(a.id) < String(b.id) ? 1 : -1))
      const keepIds = new Set(matching.slice(0, keep).map((r) => String(r.id)))
      for (const [k, r] of this.table(messages)) {
        if (r.chat_id === chatId && !keepIds.has(String(r.id))) this.table(messages).delete(k)
      }
      return [[], []]
    }

    /* chats / contacts (identical shape: id PK + data JSON) ------------------ */
    for (const name of [chats, contacts]) {
      if (s === `INSERT INTO \`${name}\` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`) {
        this.table(name).set(String(p[0]), { id: p[0], data: String(p[1]) })
        return [[], []]
      }
      if (s === `SELECT data FROM \`${name}\` WHERE id = ?`) {
        const row = this.table(name).get(String(p[0]))
        return [row ? [{ data: this.jsonOut(String(row.data)) }] : [], []]
      }
      if (s === `SELECT data FROM \`${name}\``) {
        return [[...this.table(name).values()].map((r) => ({ data: this.jsonOut(String(r.data)) })), []]
      }
      if (s === `DELETE FROM \`${name}\` WHERE id = ?`) {
        this.table(name).delete(String(p[0]))
        return [[], []]
      }
    }

    /* checkpoints ------------------------------------------------------------- */
    if (s === `INSERT INTO \`${checkpoints}\` (\`key\`, cp) VALUES (?, ?) ON DUPLICATE KEY UPDATE cp = VALUES(cp)`) {
      this.table(checkpoints).set(String(p[0]), { key: p[0], cp: String(p[1]) })
      return [[], []]
    }
    if (s === `SELECT cp FROM \`${checkpoints}\` WHERE \`key\` = ?`) {
      const row = this.table(checkpoints).get(String(p[0]))
      return [row ? [{ cp: this.jsonOut(String(row.cp)) }] : [], []]
    }
    if (s === `DELETE FROM \`${checkpoints}\` WHERE \`key\` = ?`) {
      this.table(checkpoints).delete(String(p[0]))
      return [[], []]
    }
    if (s === `SELECT \`key\`, cp FROM \`${checkpoints}\``) {
      return [[...this.table(checkpoints).values()].map((r) => ({ key: r.key, cp: this.jsonOut(String(r.cp)) })), []]
    }

    /* conversations ----------------------------------------------------------- */
    if (
      s === `INSERT INTO \`${conversations}\` (\`key\`, messages) VALUES (?, ?) ON DUPLICATE KEY UPDATE messages = VALUES(messages)`
    ) {
      this.table(conversations).set(String(p[0]), { key: p[0], messages: String(p[1]) })
      return [[], []]
    }
    if (s === `SELECT messages FROM \`${conversations}\` WHERE \`key\` = ?`) {
      const row = this.table(conversations).get(String(p[0]))
      return [row ? [{ messages: this.jsonOut(String(row.messages)) }] : [], []]
    }
    if (s === `DELETE FROM \`${conversations}\` WHERE \`key\` = ?`) {
      this.table(conversations).delete(String(p[0]))
      return [[], []]
    }

    /* cursors (TEXT value) ------------------------------------------------------ */
    if (s === `INSERT INTO \`${cursors}\` (\`key\`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`) {
      this.table(cursors).set(String(p[0]), { key: p[0], value: String(p[1]) })
      return [[], []]
    }
    if (s === `SELECT value FROM \`${cursors}\` WHERE \`key\` = ?`) {
      const row = this.table(cursors).get(String(p[0]))
      return [row ? [{ value: row.value }] : [], []]
    }

    throw new Error(`FakePool: statement not implemented: ${s}`)
  }

  async end(): Promise<void> {
    this.ended = true
  }
}
