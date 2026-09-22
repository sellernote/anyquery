import { Client, Pool, types, type ClientConfig, type CustomTypesConfig, type QueryResult } from 'pg'
import PgCursor from 'pg-cursor'
import {
  PAGE_SIZE,
  type ConnectionConfig,
  type ExecuteContext,
  type OpenQuery,
  type ResultPage,
  type TreeNode
} from '@shared/types'
import { plural } from '@shared/format'
import type { Cursor, Driver, DriverResult, ResultBody } from './types'
import { runAll, splitPgSql, timed, toPlain, withTimeout } from './util'

interface Session {
  client: Client
  database: string
  lastUsed: number
}

/** Sessions idle longer than this are pinged before running a query */
const IDLE_CHECK_MS = 30_000

/** Rows read ahead of the UI. Smaller results finish right away and do not hold the connection. */
const READ_AHEAD_ROWS = 5_000

/** Close the cursor if the next page is not read within this time. An open cursor keeps its transaction and locks. */
const CURSOR_IDLE_MS = 5 * 60_000

/** Max time to wait for the server when closing a cursor */
const STOP_TIMEOUT_MS = 5_000

/**
 * Date and time types stay as the server's text, like MySQL's dateStrings.
 * As JS Dates, a date column would shift by the local time zone.
 */
const TEXT_TYPES = new Set([
  1082, 1083, 1114, 1184, 1186, 1266, // date, time, timestamp, timestamptz, interval, timetz
  1182, 1183, 1115, 1185, 1187, 1270 // arrays of the above
])

const typeParsers = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    TEXT_TYPES.has(oid) ? (value: string) => value : types.getTypeParser(oid, format as 'text')
} as CustomTypesConfig

export function quotePgId(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export class PostgresDriver implements Driver {
  /** A connection opens only one database, so the tree uses a small pool per database */
  private pools = new Map<string, Pool>()
  private sessions = new Map<string, Session>()

  constructor(private config: ConnectionConfig) {}

  /** Without a default database, use postgres. Almost every server has it. */
  private get defaultDatabase(): string {
    return this.config.database || 'postgres'
  }

  private options(database: string): ClientConfig {
    const c = this.config
    return {
      host: c.host,
      port: c.port,
      user: c.user || undefined,
      password: c.password || undefined,
      database,
      ssl: c.tls ? { rejectUnauthorized: !c.allowInvalidCert } : false,
      connectionTimeoutMillis: 10_000,
      application_name: 'AnyQuery',
      types: typeParsers
    }
  }

  private pool(database: string): Pool {
    let pool = this.pools.get(database)
    if (!pool) {
      pool = new Pool({ ...this.options(database), max: 2, idleTimeoutMillis: 60_000 })
      // A dropped idle connection emits an error on the pool. Without a listener it crashes the extension host.
      pool.on('error', () => {})
      this.pools.set(database, pool)
    }
    return pool
  }

  private async rows(database: string, text: string, values: unknown[] = []): Promise<unknown[][]> {
    const result = await this.pool(database).query({ text, values, rowMode: 'array' })
    return result.rows
  }

  async connect(): Promise<void> {
    await this.rows(this.defaultDatabase, 'SELECT 1')
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.client.end()))
    this.sessions.clear()
    await Promise.allSettled([...this.pools.values()].map((p) => p.end()))
    this.pools.clear()
  }

  async ping(): Promise<string> {
    const [[version]] = await this.rows(this.defaultDatabase, 'SHOW server_version')
    return `PostgreSQL ${version}`
  }

  async databases(): Promise<string[]> {
    const rows = await this.rows(
      this.defaultDatabase,
      'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname'
    )
    return rows.map((r) => String(r[0]))
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
    const [database, schema, table] = path
    if (path.length === 1) {
      const rows = await this.rows(
        database,
        `SELECT nspname FROM pg_namespace
         WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname`
      )
      return rows.map(([name]) => ({
        label: String(name),
        kind: 'schema',
        path: [database, String(name)],
        expandable: true,
        openable: false
      }))
    }
    if (path.length === 2) {
      // Partitions are left out. Their parent table shows all rows.
      const rows = await this.rows(
        database,
        `SELECT c.relname, c.relkind, c.reltuples::bigint FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
         ORDER BY c.relname`,
        [schema]
      )
      return rows.map(([name, kind, count]) => ({
        label: String(name),
        kind: kind === 'v' || kind === 'm' ? 'view' : 'table',
        path: [database, schema, String(name)],
        expandable: true,
        openable: true,
        detail: RELKIND_DETAIL[String(kind)] ?? (Number(count) >= 0 ? `~${count}` : undefined)
      }))
    }
    const rows = await this.rows(
      database,
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), COALESCE(a.attnum = ANY (i.indkey), false)
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table]
    )
    return rows.map(([name, type, pk]) => ({
      label: String(name),
      kind: 'column',
      path: [...path, String(name)],
      expandable: false,
      openable: false,
      detail: pk ? `${type} · PK` : String(type)
    }))
  }

  async openQuery(path: string[]): Promise<OpenQuery> {
    const [database, schema, table] = path
    return { query: `SELECT * FROM ${quotePgId(schema)}.${quotePgId(table)} LIMIT 1000;`, database }
  }

  private async session(id: string, database: string): Promise<Client> {
    const existing = this.sessions.get(id)
    if (existing && existing.database !== database) {
      // A connection cannot switch databases, so open a new one. Variables and transactions are lost.
      await this.closeSession(id)
    } else if (existing) {
      if (Date.now() - existing.lastUsed < IDLE_CHECK_MS) {
        existing.lastUsed = Date.now()
        return existing.client
      }
      try {
        await existing.client.query('SELECT 1')
        existing.lastUsed = Date.now()
        return existing.client
      } catch {
        this.drop(id, existing.client)
      }
    }
    const client = new Client(this.options(database))
    // Catch errors so a dropped connection does not crash the extension host, and remove it from the sessions
    client.on('error', () => this.drop(id, client))
    await client.connect()
    this.sessions.set(id, { client, database, lastUsed: Date.now() })
    return client
  }

  private drop(id: string, client: Client): void {
    if (this.sessions.get(id)?.client === client) this.sessions.delete(id)
    client.end().catch(() => {})
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    await s?.client.end().catch(() => {})
  }

  async execute(query: string, ctx: ExecuteContext): Promise<DriverResult[]> {
    const client = await this.session(ctx.sessionId, ctx.database || this.defaultDatabase)
    let last: DriverResult | undefined
    return runAll(splitPgSql(query), async (sql) => {
      // An open cursor from the previous statement ties up the connection, so close it. Only the last statement can page.
      if (last?.cursor) {
        await last.cursor.close()
        last.cursor = undefined
        last.truncated = true
      }
      last = await timed(sql, () => {
        const cursor = client.query(new PgCursor<unknown[]>(sql, undefined, { rowMode: 'array', types: typeParsers }))
        return new PostgresCursor(cursor, () => this.drop(ctx.sessionId, client)).first()
      })
      return last
    })
  }
}

const RELKIND_DETAIL: Record<string, string> = {
  v: 'view',
  m: 'materialized view',
  f: 'foreign table',
  p: 'partitioned'
}

/**
 * Reads a server-side cursor READ_AHEAD_ROWS rows at a time and hands them out page by page.
 * Until every row is read, the connection cannot run other queries.
 */
class PostgresCursor implements Cursor {
  private buffer: unknown[][] = []
  private ended = false
  private expired = false
  private closed?: Promise<void>
  private idleTimer?: NodeJS.Timeout

  constructor(
    private cursor: PgCursor<unknown[]>,
    private drop: () => void
  ) {}

  /** Reads the first page. For statements without rows (INSERT etc.), returns the affected row count. */
  async first(): Promise<ResultBody> {
    const { rows, hasMore, result } = await this.take()
    if (!result?.fields.length) return { message: describeCommand(result) }
    return {
      columns: result.fields.map((f) => f.name),
      rows,
      message: hasMore ? undefined : plural(rows.length, 'row'),
      cursor: hasMore ? this : undefined
    }
  }

  async next(): Promise<ResultPage> {
    const { rows, hasMore } = await this.take()
    return { rows, hasMore }
  }

  close(): Promise<void> {
    clearTimeout(this.idleTimer)
    this.buffer = []
    // If the server does not answer, drop the connection. The tab's session state is lost.
    this.closed ??= this.ended ? Promise.resolve() : withTimeout(this.cursor.close(), STOP_TIMEOUT_MS).catch(this.drop)
    return this.closed
  }

  /** Takes one page. Keeps one extra row buffered to tell whether more follow. */
  private async take(): Promise<{ rows: unknown[][]; hasMore: boolean; result?: QueryResult }> {
    clearTimeout(this.idleTimer)
    if (this.expired) throw new Error('The result was closed because no page was read for 5 minutes. Run the query again.')
    if (this.closed) throw new Error('This result is already closed. Run the query again.')
    let result: QueryResult | undefined
    if (!this.ended && this.buffer.length <= PAGE_SIZE) {
      const read = await this.read(READ_AHEAD_ROWS)
      result = read.result
      this.buffer.push(...read.rows.map((row) => row.map(toPlain)))
      // The server ends the cursor once it runs out of rows, and the connection is free again
      if (read.rows.length < READ_AHEAD_ROWS) this.ended = true
    }
    const rows = this.buffer.splice(0, PAGE_SIZE)
    const hasMore = this.buffer.length > 0
    // Rows already read stay in memory, so only an unfinished cursor expires
    if (hasMore && !this.ended) {
      this.idleTimer = setTimeout(() => {
        this.expired = true
        this.close()
      }, CURSOR_IDLE_MS)
    }
    return { rows, hasMore, result }
  }

  private read(count: number): Promise<{ rows: unknown[][]; result: QueryResult }> {
    return new Promise((resolve, reject) => {
      this.cursor.read(count, (err, rows, result) => (err ? reject(withDetail(err)) : resolve({ rows, result })))
    })
  }
}

function describeCommand(result: QueryResult | undefined): string {
  if (!result?.command) return 'Done'
  return result.rowCount == null ? result.command : `${result.command}: ${plural(result.rowCount, 'row')}`
}

/** Adds the server's DETAIL and HINT to the message */
function withDetail(err: Error): Error {
  const { detail, hint } = err as { detail?: string; hint?: string }
  if (!detail && !hint) return err
  return new Error([err.message, detail && `DETAIL: ${detail}`, hint && `HINT: ${hint}`].filter(Boolean).join('\n'))
}
