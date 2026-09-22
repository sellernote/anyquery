import { PAGE_SIZE } from '@shared/types'
import type { Cursor, DriverResult, ResultBody } from './types'

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * Turns an array of objects into a table. Columns are merged in the order they appear.
 * If columns from a previous page are passed, new columns are appended after them.
 */
export function objectsToTable(
  docs: Record<string, unknown>[],
  known: string[] = []
): { columns: string[]; rows: unknown[][] } {
  const columns = [...known]
  const seen = new Set(columns)
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  const rows = docs.map((doc) => columns.map((c) => (c in doc ? doc[c] : undefined)))
  return { columns, rows }
}

/**
 * Splits a result already in memory into pages. Keeps the first page in the result and hands the rest to a cursor.
 * items are the source values, one per row. When paginated, the JSON view shows only the current page's part.
 */
export function paginate(result: ResultBody, items?: unknown[]): ResultBody {
  const rows = result.rows
  if (!rows || rows.length <= PAGE_SIZE) return result
  let offset = PAGE_SIZE
  const cursor: Cursor = {
    async next() {
      const start = offset
      offset += PAGE_SIZE
      return {
        rows: rows.slice(start, offset),
        json: items?.slice(start, offset),
        hasMore: offset < rows.length
      }
    },
    async close() {}
  }
  return { ...result, rows: rows.slice(0, PAGE_SIZE), json: items?.slice(0, PAGE_SIZE), cursor }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Shows binary values as hex */
export function toPlain(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, 64).toString('hex')
    return value.length > 64 ? `0x${hex}... (${value.length} bytes)` : `0x${hex}`
  }
  return value
}

export async function timed(statement: string, run: () => Promise<ResultBody>): Promise<DriverResult> {
  const start = performance.now()
  try {
    const result = await run()
    return { statement, ...result, elapsedMs: Math.round(performance.now() - start) }
  } catch (err) {
    return { statement, error: errorMessage(err), elapsedMs: Math.round(performance.now() - start) }
  }
}

/** Runs statements in order. By default, stops at the first failure. */
export async function runAll<T>(
  items: T[],
  run: (item: T) => Promise<DriverResult>,
  { stopOnError = true } = {}
): Promise<DriverResult[]> {
  const results: DriverResult[] = []
  for (const item of items) {
    const result = await run(item)
    results.push(result)
    if (result.error && stopOnError) break
  }
  return results
}

/**
 * Splits SQL on `;`. Ignores `;` inside quotes, backticks and comments.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  let quote: string | null = null
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (quote) {
      buf += ch
      if (ch === '\\' && quote !== '`') {
        buf += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) {
        if (next === quote) {
          buf += next
          i += 2
          continue
        }
        quote = null
      }
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      buf += ch
      i++
      continue
    }
    if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === ';') {
      out.push(buf)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  out.push(buf)
  return out.map((s) => s.trim()).filter((s) => s && !isOnlyComments(s))
}

function isOnlyComments(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(--\s|#).*$/gm, '')
    .trim()
  return stripped === ''
}

/**
 * Splits PostgreSQL on `;`. Unlike MySQL, `#` is an operator, block comments can be nested,
 * backslash escapes only work in E'...' strings, and $$...$$ (dollar quotes) can hold `;`.
 */
export function splitPgSql(sql: string): string[] {
  const out: string[] = []
  let start = 0
  // Whether the current statement has anything besides comments and spaces
  let hasCode = false
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (sql.startsWith('*/', i)) {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    if (ch === ';') {
      if (hasCode) out.push(sql.slice(start, i).trim())
      start = i + 1
      hasCode = false
      i++
      continue
    }
    if (!/\s/.test(ch)) hasCode = true
    const prev = sql[i - 1] ?? ''
    if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && (prev === 'e' || prev === 'E') && !/[\w$]/.test(sql[i - 2] ?? '')
      i = skipQuoted(sql, i, escapes)
      continue
    }
    // $tag$ or $$. $1 is a parameter, and a$b$ is a name.
    const tag = ch === '$' && !/[\w$]/.test(prev) ? /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64)) : null
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length)
      i = end === -1 ? sql.length : end + tag[0].length
      continue
    }
    i++
  }
  if (hasCode) out.push(sql.slice(start).trim())
  return out
}

/** Returns the index after the closing quote. A doubled quote ('') is part of the string. */
function skipQuoted(sql: string, open: number, escapes: boolean): number {
  const quote = sql[open]
  let i = open + 1
  while (i < sql.length) {
    if (escapes && sql[i] === '\\') {
      i += 2
    } else if (sql[i] === quote) {
      if (sql[i + 1] !== quote) return i + 1
      i += 2
    } else {
      i++
    }
  }
  return sql.length
}

/**
 * Splits a line into arguments like redis-cli. Supports double and single quotes.
 */
export function tokenize(line: string): string[] {
  const args: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break
    let arg = ''
    const q = line[i]
    if (q === '"' || q === "'") {
      i++
      while (i < line.length && line[i] !== q) {
        if (line[i] === '\\' && q === '"' && i + 1 < line.length) {
          const n = line[i + 1]
          arg += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
          i += 2
          continue
        }
        arg += line[i++]
      }
      if (i >= line.length) throw new Error('Unclosed quote')
      i++
    } else {
      while (i < line.length && !/\s/.test(line[i])) arg += line[i++]
    }
    args.push(arg)
  }
  return args
}
