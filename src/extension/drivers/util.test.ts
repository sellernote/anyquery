import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { objectsToTable, paginate, splitPgSql, splitSql, stripPgComments, tokenize } from './util'
import { quoteArg } from './redis'

describe('splitSql (MySQL)', () => {
  test('splits on ; and drops empty statements', () => {
    assert.deepEqual(splitSql(';;SELECT 1; SELECT 2;;'), ['SELECT 1', 'SELECT 2'])
  })

  test('keeps ; inside quotes and backticks', () => {
    assert.deepEqual(splitSql("SELECT ';', \"a;b\", `c;d`; SELECT 2"), ["SELECT ';', \"a;b\", `c;d`", 'SELECT 2'])
  })

  test('handles backslash escapes and doubled quotes', () => {
    assert.deepEqual(splitSql("SELECT 'it\\'s; ok'; SELECT 'it''s; ok'; SELECT 3"), [
      "SELECT 'it\\'s; ok'",
      "SELECT 'it''s; ok'",
      'SELECT 3'
    ])
  })

  test('keeps ; inside comments', () => {
    assert.deepEqual(splitSql('-- a; b\nSELECT 1; # c; d\nSELECT 2 /* e; f */;'), [
      '-- a; b\nSELECT 1',
      '# c; d\nSELECT 2 /* e; f */'
    ])
  })

  test('-- needs a space after it to start a comment', () => {
    assert.deepEqual(splitSql('SELECT 1--1; SELECT 2'), ['SELECT 1--1', 'SELECT 2'])
  })

  test('drops statements that are only comments', () => {
    assert.deepEqual(splitSql('SELECT 1; -- done\n/* end */'), ['SELECT 1'])
  })
})

describe('splitPgSql', () => {
  test('keeps ; inside $$ function bodies', () => {
    const fn = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql'
    assert.deepEqual(splitPgSql(`${fn}; SELECT f();`), [fn, 'SELECT f()'])
  })

  test('keeps ; inside tagged dollar quotes', () => {
    const body = 'DO $body$ BEGIN PERFORM 1; END $body$'
    assert.deepEqual(splitPgSql(`${body}; SELECT 2`), [body, 'SELECT 2'])
  })

  test('$1 is a parameter and a$b$ is a name, not dollar quotes', () => {
    assert.deepEqual(splitPgSql('PREPARE p AS SELECT $1; SELECT a$b$ FROM t; SELECT 3'), [
      'PREPARE p AS SELECT $1',
      'SELECT a$b$ FROM t',
      'SELECT 3'
    ])
  })

  test('# is an operator, not a comment', () => {
    assert.deepEqual(splitPgSql('SELECT 1 # 2; SELECT 3'), ['SELECT 1 # 2', 'SELECT 3'])
  })

  test('block comments can be nested', () => {
    assert.deepEqual(splitPgSql('/* a /* b; */ c; */ SELECT 1; SELECT 2'), ['/* a /* b; */ c; */ SELECT 1', 'SELECT 2'])
  })

  test('backslash escapes only work in E strings', () => {
    assert.deepEqual(splitPgSql("SELECT 'a\\'; SELECT E'b\\'; c'; SELECT 3"), [
      "SELECT 'a\\'",
      "SELECT E'b\\'; c'",
      'SELECT 3'
    ])
  })

  test('keeps ; inside quoted names and drops comment-only statements', () => {
    assert.deepEqual(splitPgSql('SELECT "a;b" FROM t; -- end'), ['SELECT "a;b" FROM t'])
  })
})

describe('stripPgComments', () => {
  test('replaces comments with a space and keeps strings', () => {
    assert.equal(stripPgComments("SELECT '-- no' -- yes\nFROM /* x /* y */ */ t"), "SELECT '-- no'  \nFROM   t")
  })
})

describe('tokenize (Redis)', () => {
  test('splits on spaces and reads quotes', () => {
    assert.deepEqual(tokenize(`SET key "hello world"  'a "b" c'`), ['SET', 'key', 'hello world', 'a "b" c'])
  })

  test('reads escapes in double quotes only', () => {
    assert.deepEqual(tokenize(`"a\\nb\\"c" 'd\\ne'`), ['a\nb"c', 'd\\ne'])
  })

  test('throws on an unclosed quote', () => {
    assert.throws(() => tokenize('GET "key'), /Unclosed quote/)
  })

  test('reads back what quoteArg writes', () => {
    const args = ['plain', '', 'a b', 'x"y', "it's", 'back\\slash', 'line\nbreak']
    assert.deepEqual(tokenize(args.map(quoteArg).join(' ')), args)
  })
})

describe('objectsToTable', () => {
  test('merges columns in the order they appear, after known ones', () => {
    assert.deepEqual(objectsToTable([{ a: 1 }, { b: 2, a: 3 }], ['z']), {
      columns: ['z', 'a', 'b'],
      rows: [
        [undefined, 1, undefined],
        [undefined, 3, 2]
      ]
    })
  })
})

describe('paginate', () => {
  test('keeps the first page and hands the rest to a cursor', async () => {
    const items = Array.from({ length: 450 }, (_, i) => i)
    const result = paginate({ columns: ['n'], rows: items.map((n) => [n]) }, items)
    assert.equal(result.rows?.length, 200)
    assert.deepEqual((result.json as number[]).slice(0, 2), [0, 1])
    const second = await result.cursor!.next()
    assert.deepEqual([second.rows.length, second.rows[0], second.hasMore], [200, [200], true])
    const third = await result.cursor!.next()
    assert.deepEqual([third.rows.length, third.hasMore, (third.json as number[])[0]], [50, false, 400])
  })

  test('leaves a single page alone', () => {
    const result = paginate({ columns: ['n'], rows: [[1]] })
    assert.equal(result.cursor, undefined)
  })
})
