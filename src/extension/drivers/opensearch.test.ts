import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRequests } from './opensearch'

/** Requests with their body trimmed, as they are sent */
const parse = (text: string) => parseRequests(text).map((r) => ({ ...r, body: r.body.trim() }))

describe('parseRequests', () => {
  test('reads a request line and its JSON body', () => {
    assert.deepEqual(parse('GET /books/_search\n{\n  "size": 1\n}\n\nget _cat/indices\n'), [
      { method: 'GET', path: '/books/_search', body: '{\n  "size": 1\n}' },
      { method: 'GET', path: '_cat/indices', body: '' }
    ])
  })

  test('skips comments before, between and after requests', () => {
    const text = [
      '# list indices',
      'GET _cat/indices',
      '',
      '# search',
      '// another comment',
      'POST /books/_search',
      '# about the body',
      '{"size": 1}',
      '',
      '# done'
    ].join('\n')
    assert.deepEqual(parse(text), [
      { method: 'GET', path: '_cat/indices', body: '' },
      { method: 'POST', path: '/books/_search', body: '{"size": 1}' }
    ])
  })

  test('keeps # inside JSON strings', () => {
    assert.deepEqual(parse('PUT /tags/_doc/1\n{\n  "tag": "#1"\n}'), [
      { method: 'PUT', path: '/tags/_doc/1', body: '{\n  "tag": "#1"\n}' }
    ])
  })

  test('throws on text before the first request line', () => {
    assert.throws(() => parseRequests('{"size": 1}\nGET /books/_search'), /must start with a method/)
  })
})
