import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode } from './rpc'
import { parseEdit } from './edit'
import { plural } from './format'

describe('rpc encode/decode', () => {
  test('keeps undefined apart from null, in arrays and objects', () => {
    const value = { rows: [[1, undefined, null]], json: { a: undefined, b: null } }
    const back = decode(encode(value)) as typeof value
    assert.deepEqual(back, value)
    assert.ok('a' in back.json)
  })
})

describe('parseEdit', () => {
  test('text stays text when the old value was text', () => {
    assert.equal(parseEdit('42', 'old'), '42')
  })

  test('reads JSON when the old value was not text', () => {
    assert.equal(parseEdit('43', 42), 43)
    assert.deepEqual(parseEdit('{"a": [1]}', { a: [] }), { a: [1] })
  })

  test('with no old value, text that is not JSON stays text', () => {
    assert.equal(parseEdit('abc', null), 'abc')
    assert.equal(parseEdit('5', undefined), 5)
  })

  test('throws when the text must be JSON but is not', () => {
    assert.throws(() => parseEdit('abc', 1), /Not valid JSON: abc/)
  })
})

describe('plural', () => {
  test('adds s and thousands separators', () => {
    assert.deepEqual([plural(1, 'row'), plural(0, 'row'), plural(1200, 'row')], ['1 row', '0 rows', '1,200 rows'])
  })
})
