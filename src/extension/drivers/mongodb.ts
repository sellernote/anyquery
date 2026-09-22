import vm from 'node:vm'
import {
  Binary,
  Decimal128,
  Int32,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
  UUID,
  type Collection,
  type Db,
  type MongoClientOptions
} from 'mongodb'
import { PAGE_SIZE, type ConnectionConfig, type ExecuteContext, type OpenQuery, type TreeNode } from '@shared/types'
import { plural } from '@shared/format'
import type { Driver, DriverResult, ResultBody } from './types'
import { objectsToTable, paginate, timed } from './util'

/** Time limit for running the query code itself. Does not include time spent waiting for the database. */
const SCRIPT_TIMEOUT_MS = 5_000

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

export class MongoDriver implements Driver {
  private client: MongoClient | null = null

  constructor(private config: ConnectionConfig) {}

  private get mongo(): MongoClient {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  private defaultDb(): string {
    return this.config.database || 'test'
  }

  async connect(): Promise<void> {
    const c = this.config
    const options: MongoClientOptions = { serverSelectionTimeoutMS: 10_000, appName: 'AnyQuery' }
    let uri = c.uri?.trim()
    if (!uri) {
      uri = `mongodb://${c.host}:${c.port}/`
      if (c.user) {
        options.auth = { username: c.user, password: c.password }
        options.authSource = 'admin'
      }
      if (c.tls) {
        options.tls = true
        options.tlsAllowInvalidCertificates = !!c.allowInvalidCert
      }
    }
    this.client = new MongoClient(uri, options)
    await this.client.connect()
  }

  async close(): Promise<void> {
    await this.client?.close()
    this.client = null
  }

  async ping(): Promise<string> {
    const info = await this.mongo.db('admin').command({ buildInfo: 1 })
    return `MongoDB ${info.version}`
  }

  async databases(): Promise<string[]> {
    try {
      const { databases } = await this.mongo.db('admin').admin().listDatabases({ nameOnly: true })
      return databases.map((d) => d.name)
    } catch {
      // Without the listDatabases privilege, show only the database from the settings
      return [this.defaultDb()]
    }
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
    const list = await this.mongo.db(path[0]).listCollections({}, { nameOnly: true }).toArray()
    return list
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        label: c.name,
        kind: c.type === 'view' ? 'view' : 'collection',
        path: [path[0], c.name],
        expandable: false,
        openable: true,
        detail: c.type === 'view' ? 'view' : undefined
      }))
  }

  async openQuery(path: string[]): Promise<OpenQuery> {
    const [database, name] = path
    const target = IDENTIFIER.test(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(name)})`
    return { query: `${target}.find({}).limit(1000)`, database }
  }

  async closeSession(): Promise<void> {}

  async execute(query: string, ctx: ExecuteContext): Promise<DriverResult[]> {
    const database = ctx.database || this.defaultDb()
    const code = query.trim()
    return [
      await timed(code, async () => {
        const shortcut = await this.shellCommand(code, database)
        if (shortcut !== undefined) return format(shortcut)
        const context = vm.createContext(this.sandbox(this.mongo.db(database)))
        let value = vm.runInContext(code, context, { timeout: SCRIPT_TIMEOUT_MS })
        if (value && typeof (value as Promise<unknown>).then === 'function') value = await value
        return isCursor(value) ? firstPage(value) : format(value)
      })
    ]
  }

  /** Handles shell commands such as `show dbs` and `show collections` */
  private async shellCommand(code: string, database: string): Promise<unknown> {
    const m = /^show\s+(\w+)\s*;?$/i.exec(code)
    if (!m) return undefined
    const what = m[1].toLowerCase()
    if (what === 'dbs' || what === 'databases') {
      const { databases } = await this.mongo.db('admin').admin().listDatabases()
      return databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty }))
    }
    if (what === 'collections' || what === 'tables') {
      const list = await this.mongo.db(database).listCollections({}, { nameOnly: true }).toArray()
      return list.map((c) => ({ name: c.name, type: c.type }))
    }
    throw new Error(`Unsupported command: show ${m[1]}`)
  }

  private sandbox(db: Db): Record<string, unknown> {
    const client = this.mongo
    function OID(id?: string) {
      return new ObjectId(id)
    }
    return {
      db: shellDb(client, db),
      ObjectId: OID,
      ISODate: (s?: string) => (s ? new Date(s) : new Date()),
      Date,
      RegExp,
      NumberLong: (v: number | string) => Long.fromString(String(v)),
      NumberInt: (v: number | string) => new Int32(Number(v)),
      NumberDecimal: (v: string) => Decimal128.fromString(String(v)),
      UUID: (v?: string) => new UUID(v),
      Timestamp: (t: number, i: number) => new Timestamp({ t, i }),
      print: (v: unknown) => v,
      printjson: (v: unknown) => v
    }
  }
}

/** Hidden properties, so a result is not mistaken for a thenable or a cursor */
const RESERVED = new Set(['then', 'toArray', 'toJSON', 'constructor', 'inspect'])

function shellDb(client: MongoClient, db: Db): unknown {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== 'string' || RESERVED.has(prop)) return undefined
        switch (prop) {
          case 'getCollection':
            return (name: string) => shellCollection(db, db.collection(name))
          case 'getName':
            return () => db.databaseName
          case 'getCollectionNames':
            return async () =>
              (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
          case 'getSiblingDB':
            return (name: string) => shellDb(client, client.db(name))
          case 'runCommand':
            return (cmd: Record<string, unknown>) => db.command(cmd)
          case 'adminCommand':
            return (cmd: Record<string, unknown>) => client.db('admin').command(cmd)
          case 'createCollection':
            return async (name: string, options?: Record<string, unknown>) => {
              await db.createCollection(name, options)
              return { ok: 1 }
            }
          case 'dropDatabase':
            return () => db.dropDatabase()
          case 'stats':
            return () => db.command({ dbStats: 1 })
          default:
            return shellCollection(db, db.collection(prop))
        }
      }
    }
  )
}

/** Wraps the driver's Collection so it behaves like mongosh */
function shellCollection(db: Db, coll: Collection): unknown {
  return new Proxy(coll, {
    get(target, prop) {
      if (typeof prop === 'string' && RESERVED.has(prop)) return undefined
      switch (prop) {
        case 'find':
          return (filter = {}, projection?: object, options: object = {}) =>
            shellCursor(target.find(filter, { ...options, ...(projection ? { projection } : {}) }), () =>
              target.countDocuments(filter)
            )
        case 'findOne':
          return (filter = {}, projection?: object, options: object = {}) =>
            target.findOne(filter, { ...options, ...(projection ? { projection } : {}) })
        case 'aggregate':
          return (pipeline: object[] = [], options?: object) => shellCursor(target.aggregate(pipeline, options))
        case 'count':
          return (filter = {}, options?: object) => target.countDocuments(filter, options)
        case 'insert':
          return (docs: object | object[]) =>
            Array.isArray(docs) ? target.insertMany(docs) : target.insertOne(docs)
        case 'remove':
          return (filter: object) => target.deleteMany(filter)
        case 'getIndexes':
          return () => target.indexes()
        case 'stats':
          return () => db.command({ collStats: target.collectionName })
      }
      if (typeof prop === 'string' && !(prop in target)) {
        // Collection names with dots, such as db.logs.events
        return shellCollection(db, db.collection(`${target.collectionName}.${prop}`))
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

interface CursorLike {
  toArray(): Promise<unknown[]>
  hasNext(): Promise<boolean>
  next(): Promise<unknown>
  [Symbol.asyncIterator](): AsyncIterator<unknown>
  close(): Promise<void>
}

function shellCursor<T extends object>(cursor: T, count?: () => Promise<number>): T {
  const proxy: T = new Proxy(cursor, {
    get(target, prop) {
      if (prop === 'pretty') return () => proxy
      if (prop === 'count' && count) return count
      if (prop === 'itcount') return async () => (await (target as unknown as CursorLike).toArray()).length
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const out = value.apply(target, args)
        // limit(), sort() and others return the cursor itself. Return the proxy so chaining keeps working.
        return out === target ? proxy : out
      }
    }
  })
  return proxy
}

function isCursor(value: unknown): value is CursorLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CursorLike).toArray === 'function' &&
    typeof (value as CursorLike).hasNext === 'function' &&
    typeof (value as CursorLike)[Symbol.asyncIterator] === 'function'
  )
}

/** Reads one page from a cursor */
async function readPage(cursor: CursorLike): Promise<{ docs: unknown[]; hasMore: boolean }> {
  const docs: unknown[] = []
  while (docs.length < PAGE_SIZE && (await cursor.hasNext())) docs.push(toPlain(await cursor.next()))
  return { docs, hasMore: docs.length === PAGE_SIZE && (await cursor.hasNext()) }
}

/** Reads the first page and keeps the cursor open if there is more */
async function firstPage(cursor: CursorLike): Promise<ResultBody> {
  try {
    const { docs, hasMore } = await readPage(cursor)
    const first = tabulate(docs)
    if (!hasMore) {
      await cursor.close()
      return { ...first, json: docs, message: plural(docs.length, 'document') }
    }
    let columns = first.columns
    return {
      ...first,
      json: docs,
      cursor: {
        async next() {
          const page = await readPage(cursor).catch((err) => {
            if ((err as { code?: number }).code === 43) {
              throw new Error('The server closed the cursor. Idle cursors close after 10 minutes. Run the query again.')
            }
            throw err
          })
          const table = tabulate(page.docs, columns)
          columns = table.columns
          return { ...table, json: page.docs, hasMore: page.hasMore }
        },
        close: () => cursor.close()
      }
    }
  } catch (err) {
    await cursor.close().catch(() => {})
    throw err
  }
}

/** Makes a table with fields as columns for documents, or a single-column table otherwise */
function tabulate(items: unknown[], known?: string[]): { columns: string[]; rows: unknown[][] } {
  if (items.every((d) => d && typeof d === 'object' && !Array.isArray(d))) {
    return objectsToTable(items as Record<string, unknown>[], known)
  }
  return { columns: ['value'], rows: items.map((v) => [v]) }
}

function format(value: unknown): ResultBody {
  const plain = toPlain(value)
  if (Array.isArray(plain)) {
    return paginate({ ...tabulate(plain), json: plain, message: plural(plain.length, 'item') }, plain)
  }
  if (plain && typeof plain === 'object') {
    return { ...objectsToTable([plain as Record<string, unknown>]), json: plain }
  }
  if (plain === undefined) return { message: 'Done' }
  return { columns: ['result'], rows: [[plain]], json: plain }
}

/** Converts BSON values to readable values that can be sent over IPC */
export function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return value.toString()
  if (Array.isArray(value)) return value.map(toPlain)
  const bson = (value as { _bsontype?: string })._bsontype
  switch (bson) {
    case 'ObjectId':
      return `ObjectId('${(value as ObjectId).toHexString()}')`
    case 'Decimal128':
      return value.toString()
    case 'Double':
    case 'Int32':
      return Number((value as Int32).valueOf())
    case 'Long': {
      const n = (value as Long).toNumber()
      return Number.isSafeInteger(n) ? n : value.toString()
    }
    case 'Timestamp': {
      const ts = value as Timestamp
      return `Timestamp(${ts.t}, ${ts.i})`
    }
    case 'Binary': {
      const bin = value as Binary
      if (bin.sub_type === Binary.SUBTYPE_UUID) return `UUID('${bin.toUUID().toHexString()}')`
      return `Binary('${bin.toString('base64')}', ${bin.sub_type})`
    }
    case 'MinKey':
    case 'MaxKey':
    case 'Code':
    case 'BSONRegExp':
    case 'BSONSymbol':
    case 'DBRef':
      return String(value)
  }
  if (value instanceof Uint8Array) return `Binary('${Buffer.from(value).toString('base64')}')`
  if (value instanceof Map) return toPlain(Object.fromEntries(value))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = toPlain(v)
  return out
}
