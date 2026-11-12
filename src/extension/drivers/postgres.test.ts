import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readsTableOnce } from './postgres'

describe('readsTableOnce', () => {
  test('a table read once can be edited', () => {
    assert.equal(readsTableOnce('SELECT * FROM users', 'users'), true)
    assert.equal(readsTableOnce('SELECT * FROM public.users -- users\n/* users */', 'users'), true)
    assert.equal(readsTableOnce('SELECT users_id, created_at::timestamp with time zone FROM users', 'users'), true)
  })

  test('a self join cannot', () => {
    assert.equal(readsTableOnce('SELECT a.* FROM users a JOIN users b ON a.boss = b.id', 'users'), false)
  })

  test('a WITH query cannot', () => {
    assert.equal(readsTableOnce('WITH x AS (SELECT 1) SELECT * FROM users', 'users'), false)
  })
})
