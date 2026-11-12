import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { EditRequest } from '@shared/types'
import { saveSqlEdits, sqlEditTarget, type SqlDialect } from './sqlEdits'
import { quoteId } from './mysql'

const always = () => true

describe('sqlEditTarget', () => {
  test('maps the primary key and the other table columns', () => {
    assert.deepEqual(sqlEditTarget('db.t', ['db', 't'], ['id', 'name', null], ['id'], always), {
      name: 'db.t',
      path: ['db', 't'],
      keys: [{ column: 0, name: 'id' }],
      columns: [null, 'name', null]
    })
  })

  test('needs every primary key column in the result', () => {
    assert.equal(sqlEditTarget('t', [], ['a', 'name'], ['a', 'b'], always), undefined)
    assert.equal(sqlEditTarget('t', [], ['name'], [], always), undefined)
  })

  test('a key column that cannot be read back exactly makes the result read-only', () => {
    assert.equal(sqlEditTarget('t', [], ['id', 'name'], ['id'], (i) => i !== 0), undefined)
  })

  test('a column read twice cannot be edited', () => {
    assert.deepEqual(sqlEditTarget('t', [], ['id', 'name', 'name', 'age'], ['id'], always)?.columns, [null, null, null, 'age'])
  })

  test('returns undefined when nothing can be edited', () => {
    assert.equal(sqlEditTarget('t', [], ['id', null], ['id'], always), undefined)
  })
})

/** A session that records statements. counts gives the matched rows of each UPDATE in order. */
function fakeSession(inTransaction: boolean, counts: number[] = []) {
  const log: { sql: string; values?: unknown[] }[] = []
  return {
    log,
    session: {
      inTransaction,
      async run(sql: string, values?: unknown[]) {
        log.push(values ? { sql, values } : { sql })
        return sql.startsWith('UPDATE') ? (counts.shift() ?? 1) : 0
      }
    }
  }
}

const mysql: SqlDialect = { table: '`db`.`t`', quote: quoteId, param: () => '?' }

const request: EditRequest = {
  target: { name: 'db.t', path: ['db', 't'], keys: [{ column: 0, name: 'id' }], columns: [null, 'name', 'note'] },
  rows: [
    { key: [1], changes: [{ column: 1, value: 'Kim', old: 'Lee' }, { column: 2, value: null, old: 'x' }] },
    { key: ['a`b'], changes: [{ column: 1, value: 'Park', old: 'Choi' }] }
  ]
}

describe('saveSqlEdits', () => {
  test('saves every row in one transaction', async () => {
    const { log, session } = fakeSession(false)
    const outcome = await saveSqlEdits(session, mysql, request)
    assert.deepEqual(log, [
      { sql: 'BEGIN' },
      { sql: 'UPDATE `db`.`t` SET `name` = ?, `note` = ? WHERE `id` = ?', values: ['Kim', null, 1] },
      { sql: 'UPDATE `db`.`t` SET `name` = ? WHERE `id` = ?', values: ['Park', 'a`b'] },
      { sql: 'COMMIT' }
    ])
    assert.deepEqual(outcome, { saved: [0, 1], message: 'Saved 2 rows' })
  })

  test("joins the user's open transaction with a savepoint and does not commit", async () => {
    const { log, session } = fakeSession(true)
    const outcome = await saveSqlEdits(session, mysql, request)
    assert.deepEqual(
      log.map((l) => l.sql.split(' ')[0]),
      ['SAVEPOINT', 'UPDATE', 'UPDATE', 'RELEASE']
    )
    assert.match(outcome.message!, /Not committed/)
  })

  test('rolls back everything when a row is gone', async () => {
    const { log, session } = fakeSession(false, [1, 0])
    await assert.rejects(saveSqlEdits(session, mysql, request), /No row has id = 'a`b'[\s\S]*Nothing was saved/)
    assert.equal(log.at(-1)?.sql, 'ROLLBACK')
  })

  test('rolls back to the savepoint inside a transaction', async () => {
    const { log, session } = fakeSession(true, [2])
    await assert.rejects(saveSqlEdits(session, mysql, request), /2 rows have id = 1/)
    assert.deepEqual(
      log.slice(-2).map((l) => l.sql),
      ['ROLLBACK TO SAVEPOINT anyquery_edit', 'RELEASE SAVEPOINT anyquery_edit']
    )
  })

  test('converts typed text with the dialect, but not NULL', async () => {
    const { log, session } = fakeSession(false)
    const dialect: SqlDialect = { table: 't', quote: (n) => n, param: (n) => `$${n}`, value: (_c, text) => `<${text}>` }
    await saveSqlEdits(session, dialect, { ...request, rows: [request.rows[0]] })
    assert.deepEqual(log[1], { sql: 'UPDATE t SET name = $1, note = $2 WHERE id = $3', values: ['<Kim>', null, 1] })
  })
})
