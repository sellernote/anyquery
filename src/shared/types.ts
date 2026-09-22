export type DbType = 'mysql' | 'postgres' | 'mongodb' | 'redis' | 'opensearch'

export interface ConnectionConfig {
  id: string
  name: string
  type: DbType
  host: string
  port: number
  user?: string
  password?: string
  /** Default database (MySQL, PostgreSQL, MongoDB) */
  database?: string
  /** MongoDB connection URI. If set, used instead of host and port. */
  uri?: string
  /** Use TLS (Redis, OpenSearch) */
  tls?: boolean
  /** Allow self-signed certificates */
  allowInvalidCert?: boolean
}

export type NodeKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'collection'
  | 'index'
  | 'key'
  | 'more'

export interface TreeNode {
  label: string
  kind: NodeKind
  /** Position in the tree. Passed as is to children(). */
  path: string[]
  expandable: boolean
  /** Clicking opens a query for it */
  openable: boolean
  detail?: string
}

export interface QueryResult {
  /** The statement that was run (used for tab titles) */
  statement: string
  columns?: string[]
  rows?: unknown[][]
  /** Raw value for the JSON view */
  json?: unknown
  message?: string
  error?: string
  elapsedMs: number
  /** Set if there is a next page. Pass it to fetchPage. */
  cursorId?: string
  /** More rows follow, but the next page cannot be read */
  truncated?: boolean
  /** Set if the cells can be edited */
  edit?: EditTarget
}

/**
 * Where edited cells are saved. Every database uses the same shape:
 * key columns find the row, and each editable column is saved to a field of that row.
 */
export interface EditTarget {
  /** Shown to the user, e.g. `shop.users` or `books` */
  name: string
  /** Finds the table. Each driver sets its own path and reads it back when saving. */
  path: string[]
  /** Result columns that find the row, such as the primary key or _id. They cannot be edited. */
  keys: { column: number; name: string }[]
  /** The field each result column is saved to. null if the column cannot be edited. */
  columns: (string | null)[]
}

export interface CellChange {
  column: number
  /** The text typed, or null for NULL */
  value: string | null
  /** The value as read */
  old: unknown
}

/** The changed cells of one row */
export interface RowEdit {
  /** Values of the key columns as read, in the order of EditTarget.keys */
  key: unknown[]
  changes: CellChange[]
}

export interface EditRequest {
  target: EditTarget
  rows: RowEdit[]
}

export interface EditResult {
  /** Indexes of the rows saved. A database without transactions can save only some of them. */
  saved: number[]
  message?: string
  error?: string
  /** Cursors closed to free the tab's connection. Their results cannot read more pages. */
  closedCursors: string[]
}

/** The next page read with fetchPage */
export interface ResultPage {
  /** All columns seen so far. Columns can grow page by page (e.g. MongoDB). */
  columns?: string[]
  rows: unknown[][]
  json?: unknown
  /** false on the last page */
  hasMore: boolean
}

export type DownloadFormat = 'csv' | 'json'

export interface DownloadRequest {
  connectionId: string
  /** Suggested file name, without the extension */
  name: string
  /** Picked first in the save dialog */
  format: DownloadFormat
  columns?: string[]
  /** Pages already read */
  pages: { rows: unknown[][]; json?: unknown }[]
  /** Set if more pages follow. They are read into the file, so the cursor ends. */
  cursorId?: string
}

export interface DownloadResult {
  file: string
  rows: number
}

export interface OpenQuery {
  query: string
  database?: string
}

export interface ExecuteContext {
  database?: string
  /** Per-tab session. MySQL and PostgreSQL use a dedicated connection per tab. */
  sessionId: string
}

export const DEFAULT_PORTS: Record<DbType, number> = {
  mysql: 3306,
  postgres: 5432,
  mongodb: 27017,
  redis: 6379,
  opensearch: 9200
}

export const DB_LABELS: Record<DbType, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  mongodb: 'MongoDB',
  redis: 'Redis',
  opensearch: 'OpenSearch'
}

/** Rows per page */
export const PAGE_SIZE = 200

export interface Api {
  listConnections(): Promise<ConnectionConfig[]>
  saveConnection(config: ConnectionConfig): Promise<ConnectionConfig>
  removeConnection(id: string): Promise<void>
  testConnection(config: ConnectionConfig): Promise<string>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  children(id: string, path: string[]): Promise<TreeNode[]>
  databases(id: string): Promise<string[]>
  openQuery(id: string, path: string[]): Promise<OpenQuery>
  execute(id: string, query: string, ctx: ExecuteContext): Promise<QueryResult[]>
  fetchPage(id: string, cursorId: string): Promise<ResultPage>
  closeSession(id: string, sessionId: string): Promise<void>
  /** Saves edited cells on the tab's session */
  saveEdits(id: string, sessionId: string, req: EditRequest): Promise<EditResult>
  /** Webviews cannot show confirm(), so VS Code shows the dialog */
  confirm(message: string, action: string): Promise<boolean>
  copyText(text: string): Promise<void>
  /** Asks where to save the result. Returns null if canceled. */
  download(req: DownloadRequest): Promise<DownloadResult | null>
}
