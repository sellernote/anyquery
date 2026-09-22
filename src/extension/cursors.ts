import type { ResultPage } from '@shared/types'
import type { Cursor } from './drivers/types'

interface Entry {
  connectionId: string
  sessionId: string
  cursor: Cursor
}

/**
 * Holds cursors for results that have more pages to read.
 * Rerunning a query in a tab (session) or closing the tab closes that tab's cursors.
 */
export class CursorRegistry {
  private entries = new Map<string, Entry>()
  private seq = 0

  add(connectionId: string, sessionId: string, cursor: Cursor): string {
    const id = `cursor-${++this.seq}`
    this.entries.set(id, { connectionId, sessionId, cursor })
    return id
  }

  async next(connectionId: string, id: string): Promise<ResultPage> {
    const entry = this.entries.get(id)
    if (!entry || entry.connectionId !== connectionId) {
      throw new Error('This result is already closed. Run the query again.')
    }
    try {
      const page = await entry.cursor.next()
      if (!page.hasMore) await this.close(id)
      return page
    } catch (err) {
      await this.close(id)
      throw err
    }
  }

  /** Closes one cursor, e.g. when a download stops halfway */
  async remove(connectionId: string, id: string): Promise<void> {
    if (this.entries.get(id)?.connectionId === connectionId) await this.close(id)
  }

  async closeSession(connectionId: string, sessionId: string): Promise<void> {
    await this.closeWhere((e) => e.connectionId === connectionId && e.sessionId === sessionId)
  }

  /** Closes the session's cursors that still hold its connection, so it can run other queries. Returns their IDs. */
  releaseSession(connectionId: string, sessionId: string): Promise<string[]> {
    return this.closeWhere((e) => e.connectionId === connectionId && e.sessionId === sessionId && !!e.cursor.busy?.())
  }

  async closeConnection(connectionId: string): Promise<void> {
    await this.closeWhere((e) => e.connectionId === connectionId)
  }

  async closeAll(): Promise<void> {
    await this.closeWhere(() => true)
  }

  private async closeWhere(match: (entry: Entry) => boolean): Promise<string[]> {
    const ids = [...this.entries].filter(([, e]) => match(e)).map(([id]) => id)
    await Promise.all(ids.map((id) => this.close(id)))
    return ids
  }

  private async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    this.entries.delete(id)
    await entry?.cursor.close().catch(() => {})
  }
}
