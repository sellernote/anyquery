import { Client } from '@opensearch-project/opensearch'
import type { ConnectionConfig, OpenQuery, TreeNode } from '@shared/types'
import { plural } from '@shared/format'
import type { Cursor, Driver, DriverResult, ResultBody } from './types'
import { errorMessage, objectsToTable, paginate, runAll, timed } from './util'

const REQUEST_LINE = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S+)\s*$/i
const NDJSON_PATH = /(^|\/)(_bulk|_msearch|_msearch\/template)(\?|$)/

interface Request {
  method: string
  path: string
  body: string
}

type RequestParams = Parameters<Client['transport']['request']>[0]

/** Splits Kibana Dev Tools syntax into a list of requests */
export function parseRequests(text: string): Request[] {
  const requests: Request[] = []
  let current: Request | null = null
  for (const line of text.split('\n')) {
    const m = REQUEST_LINE.exec(line)
    if (m) {
      current = { method: m[1].toUpperCase(), path: m[2], body: '' }
      requests.push(current)
      continue
    }
    const trimmed = line.trim()
    if (!current) {
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
        throw new Error('A request must start with a method and a path, such as "GET /index/_search"')
      }
      continue
    }
    if (!current.body && (trimmed.startsWith('#') || trimmed.startsWith('//'))) continue
    current.body += line + '\n'
  }
  return requests
}

export class OpenSearchDriver implements Driver {
  private client: Client | null = null

  constructor(private config: ConnectionConfig) {}

  private get os(): Client {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  private node(): string {
    const c = this.config
    const host = c.host.trim().replace(/\/+$/, '')
    if (host.includes('://')) {
      const url = new URL(host)
      if (!url.port && c.port) url.port = String(c.port)
      return url.toString().replace(/\/+$/, '')
    }
    return `${c.tls ? 'https' : 'http'}://${host}:${c.port}`
  }

  async connect(): Promise<void> {
    const c = this.config
    this.client = new Client({
      node: this.node(),
      auth: c.user ? { username: c.user, password: c.password ?? '' } : undefined,
      ssl: { rejectUnauthorized: !c.allowInvalidCert },
      requestTimeout: 60_000
    })
    await this.os.info()
  }

  async close(): Promise<void> {
    await this.client?.close()
    this.client = null
  }

  async ping(): Promise<string> {
    const { body } = await this.os.info()
    const v = body.version as { distribution?: string; number?: string }
    return `${v.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'} ${v.number}`
  }

  async databases(): Promise<string[]> {
    return []
  }

  async children(path: string[]): Promise<TreeNode[]> {
    if (path.length > 0) return []
    const { body } = await this.os.cat.indices({ format: 'json', h: ['index', 'docs.count', 'health'] })
    const indices = body as unknown as { index: string; 'docs.count'?: string }[]
    // Put system indices (starting with a dot) last
    indices.sort((a, b) => {
      const sa = a.index.startsWith('.') ? 1 : 0
      const sb = b.index.startsWith('.') ? 1 : 0
      return sa - sb || a.index.localeCompare(b.index)
    })
    return indices.map((i) => ({
      label: i.index,
      kind: 'index',
      path: [i.index],
      expandable: false,
      openable: true,
      detail: i['docs.count'] != null ? `${i['docs.count']} docs` : undefined
    }))
  }

  async openQuery(path: string[]): Promise<OpenQuery> {
    const body = JSON.stringify({ size: 100, query: { match_all: {} } }, null, 2)
    return { query: `GET /${path[0]}/_search\n${body}` }
  }

  async closeSession(): Promise<void> {}

  async execute(query: string): Promise<DriverResult[]> {
    const requests = parseRequests(query)
    if (requests.length === 0) throw new Error('No request to run')
    // Like Kibana, keep sending the rest even if a request fails
    return runAll(requests, (req) => timed(`${req.method} ${req.path}`, () => this.send(req)), {
      stopOnError: false
    })
  }

  private async send(req: Request): Promise<ResultBody> {
    const url = new URL(req.path.startsWith('/') ? req.path : `/${req.path}`, 'http://x')
    const querystring = Object.fromEntries(url.searchParams)
    // Request _cat APIs as JSON to show them as a table
    if (url.pathname.startsWith('/_cat') && !querystring.format) querystring.format = 'json'

    const text = req.body.trim()
    const params: RequestParams = {
      method: req.method,
      path: url.pathname,
      querystring
    }
    if (text) {
      if (NDJSON_PATH.test(url.pathname)) {
        params.bulkBody = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } else {
        try {
          params.body = JSON.parse(text)
        } catch (err) {
          throw new Error(`Invalid JSON body: ${errorMessage(err)}`)
        }
      }
    }

    // The client turns params.body into a string after sending. Keep the original for next-page requests.
    const original: RequestParams = { ...params, querystring: { ...querystring } }
    try {
      const res = await this.os.transport.request(params)
      const result = formatResponse(res.body, res.statusCode ?? 200)
      return { ...result, cursor: result.cursor ?? this.searchCursor(original, res.body, result.columns) }
    } catch (err) {
      const meta = (err as { meta?: { body?: unknown; statusCode?: number } }).meta
      if (meta?.body !== undefined) {
        const reason = describeError(meta.body)
        return { error: `${meta.statusCode ?? ''} ${reason}`.trim(), json: meta.body }
      }
      throw err
    }
  }

  /**
   * For _search results, returns a cursor that resends the same request with a larger from.
   * scroll and search_after are paged by the user, so they are left alone.
   */
  private searchCursor(params: RequestParams, body: unknown, columns?: string[]): Cursor | undefined {
    if (!/\/_search$/.test(params.path) || (params.method !== 'GET' && params.method !== 'POST')) return
    const querystring = (params.querystring ?? {}) as Record<string, string>
    const reqBody = (params.body ?? {}) as Record<string, unknown>
    if (querystring.scroll || reqBody.search_after !== undefined) return
    const size = Number(querystring.size ?? reqBody.size ?? 10)
    let from = Number(querystring.from ?? reqBody.from ?? 0)
    if (!(size > 0) || !hasMoreHits(body, from, size)) return
    return {
      next: async () => {
        from += size
        const next: RequestParams = { ...params, querystring: { ...querystring }, body: { ...reqBody } }
        if (querystring.from !== undefined) (next.querystring as Record<string, string>).from = String(from)
        else (next.body as Record<string, unknown>).from = from
        let res
        try {
          res = await this.os.transport.request(next)
        } catch (err) {
          const meta = (err as { meta?: { body?: unknown; statusCode?: number } }).meta
          if (meta?.body !== undefined) throw new Error(`${meta.statusCode ?? ''} ${describeError(meta.body)}`.trim())
          throw err
        }
        const table = hitsTable(res.body, columns)
        columns = table?.columns
        return { ...table, rows: table?.rows ?? [], json: res.body, hasMore: hasMoreHits(res.body, from, size) }
      },
      close: async () => {}
    }
  }
}

/** It is the last page if fewer than size hits came back or the total is reached */
function hasMoreHits(body: unknown, from: number, size: number): boolean {
  const hits = (body as { hits?: { hits?: unknown[]; total?: { value: number; relation?: string } | number } }).hits
  const count = hits?.hits?.length ?? 0
  if (count === 0 || count < size) return false
  const total = hits?.total
  if (typeof total === 'number') return from + count < total
  if (total?.relation === 'eq') return from + count < total.value
  // If the total is unknown (relation: gte, track_total_hits: false), a full page means there may be more
  return true
}

function describeError(body: unknown): string {
  const e = (body as { error?: { type?: string; reason?: string; root_cause?: { reason?: string }[] } | string })
    ?.error
  if (typeof e === 'string') return e
  if (e?.type || e?.reason) {
    // Top-level messages like "all shards failed" often hide the real cause
    const cause = e.root_cause?.[0]?.reason
    return `${e.type ?? ''}: ${e.reason ?? ''}${cause && cause !== e.reason ? ` (${cause})` : ''}`
  }
  return typeof body === 'string' ? body : JSON.stringify(body)
}

interface Hit {
  _index: string
  _id: string
  _score?: number | null
  _source?: Record<string, unknown>
  fields?: Record<string, unknown>
}

/** Turns search hits into a table. Returns undefined if there are no hits */
function hitsTable(body: unknown, known?: string[]): { columns: string[]; rows: unknown[][] } | undefined {
  const hits = (body as { hits?: { hits?: Hit[] } }).hits?.hits
  if (!Array.isArray(hits)) return undefined
  const multiIndex = new Set(hits.map((h) => h._index)).size > 1
  const docs = hits.map((h) => ({
    ...(multiIndex ? { _index: h._index } : {}),
    _id: h._id,
    ...(h._score != null ? { _score: h._score } : {}),
    ...h._source,
    ...h.fields
  }))
  return objectsToTable(docs, known)
}

function formatResponse(body: unknown, status: number): ResultBody {
  if (body === undefined || body === '' || typeof body === 'boolean') {
    return { message: `HTTP ${status}` }
  }
  const table = hitsTable(body)
  if (table) {
    const total = (body as { hits: { total?: { value: number } | number } }).hits.total
    const count = typeof total === 'number' ? total : total?.value
    const took = (body as { took?: number }).took
    return {
      ...table,
      json: body,
      message: `Total hits: ${count ?? '?'}${took != null ? `, took ${took}ms` : ''}`
    }
  }
  if (Array.isArray(body) && body.every((r) => r && typeof r === 'object')) {
    return paginate({ ...objectsToTable(body as Record<string, unknown>[]), json: body, message: plural(body.length, 'row') }, body)
  }
  return { json: body }
}
