/**
 * In-memory fake of the mysql2/promise pool surface used by MysqlStore.
 *
 * Hermetic: no network, no real MySQL. `query(sql, params)` implements
 * EXACTLY the statements MysqlStore issues — it switches on the normalized
 * (whitespace-collapsed) SQL shape and returns mysql2-style `[rows]` tuples.
 * Any statement the fake does not recognize throws, so the suite fails loudly
 * if the store ever drifts to new SQL.
 *
 * Fidelity with a real MySQL 8 + mysql2 (each point verified against a live
 * server, see tests/integration.test.ts):
 *  - Parameters travel as UTF-8 text, so an unpaired UTF-16 surrogate in a
 *    string parameter arrives as U+FFFD.
 *  - JSON columns (msg/data/cp/messages) reject invalid JSON text and escaped
 *    unpaired surrogates (`"\ud83d"`) with ER_INVALID_JSON_TEXT (errno 3140),
 *    and come back already parsed; set `jsonAsString: true` to return the raw
 *    stored string instead (TEXT-column / older driver behavior).
 *  - VARBINARY id/key columns compare byte-wise and come back as Buffers.
 *  - DML replies carry a ResultSetHeader (`affectedRows`) in the rows slot.
 *  - `getConnection()` hands out dedicated connections with real transaction
 *    semantics for the chats/contacts rows: `SELECT ... FOR UPDATE` takes a
 *    row lock (also on a missing row, like InnoDB's gap lock) held until
 *    COMMIT/ROLLBACK; writes from other connections wait for it; ROLLBACK
 *    undoes the transaction's writes. `failNext()` injects server errors
 *    (e.g. {@link deadlockError}); a deadlock rolls the transaction back, as
 *    InnoDB does.
 */
import type { ConnectionLike, MysqlQueryResult, PoolLike } from '../src/MysqlStore.js'

type Row = Record<string, unknown>

/** Collapse whitespace so multi-line/template SQL matches its canonical shape. */
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

/** A string parameter as the server receives it: UTF-8 on the wire (lone surrogates -> U+FFFD). */
const wire = (v: unknown): string => Buffer.from(String(v), 'utf8').toString('utf8')

/** Error shaped like mysql2's (code/errno/sqlState/sqlMessage). */
export function mysqlError(code: string, errno: number, sqlState: string, sqlMessage: string): Error {
  return Object.assign(new Error(sqlMessage), { code, errno, sqlState, sqlMessage })
}

/** What InnoDB throws at a deadlock victim (its transaction is rolled back). */
export function deadlockError(): Error {
  return mysqlError('ER_LOCK_DEADLOCK', 1213, '40001', 'Deadlock found when trying to get lock; try restarting transaction')
}

const invalidJson = (reason: string, position: number, column: string): Error =>
  mysqlError('ER_INVALID_JSON_TEXT', 3140, '22032', `Invalid JSON text: "${reason}" at position ${position} in value for column '${column}'.`)

/**
 * Validate JSON text the way MySQL's JSON type does and return the stored
 * (canonical) text. Rejects malformed JSON and `\uD800-\uDFFF` escapes that do
 * not form a valid high+low pair, keys included.
 */
export function mysqlJsonIn(value: unknown, column: string): string {
  const text = wire(value)
  try {
    JSON.parse(text)
  } catch {
    throw invalidJson('Invalid value.', 0, column)
  }
  const escape = /\\\\|\\u([dD][89a-fA-F][0-9a-fA-F]{2})(?:\\u([dD][c-fC-F][0-9a-fA-F]{2}))?|\\u([dD][c-fC-F][0-9a-fA-F]{2})/g
  for (let m = escape.exec(text); m != null; m = escape.exec(text)) {
    if (m[0] === '\\\\') continue
    // m[1] alone = high without its low; m[3] = low without a preceding high.
    if ((m[1] != null && m[2] == null) || m[3] != null) {
      throw invalidJson('The surrogate pair in string is invalid.', m.index, column)
    }
  }
  return text
}

export interface FakePoolOptions {
  /** Must match the tablePrefix the store under test uses. Default: ''. */
  tablePrefix?: string
  /** Return JSON columns as raw stored strings instead of parsed objects. Default: false. */
  jsonAsString?: boolean
}

/** A dedicated connection (mysql2 `PoolConnection`): its own transaction and row locks. */
export class FakeConnection implements ConnectionLike {
  inTransaction = false
  released = false
  destroyed = false
  /** Row locks held by the open transaction. */
  readonly locks = new Set<string>()
  /** Undo log of the open transaction: [table, key, previous row (undefined = absent)]. */
  readonly undo: Array<[string, string, Row | undefined]> = []

  constructor(private readonly pool: FakePool) {}

  async query(sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult> {
    if (this.released || this.destroyed) throw new Error('FakePool: connection used after release()/destroy()')
    return this.pool.run(this, sql, params)
  }

  release(): void {
    if (this.released || this.destroyed) throw new Error('FakePool: connection released twice')
    if (this.inTransaction) throw new Error('FakePool: connection released inside an open transaction')
    this.released = true
    this.pool.checkedOut--
  }

  destroy(): void {
    if (this.released || this.destroyed) throw new Error('FakePool: connection released twice')
    // The server rolls back a transaction whose connection goes away.
    this.pool.endTransaction(this, true)
    this.destroyed = true
    this.pool.checkedOut--
  }
}

export class FakePool implements PoolLike {
  /** Table name -> primary key -> row (column -> value). */
  readonly tables = new Map<string, Map<string, Row>>()
  /** Every statement received, in order (for assertions). */
  readonly queries: Array<{ sql: string; params?: readonly unknown[]; conn?: FakeConnection }> = []
  /** True after end() was called (real pool: connections released). */
  ended = false
  /** Connections handed out by getConnection() and not yet released/destroyed. */
  checkedOut = 0
  /** Every connection handed out by getConnection(). */
  readonly connections: FakeConnection[] = []

  private readonly jsonAsString: boolean
  /** Row lock -> owning connection + waiters. */
  private readonly rowLocks = new Map<string, { owner: FakeConnection; waiters: Array<() => void> }>()
  /** Errors to throw for the next statements matching a pattern (see failNext). */
  private readonly failures: Array<{ match: RegExp; error: Error }> = []
  /**
   * How the user_data identifier columns (user_id, namespace, `key`) compare,
   * read from the CREATE TABLE the store issues, like the real server:
   *  - `binary`: VARBINARY. Exact bytes; mysql2 returns them as Buffers.
   *  - `padSpace`: VARCHAR under a PAD SPACE collation (utf8mb4_bin and every
   *    pre-0900 collation). Trailing spaces are ignored in comparisons AND in
   *    primary-key uniqueness.
   *  - `exact`: VARCHAR under a NO PAD binary collation (utf8mb4_0900_bin).
   */
  userDataIdentifiers: 'binary' | 'padSpace' | 'exact' = 'exact'
  private readonly t: Record<'messages' | 'chats' | 'contacts' | 'checkpoints' | 'conversations' | 'cursors' | 'userData', string>

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
      userData: `${p}user_data`,
    }
  }

  /** Make the next statement whose normalized SQL matches `match` throw `error` (once). */
  failNext(match: RegExp, error: Error): void {
    this.failures.push({ match, error })
  }

  async getConnection(): Promise<FakeConnection> {
    if (this.ended) throw new Error('FakePool: pool is closed')
    const conn = new FakeConnection(this)
    this.connections.push(conn)
    this.checkedOut++
    return conn
  }

  /* Locks / transactions ----------------------------------------------------- */

  /**
   * Wait until no OTHER connection's transaction holds the row lock; when
   * `conn` is in a transaction, take the lock until COMMIT/ROLLBACK.
   */
  private async lock(conn: FakeConnection | null, table: string, key: string): Promise<void> {
    const id = `${table}\u0000${key}`
    for (;;) {
      const held = this.rowLocks.get(id)
      if (held == null || held.owner === conn) break
      await new Promise<void>((resolve) => held.waiters.push(resolve))
    }
    if (conn?.inTransaction && !this.rowLocks.has(id)) {
      this.rowLocks.set(id, { owner: conn, waiters: [] })
      conn.locks.add(id)
    }
  }

  /** Write a row, recording the previous one in the transaction's undo log. */
  private write(conn: FakeConnection | null, table: string, key: string, row: Row | undefined): void {
    const map = this.table(table)
    if (conn?.inTransaction) conn.undo.push([table, key, map.get(key)])
    if (row == null) map.delete(key)
    else map.set(key, row)
  }

  /** COMMIT (rollback=false) or ROLLBACK the connection's transaction and release its locks. */
  endTransaction(conn: FakeConnection, rollback: boolean): void {
    if (rollback) {
      for (const [table, key, prev] of conn.undo.reverse()) {
        if (prev == null) this.table(table).delete(key)
        else this.table(table).set(key, prev)
      }
    }
    conn.undo.length = 0
    conn.inTransaction = false
    for (const id of conn.locks) {
      const held = this.rowLocks.get(id)
      this.rowLocks.delete(id)
      for (const wake of held?.waiters ?? []) wake()
    }
    conn.locks.clear()
  }

  /** Classify the user_data identifier columns from the table's DDL (see {@link userDataIdentifiers}). */
  private classifyUserDataDdl(ddl: string): void {
    const columns = ['user_id', 'namespace', '`key`']
    if (columns.every((col) => ddl.includes(`${col} VARBINARY(`))) this.userDataIdentifiers = 'binary'
    else if (/_0900_bin|_nopad_bin/.test(ddl)) this.userDataIdentifiers = 'exact'
    else this.userDataIdentifiers = 'padSpace'
  }

  /**
   * user_data (ctx.user) statements. Rows are keyed by (user_id, namespace, key)
   * and compared the way the declared column type compares them
   * ({@link userDataIdentifiers}). DML replies mimic mysql2's ResultSetHeader
   * (`affectedRows`) in the rows slot.
   */
  private userDataQuery(s: string, p: readonly unknown[]): MysqlQueryResult | undefined {
    const ud = this.t.userData
    const cols = 'user_id, namespace, `key`, value, expires_at, updated_at'
    const mode = this.userDataIdentifiers
    const cmp = (v: unknown): string => (mode === 'padSpace' ? String(v).replace(/ +$/, '') : String(v))
    const eq = (a: unknown, b: unknown): boolean => cmp(a) === cmp(b)
    const id = (u: unknown, n: unknown, k: unknown): string => JSON.stringify([cmp(u), cmp(n), cmp(k)])
    const live = (r: Row, now: unknown): boolean => r.expires_at == null || Number(r.expires_at) > Number(now)
    const header = (affectedRows: number): MysqlQueryResult => [{ affectedRows } as unknown as Row[], []]
    const remove = (match: (r: Row) => boolean): MysqlQueryResult => {
      let n = 0
      for (const [k, r] of this.table(ud)) {
        if (match(r)) {
          this.table(ud).delete(k)
          n++
        }
      }
      return header(n)
    }
    // mysql2 hands VARBINARY columns back as Buffers.
    const out = (r: Row): Row => (mode === 'binary'
      ? { ...r, user_id: Buffer.from(String(r.user_id)), namespace: Buffer.from(String(r.namespace)), key: Buffer.from(String(r.key)) }
      : { ...r })
    const select = (match: (r: Row) => boolean): MysqlQueryResult =>
      [[...this.table(ud).values()].filter(match).map(out), []]

    if (
      s ===
      `INSERT INTO \`${ud}\` (${cols}) VALUES (?, ?, ?, ?, ?, ?) ` +
        'ON DUPLICATE KEY UPDATE value = VALUES(value), expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)'
    ) {
      const [userId, namespace, key, value, expiresAt, updatedAt] = p
      const existing = this.table(ud).get(id(userId, namespace, key))
      // ON DUPLICATE KEY UPDATE rewrites only the listed columns: under PAD
      // SPACE the row keeps the identifiers of whichever write created it.
      this.table(ud).set(id(userId, namespace, key), {
        user_id: existing?.user_id ?? userId, namespace: existing?.namespace ?? namespace, key: existing?.key ?? key,
        value: String(value), expires_at: expiresAt == null ? null : Number(expiresAt), updated_at: Number(updatedAt),
      })
      return header(existing ? 2 : 1)
    }
    if (s === `SELECT ${cols} FROM \`${ud}\` WHERE user_id = ? AND namespace = ? AND \`key\` = ? AND (expires_at IS NULL OR expires_at > ?)`) {
      return select((r) => eq(r.user_id, p[0]) && eq(r.namespace, p[1]) && eq(r.key, p[2]) && live(r, p[3]))
    }
    if (s === `SELECT ${cols} FROM \`${ud}\` WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`) {
      return select((r) => eq(r.user_id, p[0]) && live(r, p[1]))
    }
    if (s === `SELECT ${cols} FROM \`${ud}\` WHERE user_id = ? AND namespace = ? AND (expires_at IS NULL OR expires_at > ?)`) {
      return select((r) => eq(r.user_id, p[0]) && eq(r.namespace, p[1]) && live(r, p[2]))
    }
    if (s === `DELETE FROM \`${ud}\` WHERE user_id = ? AND namespace = ? AND \`key\` = ?`) {
      return remove((r) => eq(r.user_id, p[0]) && eq(r.namespace, p[1]) && eq(r.key, p[2]))
    }
    if (s === `DELETE FROM \`${ud}\` WHERE user_id = ? AND namespace = ?`) {
      return remove((r) => eq(r.user_id, p[0]) && eq(r.namespace, p[1]))
    }
    if (s === `DELETE FROM \`${ud}\` WHERE user_id = ?`) {
      return remove((r) => eq(r.user_id, p[0]))
    }
    if (s === `DELETE FROM \`${ud}\` WHERE expires_at IS NOT NULL AND expires_at <= ?`) {
      return remove((r) => r.expires_at != null && Number(r.expires_at) <= Number(p[0]))
    }
    if (s === `DELETE FROM \`${ud}\` WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`) {
      // mysql2 interpolates the LIMIT placeholder: MySQL only parses a non-negative integer there.
      if (!Number.isSafeInteger(p[1]) || Number(p[1]) < 0) {
        throw Object.assign(new Error('ER_PARSE_ERROR: You have an error in your SQL syntax (LIMIT)'), { errno: 1064 })
      }
      const doomed = new Set(
        [...this.table(ud).values()]
          .filter((r) => r.expires_at != null && Number(r.expires_at) <= Number(p[0]))
          .sort((a, b) => Number(a.expires_at) - Number(b.expires_at))
          .slice(0, Number(p[1])),
      )
      return remove((r) => doomed.has(r))
    }
    return undefined
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

  /** Pool-level query: autocommit, on whichever connection the pool picks. */
  async query(sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult> {
    if (this.ended) throw new Error('FakePool: pool is closed')
    return this.run(null, sql, params)
  }

  /** Execute one statement, on a dedicated connection (`conn`) or in autocommit mode (null). */
  async run(conn: FakeConnection | null, sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult> {
    this.queries.push(conn ? { sql, params, conn } : { sql, params })
    const s = norm(sql)
    const p = params ?? []
    const { messages, chats, contacts, checkpoints, conversations, cursors } = this.t
    const header = (affectedRows: number): MysqlQueryResult => [{ affectedRows } as unknown as Row[], []]
    /** Byte-exact VARBINARY key, as the server sees the parameter. */
    const key = (v: unknown): string => wire(v)

    const failure = this.failures.findIndex((f) => f.match.test(s))
    if (failure !== -1) {
      const [{ error }] = this.failures.splice(failure, 1)
      // InnoDB rolls back the whole transaction of a deadlock victim.
      if (conn?.inTransaction && (error as { errno?: unknown }).errno === 1213) this.endTransaction(conn, true)
      throw error
    }

    /* Transactions --------------------------------------------------------- */
    if (s === 'START TRANSACTION') {
      if (conn == null) throw new Error('FakePool: START TRANSACTION on the pool (use getConnection())')
      if (conn.inTransaction) this.endTransaction(conn, false) // implicit commit, like MySQL
      conn.inTransaction = true
      return header(0)
    }
    if (s === 'COMMIT' || s === 'ROLLBACK') {
      if (conn != null) this.endTransaction(conn, s === 'ROLLBACK')
      return header(0)
    }

    /* DDL ------------------------------------------------------------------ */
    if (s.startsWith('CREATE TABLE IF NOT EXISTS')) {
      const m = /^CREATE TABLE IF NOT EXISTS `([^`]+)`/.exec(s)
      if (m == null) throw new Error(`FakePool: unrecognized CREATE: ${s}`)
      this.table(m[1]) // create empty table
      if (m[1] === this.t.userData) this.classifyUserDataDdl(s)
      return header(0)
    }

    /* messages -------------------------------------------------------------- */
    if (
      s ===
      `INSERT INTO \`${messages}\` (id, chat_id, timestamp, msg) VALUES (?, ?, ?, ?) ` +
        'ON DUPLICATE KEY UPDATE chat_id = VALUES(chat_id), timestamp = VALUES(timestamp), msg = VALUES(msg)'
    ) {
      const [id, chatId, timestamp, msg] = p
      const stored = mysqlJsonIn(msg, `${messages}.msg`)
      const existed = this.table(messages).has(key(id))
      this.table(messages).set(key(id), { id: key(id), chat_id: key(chatId), timestamp: Number(timestamp), msg: stored })
      return header(existed ? 2 : 1)
    }
    if (s === `SELECT msg FROM \`${messages}\` WHERE id = ?`) {
      const row = this.table(messages).get(key(p[0]))
      return [row ? [{ msg: this.jsonOut(String(row.msg)) }] : [], []]
    }
    if (s === `SELECT msg FROM \`${messages}\` WHERE chat_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?`) {
      // mysql2 interpolates the LIMIT placeholder: MySQL only parses a non-negative integer there.
      if (!Number.isSafeInteger(p[1]) || Number(p[1]) < 0) {
        throw Object.assign(new Error('ER_PARSE_ERROR: You have an error in your SQL syntax (LIMIT)'), { errno: 1064 })
      }
      const bytes = (v: unknown): Buffer => Buffer.from(String(v), 'utf8')
      const rows = [...this.table(messages).values()]
        .filter((r) => r.chat_id === key(p[0]))
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || Buffer.compare(bytes(b.id), bytes(a.id)))
        .slice(0, Number(p[1]))
        .map((r) => ({ msg: this.jsonOut(String(r.msg)) }))
      return [rows, []]
    }
    if (s === `SELECT msg FROM \`${messages}\` WHERE id = ? AND chat_id = ?`) {
      const row = this.table(messages).get(key(p[0]))
      return [row && row.chat_id === key(p[1]) ? [{ msg: this.jsonOut(String(row.msg)) }] : [], []]
    }
    if (
      s ===
      `DELETE FROM \`${messages}\` WHERE chat_id = ? AND id IN (?, ?) ` +
        "AND JSON_UNQUOTE(JSON_EXTRACT(msg, '$.ref.id')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(msg, '$.ref.chatId')) = ?"
    ) {
      let n = 0
      for (const id of new Set([key(p[1]), key(p[2])])) {
        const row = this.table(messages).get(id)
        const ref = row ? (JSON.parse(String(row.msg)) as { ref?: { id?: unknown; chatId?: unknown } }).ref : undefined
        if (row && row.chat_id === key(p[0]) && ref?.id === String(p[3]) && ref?.chatId === String(p[4])) {
          this.table(messages).delete(id)
          n++
        }
      }
      return header(n)
    }
    if (s === `DELETE FROM \`${messages}\` WHERE id = ?`) {
      return header(this.table(messages).delete(key(p[0])) ? 1 : 0)
    }
    if (s === `DELETE FROM \`${messages}\` WHERE chat_id = ?`) {
      let n = 0
      for (const [k, r] of this.table(messages)) {
        if (r.chat_id === key(p[0])) {
          this.table(messages).delete(k)
          n++
        }
      }
      return header(n)
    }
    if (
      s ===
      `DELETE FROM \`${messages}\` WHERE chat_id = ? AND id NOT IN ` +
        `(SELECT id FROM (SELECT id FROM \`${messages}\` WHERE chat_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?) keep)`
    ) {
      const chatId = key(p[0])
      const keep = Number(p[2])
      const matching = [...this.table(messages).values()].filter((r) => r.chat_id === chatId)
      // VARBINARY orders by bytes: compare the UTF-8 encodings, not UTF-16 code units.
      const bytes = (v: unknown): Buffer => Buffer.from(String(v), 'utf8')
      matching.sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || Buffer.compare(bytes(b.id), bytes(a.id)))
      const keepIds = new Set(matching.slice(0, keep).map((r) => String(r.id)))
      let n = 0
      for (const [k, r] of this.table(messages)) {
        if (r.chat_id === chatId && !keepIds.has(String(r.id))) {
          this.table(messages).delete(k)
          n++
        }
      }
      return header(n)
    }

    /* chats / contacts (identical shape: id PK + data JSON; row-locked) ------ */
    for (const name of [chats, contacts]) {
      if (s === `INSERT INTO \`${name}\` (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id`) {
        const stored = mysqlJsonIn(p[1], `${name}.data`)
        await this.lock(conn, name, key(p[0]))
        if (this.table(name).has(key(p[0]))) return header(1) // FOUND_ROWS: a no-op duplicate still reports 1
        this.write(conn, name, key(p[0]), { id: key(p[0]), data: stored })
        return header(1)
      }
      if (s === `SELECT data FROM \`${name}\` WHERE id = ? FOR UPDATE`) {
        if (conn == null || !conn.inTransaction) throw new Error(`FakePool: FOR UPDATE outside a transaction: ${s}`)
        await this.lock(conn, name, key(p[0]))
        const row = this.table(name).get(key(p[0]))
        return [row ? [{ data: this.jsonOut(String(row.data)) }] : [], []]
      }
      if (s === `UPDATE \`${name}\` SET data = ? WHERE id = ?`) {
        const stored = mysqlJsonIn(p[0], `${name}.data`)
        await this.lock(conn, name, key(p[1]))
        const row = this.table(name).get(key(p[1]))
        if (row == null) return header(0)
        this.write(conn, name, key(p[1]), { ...row, data: stored })
        return header(1)
      }
      if (s === `SELECT data FROM \`${name}\` WHERE id = ?`) {
        const row = this.table(name).get(key(p[0]))
        return [row ? [{ data: this.jsonOut(String(row.data)) }] : [], []]
      }
      if (s === `SELECT data FROM \`${name}\``) {
        return [[...this.table(name).values()].map((r) => ({ data: this.jsonOut(String(r.data)) })), []]
      }
      if (s === `DELETE FROM \`${name}\` WHERE id = ?`) {
        await this.lock(conn, name, key(p[0]))
        const existed = this.table(name).has(key(p[0]))
        this.write(conn, name, key(p[0]), undefined)
        return header(existed ? 1 : 0)
      }
    }

    /* checkpoints ------------------------------------------------------------- */
    if (s === `INSERT INTO \`${checkpoints}\` (\`key\`, cp) VALUES (?, ?) ON DUPLICATE KEY UPDATE cp = VALUES(cp)`) {
      const stored = mysqlJsonIn(p[1], `${checkpoints}.cp`)
      const existed = this.table(checkpoints).has(key(p[0]))
      this.table(checkpoints).set(key(p[0]), { key: key(p[0]), cp: stored })
      return header(existed ? 2 : 1)
    }
    if (s === `SELECT cp FROM \`${checkpoints}\` WHERE \`key\` = ?`) {
      const row = this.table(checkpoints).get(key(p[0]))
      return [row ? [{ cp: this.jsonOut(String(row.cp)) }] : [], []]
    }
    // Checkpoint compare-and-set (one conditional statement each; see MysqlStore.setCheckpointIf).
    const revisionOf = (row: Row | undefined): number => {
      const doc = row ? (JSON.parse(String(row.cp)) as { revision?: unknown }) : undefined
      return typeof doc?.revision === 'number' ? doc.revision : 0
    }
    if (s === `INSERT IGNORE INTO \`${checkpoints}\` (\`key\`, cp) VALUES (?, ?)`) {
      if (this.table(checkpoints).has(key(p[0]))) return header(0)
      this.table(checkpoints).set(key(p[0]), { key: key(p[0]), cp: mysqlJsonIn(p[1], `${checkpoints}.cp`) })
      return header(1)
    }
    if (s === `UPDATE \`${checkpoints}\` SET cp = ? WHERE \`key\` = ? AND COALESCE(JSON_EXTRACT(cp, '$.revision'), 0) = 0`) {
      const existing = this.table(checkpoints).get(key(p[1]))
      if (!existing || revisionOf(existing) !== 0) {
        // mysql2 connects with FOUND_ROWS: affectedRows counts matched rows, like the server's `info`.
        return [{ affectedRows: 0, info: 'Rows matched: 0  Changed: 0  Warnings: 0' } as unknown as Row[], []]
      }
      const stored = mysqlJsonIn(p[0], `${checkpoints}.cp`)
      const changed = String(existing.cp) !== stored ? 1 : 0
      this.table(checkpoints).set(key(p[1]), { key: key(p[1]), cp: stored })
      return [{ affectedRows: 1, info: `Rows matched: 1  Changed: ${changed}  Warnings: 0` } as unknown as Row[], []]
    }
    if (s === `UPDATE \`${checkpoints}\` SET cp = ? WHERE \`key\` = ? AND JSON_EXTRACT(cp, '$.revision') = ?`) {
      const existing = this.table(checkpoints).get(key(p[1]))
      const doc = existing ? (JSON.parse(String(existing.cp)) as { revision?: unknown }) : undefined
      if (!existing || typeof doc?.revision !== 'number' || doc.revision !== Number(p[2])) {
        return [{ affectedRows: 0, info: 'Rows matched: 0  Changed: 0  Warnings: 0' } as unknown as Row[], []]
      }
      const stored = mysqlJsonIn(p[0], `${checkpoints}.cp`)
      const changed = String(existing.cp) !== stored ? 1 : 0
      this.table(checkpoints).set(key(p[1]), { key: key(p[1]), cp: stored })
      return [{ affectedRows: 1, info: `Rows matched: 1  Changed: ${changed}  Warnings: 0` } as unknown as Row[], []]
    }
    if (s === `DELETE FROM \`${checkpoints}\` WHERE \`key\` = ? AND COALESCE(JSON_EXTRACT(cp, '$.revision'), 0) = ?`) {
      const existing = this.table(checkpoints).get(key(p[0]))
      if (!existing || revisionOf(existing) !== Number(p[1])) return header(0)
      this.table(checkpoints).delete(key(p[0]))
      return header(1)
    }
    if (s === `DELETE FROM \`${checkpoints}\` WHERE \`key\` = ?`) {
      return header(this.table(checkpoints).delete(key(p[0])) ? 1 : 0)
    }
    if (s === `SELECT \`key\`, cp FROM \`${checkpoints}\``) {
      // VARBINARY comes back from mysql2 as a Buffer.
      return [[...this.table(checkpoints).values()].map((r) => ({ key: Buffer.from(String(r.key), 'utf8'), cp: this.jsonOut(String(r.cp)) })), []]
    }

    /* conversations ----------------------------------------------------------- */
    if (
      s === `INSERT INTO \`${conversations}\` (\`key\`, messages) VALUES (?, ?) ON DUPLICATE KEY UPDATE messages = VALUES(messages)`
    ) {
      const stored = mysqlJsonIn(p[1], `${conversations}.messages`)
      const existed = this.table(conversations).has(key(p[0]))
      this.table(conversations).set(key(p[0]), { key: key(p[0]), messages: stored })
      return header(existed ? 2 : 1)
    }
    if (s === `SELECT messages FROM \`${conversations}\` WHERE \`key\` = ?`) {
      const row = this.table(conversations).get(key(p[0]))
      return [row ? [{ messages: this.jsonOut(String(row.messages)) }] : [], []]
    }
    if (s === `DELETE FROM \`${conversations}\` WHERE \`key\` = ?`) {
      return header(this.table(conversations).delete(key(p[0])) ? 1 : 0)
    }

    /* cursors (TEXT value) ------------------------------------------------------ */
    if (s === `INSERT INTO \`${cursors}\` (\`key\`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`) {
      const existed = this.table(cursors).has(key(p[0]))
      this.table(cursors).set(key(p[0]), { key: key(p[0]), value: wire(p[1]) })
      return header(existed ? 2 : 1)
    }
    if (s === `SELECT value FROM \`${cursors}\` WHERE \`key\` = ?`) {
      const row = this.table(cursors).get(key(p[0]))
      return [row ? [{ value: row.value }] : [], []]
    }

    const userData = this.userDataQuery(s, p)
    if (userData) return userData

    throw new Error(`FakePool: statement not implemented: ${s}`)
  }

  async end(): Promise<void> {
    this.ended = true
  }
}
