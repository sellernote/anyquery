import Redis from 'ioredis'
import type { ConnectionConfig, ExecuteContext, OpenQuery, TreeNode } from '@shared/types'
import { plural } from '@shared/format'
import type { Driver, DriverResult, ResultBody } from './types'
import { paginate, runAll, timed, tokenize } from './util'

/** Max number of keys shown in the tree */
const MAX_KEYS = 500

/** Commands that hold the connection are blocked */
const BLOCKED = new Set(['MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'SYNC', 'PSYNC'])

export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"'\\]/.test(arg)) return arg
  return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}

export class RedisDriver implements Driver {
  /** SELECT would affect other tabs, so keep a separate client per DB number */
  private clients = new Map<number, Redis>()
  private dbCount = 16

  constructor(private config: ConnectionConfig) {}

  private async client(db: number): Promise<Redis> {
    const existing = this.clients.get(db)
    if (existing) return existing
    const c = this.config
    const client = new Redis({
      host: c.host,
      port: c.port,
      username: c.user || undefined,
      password: c.password || undefined,
      db,
      tls: c.tls ? { rejectUnauthorized: !c.allowInvalidCert } : undefined,
      lazyConnect: true,
      connectTimeout: 10_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 3 ? null : 500)
    })
    // Connection errors surface as failed commands. Without a listener, ioredis logs a warning to the console.
    client.on('error', () => {})
    this.clients.set(db, client)
    try {
      await client.connect()
    } catch (err) {
      this.clients.delete(db)
      client.disconnect()
      throw err
    }
    return client
  }

  async connect(): Promise<void> {
    const client = await this.client(0)
    try {
      const reply = (await client.call('CONFIG', ['GET', 'databases'])) as string[]
      const n = Number(reply?.[1])
      if (n > 0) this.dbCount = n
    } catch {
      // Managed Redis services often block CONFIG. Use the default of 16.
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.disconnect()
    this.clients.clear()
  }

  async ping(): Promise<string> {
    const info = (await (await this.client(0)).call('INFO', ['server'])) as string
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? '?'
    return `Redis ${version}`
  }

  async databases(): Promise<string[]> {
    return Array.from({ length: this.dbCount }, (_, i) => `db${i}`)
  }

  async children(path: string[]): Promise<TreeNode[]> {
    if (path.length === 0) {
      const info = (await (await this.client(0)).call('INFO', ['keyspace'])) as string
      const counts = new Map<string, string>()
      for (const m of info.matchAll(/^(db\d+):keys=(\d+)/gm)) counts.set(m[1], m[2])
      // Showing all 16 databases, even empty ones, is noisy. Show db0 and databases that have keys.
      return (await this.databases())
        .filter((name) => name === 'db0' || counts.has(name))
        .map((name) => ({
          label: name,
          kind: 'database',
          path: [name],
          expandable: true,
          openable: false,
          detail: `${counts.get(name) ?? 0} keys`
        }))
    }
    const client = await this.client(dbIndex(path[0]))
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = (await client.scan(cursor, 'COUNT', 1000)) as [string, string[]]
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0' && keys.length < MAX_KEYS)
    const shown = keys.slice(0, MAX_KEYS).sort()
    const pipeline = client.pipeline()
    for (const key of shown) pipeline.type(key)
    const types = ((await pipeline.exec()) ?? []).map(([, t]) => String(t ?? ''))
    const nodes: TreeNode[] = shown.map((key, i) => ({
      label: key,
      kind: 'key',
      path: [path[0], key],
      expandable: false,
      openable: true,
      detail: types[i]
    }))
    if (cursor !== '0' || keys.length > MAX_KEYS) {
      nodes.push({
        label: `Showing only ${MAX_KEYS} keys. Use SCAN to find others.`,
        kind: 'more',
        path: [...path, '__more'],
        expandable: false,
        openable: false
      })
    }
    return nodes
  }

  async openQuery(path: string[]): Promise<OpenQuery> {
    const [database, key] = path
    const client = await this.client(dbIndex(database))
    const type = await client.type(key)
    const k = quoteArg(key)
    const commands: Record<string, string> = {
      string: `GET ${k}`,
      hash: `HGETALL ${k}`,
      list: `LRANGE ${k} 0 99`,
      set: `SSCAN ${k} 0 COUNT 100`,
      zset: `ZRANGE ${k} 0 99 WITHSCORES`,
      stream: `XRANGE ${k} - + COUNT 100`,
      'ReJSON-RL': `JSON.GET ${k}`
    }
    return { query: commands[type] ?? `TYPE ${k}`, database }
  }

  async closeSession(): Promise<void> {}

  async execute(query: string, ctx: ExecuteContext): Promise<DriverResult[]> {
    let db = dbIndex(ctx.database ?? 'db0')
    const lines = query
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
    return runAll(lines, (line) =>
      timed(line, async () => {
        const [cmd, ...args] = tokenize(line)
        const name = cmd.toUpperCase()
        if (BLOCKED.has(name)) throw new Error(`${name} is not supported`)
        if (name === 'SELECT') {
          // Applies only to the following lines in this run
          const n = Number(args[0])
          if (!Number.isInteger(n) || n < 0 || n >= this.dbCount) throw new Error('Invalid DB number')
          db = n
          return { message: `Selected db${n}` }
        }
        const client = await this.client(db)
        const reply = await client.call(cmd, args)
        return formatReply(name, args, reply)
      })
    )
  }
}

function dbIndex(name: string): number {
  const n = Number(name.replace(/^db/, ''))
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** Turns both [k, v, k, v] and [[k, v], [k, v]] (RESP3) into [[k, v]] */
function pairs(items: unknown[]): unknown[][] {
  if (items.length > 0 && items.every((i) => Array.isArray(i) && i.length === 2)) return items as unknown[][]
  const rows: unknown[][] = []
  for (let i = 0; i < items.length; i += 2) rows.push([items[i], items[i + 1]])
  return rows
}

function formatReply(cmd: string, args: string[], reply: unknown): ResultBody {
  if (reply === null || reply === undefined) return { columns: ['value'], rows: [[null]], message: '(nil)' }
  if (cmd === 'INFO' && typeof reply === 'string') return formatInfo(reply)
  if (reply instanceof Map) reply = [...reply.entries()]
  if (!Array.isArray(reply)) {
    if (cmd === 'JSON.GET' && typeof reply === 'string') {
      try {
        const json = JSON.parse(reply)
        return { columns: ['value'], rows: [[json]], json }
      } catch {
        // Not JSON: show the string as is
      }
    }
    return { columns: ['value'], rows: [[reply]], json: reply }
  }
  const upperArgs = args.map((a) => a.toUpperCase())
  let columns = ['#', 'value']
  let rows: unknown[][]
  /** Source values, one per row. When paginated, the JSON view shows only the current page's part. */
  let items: unknown[] = reply
  let message = plural(reply.length, 'item')
  if (cmd === 'HGETALL' || cmd === 'CONFIG' || (cmd.startsWith('Z') && upperArgs.includes('WITHSCORES'))) {
    columns = cmd === 'HGETALL' ? ['field', 'value'] : cmd === 'CONFIG' ? ['name', 'value'] : ['member', 'score']
    rows = items = pairs(reply)
    message = plural(rows.length, 'item')
  } else if (
    (cmd === 'SCAN' || cmd === 'SSCAN' || cmd === 'HSCAN' || cmd === 'ZSCAN') &&
    reply.length === 2 &&
    Array.isArray(reply[1])
  ) {
    const [cursor, found] = reply as [string, unknown[]]
    if (cmd === 'HSCAN' || cmd === 'ZSCAN') {
      columns = cmd === 'HSCAN' ? ['field', 'value'] : ['member', 'score']
      rows = items = pairs(found)
    } else {
      rows = found.map((v, i) => [i + 1, v])
      items = found
    }
    message = `${plural(rows.length, 'item')}, next cursor: ${cursor}`
  } else if ((cmd === 'XRANGE' || cmd === 'XREVRANGE') && reply.every(Array.isArray)) {
    columns = ['id', 'fields']
    rows = (reply as [string, unknown[]][]).map(([id, fields]) => [
      id,
      Object.fromEntries(pairs(fields) as [string, unknown][])
    ])
  } else {
    rows = reply.map((v, i) => [i + 1, v])
  }
  return paginate({ columns, rows, json: reply, message }, items)
}

function formatInfo(text: string): ResultBody {
  const rows: unknown[][] = []
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) section = line.slice(2)
    else if (line.includes(':')) {
      const i = line.indexOf(':')
      rows.push([section, line.slice(0, i), line.slice(i + 1)])
    }
  }
  return { columns: ['section', 'name', 'value'], rows, json: text }
}
