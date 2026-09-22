import { create } from 'zustand'
import type { ConnectionConfig, DbType, DownloadFormat, QueryResult } from '@shared/types'
import { api } from './api'

export type ConnStatus = 'connecting' | 'connected' | 'error'

/** A query result and the pages read so far */
export interface ResultState extends QueryResult {
  /** Page 0 is the first page from the query result. Cursors only move forward, so every page read is kept. */
  pages: { rows: unknown[][]; json?: unknown }[]
  /** Index of the page being viewed */
  page: number
  /** More rows follow the last page read */
  hasMore: boolean
  loading: boolean
  downloading?: boolean
  pageError?: string
  /** Why paging stopped early, e.g. after a download read the rest */
  pageNote?: string
}

export interface Tab {
  id: string
  connectionId: string
  title: string
  database?: string
  query: string
  results: ResultState[]
  running: boolean
  /** Incremented on every new result to reset the result view (selected result, sort) */
  runId: number
}

interface State {
  connections: ConnectionConfig[]
  status: Record<string, ConnStatus | undefined>
  tabs: Tab[]
  activeTabId?: string
  /** Connection dialog. undefined means closed, null means a new connection */
  editing: ConnectionConfig | null | undefined
  /** Full view of a cell value */
  preview: { title: string; value: unknown } | undefined

  load(): Promise<void>
  saveConnection(config: ConnectionConfig): Promise<void>
  removeConnection(id: string): Promise<void>
  setStatus(id: string, status: ConnStatus | undefined): void
  disconnect(id: string): Promise<void>
  openTab(connectionId: string, init?: { query?: string; database?: string; title?: string }): string
  updateTab(id: string, patch: Partial<Tab>): void
  closeTab(id: string): void
  runTab(id: string, text?: string): Promise<void>
  /** Shows a page of a result. Reads the next page from the extension if it has not been read yet. */
  showPage(tabId: string, index: number, page: number): Promise<void>
  /** Saves a result to a file. Returns true if saved. */
  download(tabId: string, index: number, format: DownloadFormat): Promise<boolean>
  setEditing(config: ConnectionConfig | null | undefined): void
  setPreview(preview: State['preview']): void
}

export const DEFAULT_QUERY: Record<DbType, string> = {
  mysql: '-- Press Cmd+Enter (Ctrl+Enter) to run. Select text to run only that part.\nSHOW TABLES;\n',
  postgres:
    "-- Press Cmd+Enter (Ctrl+Enter) to run. Select text to run only that part.\nSELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');\n",
  mongodb: '// Example: db.users.find({ age: { $gt: 20 } }).sort({ _id: -1 }).limit(20)\nshow collections\n',
  redis: '# One command per line\nDBSIZE\n',
  opensearch: '# Same syntax as Kibana Dev Tools\nGET _cat/indices\n'
}

let tabSeq = 0

/** Updates one result. Skipped if the tab was rerun in the meantime, so stale results are dropped. */
function patchResult(tab: Tab, index: number, fn: (r: ResultState) => Partial<ResultState>): void {
  useStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id !== tab.id || t.runId !== tab.runId
        ? t
        : { ...t, results: t.results.map((r, i) => (i === index ? { ...r, ...fn(r) } : r)) }
    )
  }))
}

function toState(result: QueryResult): ResultState {
  return {
    ...result,
    pages: [{ rows: result.rows ?? [], json: result.json }],
    page: 0,
    hasMore: !!result.cursorId,
    loading: false
  }
}

export const useStore = create<State>((set, get) => ({
  connections: [],
  status: {},
  tabs: [],
  activeTabId: undefined,
  editing: undefined,
  preview: undefined,

  async load() {
    set({ connections: await api.listConnections() })
  },

  async saveConnection(config) {
    const saved = await api.saveConnection(config)
    set((s) => {
      const exists = s.connections.some((c) => c.id === saved.id)
      return {
        connections: exists ? s.connections.map((c) => (c.id === saved.id ? saved : c)) : [...s.connections, saved],
        status: { ...s.status, [saved.id]: undefined }
      }
    })
  },

  async removeConnection(id) {
    await api.removeConnection(id)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.connectionId !== id)
      return {
        connections: s.connections.filter((c) => c.id !== id),
        tabs,
        activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs.at(-1)?.id
      }
    })
  },

  setStatus(id, status) {
    set((s) => ({ status: { ...s.status, [id]: status } }))
  },

  async disconnect(id) {
    await api.disconnect(id)
    get().setStatus(id, undefined)
  },

  openTab(connectionId, init = {}) {
    const conn = get().connections.find((c) => c.id === connectionId)
    if (!conn) throw new Error('Connection not found')
    const id = `tab-${++tabSeq}`
    const tab: Tab = {
      id,
      connectionId,
      title: init.title ?? conn.name,
      database: init.database ?? (conn.type === 'redis' ? 'db0' : conn.database || undefined),
      query: init.query ?? DEFAULT_QUERY[conn.type],
      results: [],
      running: false,
      runId: 0
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    return id
  },

  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  },

  closeTab(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab) api.closeSession(tab.connectionId, tab.id).catch(() => {})
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? undefined) : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  async runTab(id, text) {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.running) return
    const query = text ?? tab.query
    if (!query.trim()) return
    get().updateTab(id, { running: true })
    get().setStatus(tab.connectionId, get().status[tab.connectionId] ?? 'connecting')
    let results: QueryResult[]
    try {
      results = await api.execute(tab.connectionId, query, { database: tab.database, sessionId: tab.id })
      get().setStatus(tab.connectionId, 'connected')
    } catch (err) {
      results = [{ statement: '', error: (err as Error).message, elapsedMs: 0 }]
      get().setStatus(tab.connectionId, 'error')
    }
    const current = get().tabs.find((t) => t.id === id)
    if (current) get().updateTab(id, { running: false, results: results.map(toState), runId: current.runId + 1 })
  },

  async showPage(tabId, index, page) {
    const tab = get().tabs.find((t) => t.id === tabId)
    const result = tab?.results[index]
    if (!tab || !result || result.loading || result.downloading || page < 0) return
    const patch = (fn: (r: ResultState) => Partial<ResultState>) => patchResult(tab, index, fn)
    if (page < result.pages.length) {
      patch(() => ({ page }))
      return
    }
    if (page !== result.pages.length || !result.hasMore || !result.cursorId || tab.running) return
    patch(() => ({ loading: true, pageError: undefined }))
    try {
      const next = await api.fetchPage(tab.connectionId, result.cursorId)
      patch((r) => ({
        pages: [...r.pages, { rows: next.rows, json: next.json }],
        columns: next.columns ?? r.columns,
        page,
        hasMore: next.hasMore,
        loading: false
      }))
    } catch (err) {
      // The extension closed the cursor, so no more pages can be read
      patch(() => ({ loading: false, hasMore: false, cursorId: undefined, pageError: (err as Error).message }))
    }
  },

  async download(tabId, index, format) {
    const tab = get().tabs.find((t) => t.id === tabId)
    const result = tab?.results[index]
    if (!tab || !result || tab.running || result.loading || result.downloading) return false
    const cursorId = result.hasMore ? result.cursorId : undefined
    // Pages after the ones already read go into the file, so this tab can no longer page past them
    const ended = { hasMore: false, cursorId: undefined }
    patchResult(tab, index, () => ({ downloading: true, pageError: undefined }))
    try {
      const saved = await api.download({
        connectionId: tab.connectionId,
        name: tab.title,
        format,
        columns: result.columns,
        pages: result.pages,
        cursorId
      })
      patchResult(tab, index, () =>
        saved && cursorId
          ? { ...ended, downloading: false, pageNote: 'The rest of the rows went into the download. Run the query again to page further.' }
          : { downloading: false }
      )
      return !!saved
    } catch (err) {
      patchResult(tab, index, () => ({ ...(cursorId && ended), downloading: false, pageError: (err as Error).message }))
      return false
    }
  },

  setEditing(editing) {
    set({ editing })
  },

  setPreview(preview) {
    set({ preview })
  }
}))
