import mysql, {
  type Connection,
  type ConnectionOptions,
  type FieldPacket,
  type Pool,
  type ResultSetHeader
} from 'mysql2/promise'
import type { Connection as CoreConnection } from 'mysql2'
import {
  PAGE_SIZE,
  type ConnectionConfig,
  type EditRequest,
  type EditTarget,
  type ExecuteContext,
  type OpenQuery,
  type ResultPage,
  type TreeNode
} from '@shared/types'
import { plural } from '@shared/format'
import type { Cursor, Driver, DriverResult, EditOutcome, ResultBody } from './types'
import { runAll, splitSql, timed, toPlain, withTimeout } from './util'
import { saveSqlEdits, sqlEditTarget } from './sqlEdits'

interface Session {
  conn: Connection
  lastUsed: number
}

/** Sessions idle longer than this are pinged before running a query */
const IDLE_CHECK_MS = 30_000

/** Rows buffered ahead of the UI. Smaller results finish right away and do not hold the connection. */
const READ_AHEAD_ROWS = 5_000

/** Close the cursor if the next page is not read within this time. A paused query holds a table metadata lock. */
const CURSOR_IDLE_MS = 5 * 60_000

/** Raised so the server does not drop the connection while a query is paused. Must be longer than CURSOR_IDLE_MS. */
const NET_WRITE_TIMEOUT_S = 600

/** Max time to wait for the query to finish when closing a cursor */
const STOP_TIMEOUT_MS = 5_000

/** Server status flags in OK packets */
const SERVER_STATUS_IN_TRANS = 0x0001
const SERVER_STATUS_AUTOCOMMIT = 0x0002

/** Column types read as binary (shown as hex) or as objects, so the text shown cannot be saved back */
const BIT = 16
const VECTOR = 242
const GEOMETRY = 255
/** String and blob types. Binary when their character set is binary. */
const STRING_TYPES = new Set([15, 249, 250, 251, 252, 253, 254])
const BINARY_CHARSET = 63

export function quoteId(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

export class MysqlDriver implements Driver {
  private pool: Pool | null = null
  private sessions = new Map<string, Session>()

  constructor(private config: ConnectionConfig) {}

  private options(): ConnectionOptions {
    const c = this.config
    return {
      host: c.host,
      port: c.port,
      user: c.user || undefined,
      password: c.password || undefined,
      database: c.database || undefined,
      ssl: c.tls ? { rejectUnauthorized: !c.allowInvalidCert } : undefined,
      connectTimeout: 10_000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false
    }
  }

  async connect(): Promise<void> {
    this.pool = mysql.createPool({ ...this.options(), connectionLimit: 4, enableKeepAlive: true })
    const conn = await this.pool.getConnection()
    conn.release()
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.conn.end()))
    this.sessions.clear()
    await this.pool?.end()
    this.pool = null
  }

  private get db(): Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  private async rows(sql: string, values: unknown[] = []): Promise<unknown[][]> {
    const [rows] = await this.db.query({ sql, values, rowsAsArray: true })
    return rows as unknown[][]
  }

  async ping(): Promise<string> {
    const [[version]] = await this.rows('SELECT VERSION()')
    return `MySQL ${version}`
  }

  async databases(): Promise<string[]> {
    return (await this.rows('SHOW DATABASES')).map((r) => String(r[0]))
  }

  async children(path: string[]): Promise<TreeNode[]> {
    if (path.length === 0) {
      return (await this.databases()).map((name) => ({
        label: name,
        kind: 'database',
        path: [name],
        expandable: true,
        openable: false
      }))
    }
    if (path.length === 1) {
      const rows = await this.rows(
        `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [path[0]]
      )
      return rows.map(([name, type, count]) => ({
        label: String(name),
        kind: type === 'VIEW' ? 'view' : 'table',
        path: [path[0], String(name)],
        expandable: true,
        openable: true,
        detail: type === 'VIEW' ? 'view' : count != null ? `~${count}` : undefined
      }))
    }
    const rows = await this.rows(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [path[0], path[1]]
    )
    return rows.map(([name, type, key]) => ({
      label: String(name),
      kind: 'column',
      path: [...path, String(name)],
      expandable: false,
      openable: false,
      detail: key === 'PRI' ? `${type} · PK` : String(type)
    }))
  }

  async openQuery(path: string[]): Promise<OpenQuery> {
    const [database, table] = path
    return { query: `SELECT * FROM ${quoteId(table)} LIMIT 1000;`, database }
  }

  private async session(id: string): Promise<Connection> {
    const existing = this.sessions.get(id)
    if (existing) {
      if (Date.now() - existing.lastUsed < IDLE_CHECK_MS) {
        existing.lastUsed = Date.now()
        return existing.conn
      }
      try {
        await existing.conn.ping()
        existing.lastUsed = Date.now()
        return existing.conn
      } catch {
        this.sessions.delete(id)
        existing.conn.destroy()
      }
    }
    const conn = await mysql.createConnection(this.options())
    // Catch errors so a dropped connection does not crash the app, and remove it from the sessions
    conn.on('error', () => {
      if (this.sessions.get(id)?.conn === conn) this.sessions.delete(id)
    })
    // Keep the server from dropping the connection while a query is paused between pages
    await conn.query(`SET SESSION net_write_timeout = ${NET_WRITE_TIMEOUT_S}`).catch(() => {})
    this.sessions.set(id, { conn, lastUsed: Date.now() })
    return conn
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    await s?.conn.end().catch(() => s.conn.destroy())
  }

  async execute(query: string, ctx: ExecuteContext): Promise<DriverResult[]> {
    const conn = await this.session(ctx.sessionId)
    if (ctx.database) await conn.query(`USE ${quoteId(ctx.database)}`)
    let last: DriverResult | undefined
    return runAll(splitSql(query), async (sql) => {
      // An open cursor from the previous statement ties up the connection, so close it. Only the last statement can page.
      if (last?.cursor) {
        await last.cursor.close()
        last.cursor = undefined
        last.truncated = true
      }
      let fields: FieldPacket[] | undefined
      last = await timed(sql, async () => {
        const cursor = await this.query(conn, sql, ctx.sessionId)
        fields = cursor.fields
        return cursor.body
      })
      if (fields && last.columns) last.edit = await this.editTarget(fields)
      return last
    })
  }

  /**
   * Results from one table with its primary key can be edited. MySQL tells which table and alias
   * each column came from, so a table read twice (a self join) shows up as two sources.
   */
  private async editTarget(fields: FieldPacket[]): Promise<EditTarget | undefined> {
    const source = (f: FieldPacket) => (f.orgTable && f.db ? JSON.stringify([f.db, f.orgTable, f.table]) : undefined)
    const sources = new Set(fields.map(source).filter(Boolean))
    if (sources.size !== 1) return
    const [key] = sources
    const [database, table] = JSON.parse(key!) as string[]
    try {
      const rows = await this.rows(
        `SELECT c.COLUMN_NAME, k.COLUMN_NAME IS NOT NULL, c.EXTRA
         FROM information_schema.COLUMNS c
         LEFT JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
           AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY'
         WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?`,
        [database, table]
      )
      // Generated columns cannot be set. DEFAULT_GENERATED only means the default is an expression.
      const generated = new Set(rows.filter((r) => /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.test(String(r[2]))).map((r) => String(r[0])))
      return sqlEditTarget(
        `${database}.${table}`,
        [database, table],
        fields.map((f) => (source(f) === key && !generated.has(f.orgName) ? f.orgName : null)),
        rows.filter((r) => Number(r[1])).map((r) => String(r[0])),
        (i) => isEditable(fields[i])
      )
    } catch {
      return
    }
  }

  async saveEdits(sessionId: string, req: EditRequest): Promise<EditOutcome> {
    const conn = await this.session(sessionId)
    const [database, table] = req.target.path
    const run = async (sql: string, values?: unknown[]) => {
      const [header] = await conn.query(sql, values)
      return header as ResultSetHeader
    }
    // With autocommit off, a transaction is always open
    const { serverStatus } = await run('DO 0')
    const inTransaction = (serverStatus & SERVER_STATUS_IN_TRANS) !== 0 || (serverStatus & SERVER_STATUS_AUTOCOMMIT) === 0
    return saveSqlEdits(
      // The connection reports matched rows, not changed rows (FOUND_ROWS), so an unchanged row counts too
      { inTransaction, run: async (sql, values) => (await run(sql, values)).affectedRows },
      { table: `${quoteId(database)}.${quoteId(table)}`, quote: quoteId, param: () => '?' },
      req
    )
  }

  private async query(
    conn: Connection,
    sql: string,
    sessionId: string
  ): Promise<{ body: ResultBody; fields?: FieldPacket[] }> {
    // Streaming needs the callback-style connection inside the promise wrapper
    const core = (conn as unknown as { connection: CoreConnection }).connection
    const cursor = new MysqlCursor(core, sql, {
      kill: async () => {
        await this.db.query(`KILL QUERY ${Number(core.threadId)}`)
      },
      drop: () => {
        if (this.sessions.get(sessionId)?.conn === conn) this.sessions.delete(sessionId)
        conn.destroy()
      }
    })
    try {
      return { body: await cursor.first(), fields: cursor.fields }
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) this.sessions.delete(sessionId)
      throw err
    }
  }
}

interface CursorHooks {
  /** Stops the query running on the server (KILL QUERY) */
  kill(): Promise<void>
  /** Removes the connection from the sessions and closes it when it can no longer be used */
  drop(): void
}

/**
 * Streams results and hands them out page by page.
 * Pauses socket reads once READ_AHEAD_ROWS rows are buffered. While paused, the connection cannot run other queries.
 */
class MysqlCursor implements Cursor {
  fields?: FieldPacket[]
  private columns?: string[]
  private header?: ResultSetHeader
  private buffer: unknown[][] = []
  private ended = false
  private error?: Error
  private paused = false
  private closing = false
  private expired = false
  private closed?: Promise<void>
  private idleTimer?: NodeJS.Timeout
  private waiters: (() => void)[] = []

  constructor(
    private conn: CoreConnection,
    sql: string,
    private hooks: CursorHooks
  ) {
    // When the connection drops, the error goes to the connection, not the query
    const onConnError = (err: Error) => {
      this.error ??= err
      this.finish()
    }
    conn.on('error', onConnError)

    let sets = 0
    const query = conn.query({ sql, rowsAsArray: true })
    query.on('fields', (fields?: FieldPacket[]) => {
      sets++
      if (sets === 1 && fields) {
        this.fields = fields
        this.columns = fields.map((f) => f.name)
      }
    })
    query.on('result', (row: unknown) => {
      // With multiple result sets (e.g. CALL), use only the first
      if (sets !== 1 || this.closing) return
      if (!this.columns) {
        this.header = row as ResultSetHeader
        return
      }
      this.buffer.push((row as unknown[]).map(toPlain))
      if (this.buffer.length >= READ_AHEAD_ROWS && !this.paused) {
        this.paused = true
        conn.pause()
      }
      this.wake()
    })
    query.on('error', (err: Error) => {
      this.error ??= err
      this.wake()
    })
    query.on('end', () => {
      conn.removeListener('error', onConnError)
      this.finish()
    })
  }

  /** Reads the first page. For statements without a result set (INSERT etc.), returns the affected row count. */
  async first(): Promise<ResultBody> {
    const { rows, hasMore } = await this.take()
    if (!this.columns) return { message: describeHeader(this.header) }
    return {
      columns: this.columns,
      rows,
      message: hasMore ? undefined : plural(rows.length, 'row'),
      cursor: hasMore ? this : undefined
    }
  }

  async next(): Promise<ResultPage> {
    return this.take()
  }

  busy(): boolean {
    return !this.ended
  }

  close(): Promise<void> {
    clearTimeout(this.idleTimer)
    this.buffer = []
    this.closing = true
    this.closed ??= this.stop()
    return this.closed
  }

  /** Takes one page. Keeps one extra row buffered to tell whether more follow. */
  private async take(): Promise<{ rows: unknown[][]; hasMore: boolean }> {
    clearTimeout(this.idleTimer)
    await this.until(() => this.buffer.length > PAGE_SIZE || this.ended)
    if (this.expired) throw new Error('The result was closed because no page was read for 5 minutes. Run the query again.')
    if (this.closing) throw new Error('This result is already closed. Run the query again.')
    if (this.error) throw this.error
    const rows = this.buffer.splice(0, PAGE_SIZE)
    if (this.buffer.length < READ_AHEAD_ROWS) this.resume()
    const hasMore = this.buffer.length > 0
    if (!this.ended) {
      this.idleTimer = setTimeout(() => {
        this.expired = true
        this.close()
      }, CURSOR_IDLE_MS)
    }
    return { rows, hasMore }
  }

  /** If the query is still running, discards the remaining rows and waits for it to finish */
  private async stop(): Promise<void> {
    if (this.ended) return
    this.resume()
    // A small remainder finishes quickly. Kill the query on the server only if it does not.
    if (await this.waitEnd(500)) return
    await withTimeout(this.hooks.kill(), STOP_TIMEOUT_MS).catch(() => {})
    if (await this.waitEnd(STOP_TIMEOUT_MS)) return
    // If it still does not finish, drop the connection. The tab's session state (variables, transactions) is lost.
    this.hooks.drop()
    this.finish()
  }

  private waitEnd(ms: number): Promise<boolean> {
    return withTimeout(
      this.until(() => this.ended),
      ms
    ).then(
      () => true,
      () => false
    )
  }

  private resume(): void {
    if (!this.paused) return
    this.paused = false
    this.conn.resume()
  }

  private finish(): void {
    this.ended = true
    clearTimeout(this.idleTimer)
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  private async until(done: () => boolean): Promise<void> {
    while (!done()) await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
}

function isEditable(field: FieldPacket): boolean {
  const type = field.columnType ?? field.type
  if (type === BIT || type === VECTOR || type === GEOMETRY) return false
  return !(type !== undefined && STRING_TYPES.has(type) && field.characterSet === BINARY_CHARSET)
}

function describeHeader(header: ResultSetHeader | undefined): string {
  if (!header) return 'Done'
  const parts = [`Affected rows: ${header.affectedRows}`]
  if (header.insertId) parts.push(`insertId: ${header.insertId}`)
  if (header.warningStatus) parts.push(`Warnings: ${header.warningStatus}`)
  return parts.join(', ')
}
