import type { ExecuteContext, OpenQuery, QueryResult, ResultPage, TreeNode } from '@shared/types'

/** Reads the next page of a result. hasMore is false on the last page. */
export interface Cursor {
  next(): Promise<ResultPage>
  close(): Promise<void>
}

/** A result returned by a driver. Has a cursor if there are more pages. */
export interface DriverResult extends QueryResult {
  cursor?: Cursor
}

export type ResultBody = Omit<DriverResult, 'statement' | 'elapsedMs'>

/** One implementation per database type. To add a database, implement this interface. */
export interface Driver {
  connect(): Promise<void>
  close(): Promise<void>
  /** Returns short server info such as the version */
  ping(): Promise<string>
  children(path: string[]): Promise<TreeNode[]>
  databases(): Promise<string[]>
  openQuery(path: string[]): Promise<OpenQuery>
  /** Results hold only the first page. Read the rest with the cursor. */
  execute(query: string, ctx: ExecuteContext): Promise<DriverResult[]>
  closeSession(sessionId: string): Promise<void>
}
