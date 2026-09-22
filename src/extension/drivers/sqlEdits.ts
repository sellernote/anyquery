import type { EditRequest, EditTarget, RowEdit } from '@shared/types'
import { plural } from '@shared/format'
import type { EditOutcome } from './types'
import { errorMessage } from './util'

const SAVEPOINT = 'anyquery_edit'

/**
 * Makes an edit target for a result read from one table. sources holds the table column each result
 * column reads, or null for other columns such as expressions.
 * Returns undefined unless every primary key column is in the result. A column read twice cannot be edited.
 */
export function sqlEditTarget(
  name: string,
  path: string[],
  sources: (string | null)[],
  primaryKey: string[],
  editable: (column: number) => boolean
): EditTarget | undefined {
  if (primaryKey.length === 0) return
  const keys = primaryKey.map((key) => ({ column: sources.indexOf(key), name: key }))
  if (keys.some((k) => k.column < 0 || !editable(k.column))) return
  const columns = sources.map((source, i) =>
    source && !primaryKey.includes(source) && sources.indexOf(source) === sources.lastIndexOf(source) && editable(i)
      ? source
      : null
  )
  if (!columns.some(Boolean)) return
  return { name, path, keys, columns }
}

export interface SqlDialect {
  /** Quoted table name, with its database or schema */
  table: string
  quote(name: string): string
  /** Placeholder for the nth value, starting at 1 */
  param(n: number): string
  /** Turns the typed text into the value sent. Text is sent as is if not set. */
  value?(column: string, text: string): unknown
}

export interface SqlSession {
  /** The user's transaction is open. Edits then join it, and the user commits them. */
  inTransaction: boolean
  /** Runs a statement and returns the number of rows it matched */
  run(sql: string, values?: unknown[]): Promise<number>
}

/**
 * Saves each row with an UPDATE by its primary key. Every row is saved, or none.
 * Outside a transaction the edits are committed. Inside one, a savepoint undoes them on failure.
 */
export async function saveSqlEdits(db: SqlSession, dialect: SqlDialect, { target, rows }: EditRequest): Promise<EditOutcome> {
  const updates = rows.map((row) => toUpdate(dialect, target, row))
  await db.run(db.inTransaction ? `SAVEPOINT ${SAVEPOINT}` : 'BEGIN')
  try {
    for (const [i, { sql, values }] of updates.entries()) {
      const count = await db.run(sql, values)
      if (count === 0) throw new Error(`No row has ${describeKey(target, rows[i])}. It may have been deleted, or its key changed.`)
      if (count > 1) throw new Error(`${plural(count, 'row')} have ${describeKey(target, rows[i])}.`)
    }
  } catch (err) {
    try {
      if (db.inTransaction) {
        await db.run(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`)
        await db.run(`RELEASE SAVEPOINT ${SAVEPOINT}`)
      } else {
        await db.run('ROLLBACK')
      }
    } catch {
      throw err
    }
    throw new Error(`${errorMessage(err)}\nNothing was saved.`)
  }
  await db.run(db.inTransaction ? `RELEASE SAVEPOINT ${SAVEPOINT}` : 'COMMIT')
  const count = plural(rows.length, 'row')
  return {
    saved: rows.map((_, i) => i),
    message: db.inTransaction ? `Updated ${count}. Not committed: this tab has an open transaction.` : `Saved ${count}`
  }
}

function toUpdate(dialect: SqlDialect, target: EditTarget, row: RowEdit): { sql: string; values: unknown[] } {
  const values: unknown[] = []
  const set = row.changes.map(({ column, value }) => {
    const name = target.columns[column]
    if (!name) throw new Error('This column cannot be edited.')
    values.push(value === null || !dialect.value ? value : dialect.value(name, value))
    return `${dialect.quote(name)} = ${dialect.param(values.length)}`
  })
  const where = target.keys.map((key, i) => {
    values.push(row.key[i])
    return `${dialect.quote(key.name)} = ${dialect.param(values.length)}`
  })
  return { sql: `UPDATE ${dialect.table} SET ${set.join(', ')} WHERE ${where.join(' AND ')}`, values }
}

function describeKey(target: EditTarget, row: RowEdit): string {
  return target.keys
    .map((key, i) => `${key.name} = ${typeof row.key[i] === 'string' ? `'${row.key[i]}'` : String(row.key[i])}`)
    .join(', ')
}
