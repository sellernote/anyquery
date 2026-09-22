import { useEffect, useMemo, useRef, useState } from 'react'
import { PAGE_SIZE, type DownloadFormat, type EditTarget } from '@shared/types'
import { plural } from '@shared/format'
import type { ResultState } from '../store'
import { api } from '../api'
import { cellKey, editedValue } from '../edits'
import { JsonViewer } from './Editor'

export function formatCell(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function toJsonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (typeof a !== 'object' && typeof b !== 'object' && a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) {
    return na - nb
  }
  return formatCell(a).localeCompare(formatCell(b))
}

function toTsv(columns: string[], rows: unknown[][]): string {
  const clean = (v: unknown) => formatCell(v).replace(/[\t\n\r]/g, ' ')
  return [columns.map(clean).join('\t'), ...rows.map((r) => r.map(clean).join('\t'))].join('\n')
}

export function ResultView({
  results,
  running,
  saving,
  onPage,
  onDownload,
  onOpenCell,
  onSave,
  onDiscard
}: {
  results: ResultState[]
  running: boolean
  saving: boolean
  onPage: (index: number, page: number) => void
  onDownload: (index: number, format: DownloadFormat) => Promise<boolean>
  onOpenCell: (index: number, page: number, row: number, column: number) => void
  onSave: (index: number) => void
  onDiscard: (index: number) => void
}) {
  // Show the failed result first if there is one, otherwise the last result
  const [index, setIndex] = useState(() => {
    const failed = results.findIndex((r) => r.error)
    return failed >= 0 ? failed : Math.max(0, results.length - 1)
  })

  if (results.length === 0) {
    return <div className="result-empty">{running ? 'Running...' : 'Run a query to see results here.'}</div>
  }

  const result = results[Math.min(index, results.length - 1)]
  const totalMs = results.reduce((sum, r) => sum + r.elapsedMs, 0)

  return (
    <div className="result-view">
      {results.length > 1 && (
        <div className="result-tabs">
          {results.map((r, i) => (
            <button
              key={i}
              className={`result-tab ${i === index ? 'active' : ''} ${r.error ? 'failed' : ''}`}
              onClick={() => setIndex(i)}
              title={r.statement}
            >
              {i + 1}. {r.statement.replace(/\s+/g, ' ').slice(0, 40)}
            </button>
          ))}
          <span className="result-total">
            {results.length} statements, {totalMs}ms
          </span>
        </div>
      )}
      <SingleResult
        key={index}
        result={result}
        running={running}
        saving={saving}
        onPage={(page) => onPage(index, page)}
        onDownload={(format) => onDownload(index, format)}
        onOpenCell={(page, row, column) => onOpenCell(index, page, row, column)}
        onSave={() => onSave(index)}
        onDiscard={() => onDiscard(index)}
      />
    </div>
  )
}

function SingleResult({
  result,
  running,
  saving,
  onPage,
  onDownload,
  onOpenCell,
  onSave,
  onDiscard
}: {
  result: ResultState
  running: boolean
  saving: boolean
  onPage: (page: number) => void
  onDownload: (format: DownloadFormat) => Promise<boolean>
  onOpenCell: (page: number, row: number, column: number) => void
  onSave: () => void
  onDiscard: () => void
}) {
  const { rows, json } = result.pages[result.page]
  const offset = result.pages.slice(0, result.page).reduce((n, p) => n + p.rows.length, 0)
  const hasTable = !!result.columns && !result.error
  const hasJson = json !== undefined
  const [mode, setMode] = useState<'table' | 'json'>(hasTable ? 'table' : 'json')
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const editCount = Object.keys(result.edits ?? {}).length

  async function download() {
    // Start with the format of the current view. The save dialog can switch it.
    if (!(await onDownload(mode === 'table' && hasTable ? 'csv' : 'json'))) return
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  async function copy() {
    const text = mode === 'table' && result.columns ? toTsv(result.columns, rows) : toJsonText(json)
    await api.copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <>
      <div className="result-info">
        {result.error ? <span className="error-text">Failed</span> : <span>{result.message ?? 'Done'}</span>}
        <span className="muted">{result.elapsedMs}ms</span>
        {result.truncated && (
          <span className="warn">Showing only the first {PAGE_SIZE} rows. Run this statement alone to see the rest.</span>
        )}
        {result.pageError && <span className="error-text">{result.pageError}</span>}
        {result.pageNote && <span className="warn">{result.pageNote}</span>}
        {running && <span className="muted">Running again...</span>}
        {result.edit && !result.error && mode === 'table' && (
          <span className="muted" title="Double-click a cell to edit it. Changes are saved when you click Save.">
            Editable: {result.edit.name}
          </span>
        )}
        {result.editNote && <span>{result.editNote}</span>}
        <span className="spacer" />
        {editCount > 0 && (
          <>
            <span className="warn">{plural(editCount, 'unsaved change')}</span>
            <button className="small" onClick={onDiscard} disabled={saving}>
              Discard
            </button>
            <button
              className="small primary"
              onClick={onSave}
              disabled={saving || running || result.loading || result.downloading}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        )}
        <Pager result={result} offset={offset} running={running || saving} onPage={onPage} />
        {hasTable && hasJson && (
          <div className="segmented">
            <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>
              Table
            </button>
            <button className={mode === 'json' ? 'active' : ''} onClick={() => setMode('json')}>
              JSON
            </button>
          </div>
        )}
        {(hasTable || hasJson) && (
          <button className="small" onClick={copy}>
            {copied ? 'Copied' : mode === 'table' && hasTable ? 'Copy (TSV)' : 'Copy (JSON)'}
          </button>
        )}
        {!result.error && (hasTable || hasJson) && (
          <button
            className="small"
            onClick={download}
            disabled={running || saving || result.loading || result.downloading}
            title="Save every row as CSV or JSON, including pages not read yet"
          >
            {result.downloading ? 'Downloading...' : saved ? 'Saved' : 'Download'}
          </button>
        )}
      </div>
      <div className="result-body">
        {result.error && <pre className="error-box">{result.error}</pre>}
        {result.error && hasJson && (
          <div className="error-json">
            <JsonViewer value={toJsonText(json)} />
          </div>
        )}
        {result.editError && <pre className="error-box">{result.editError}</pre>}
        {!result.error && mode === 'table' && hasTable && (
          <DataGrid
            columns={result.columns!}
            rows={rows}
            offset={offset}
            page={result.page}
            edit={result.edit}
            edits={result.edits}
            onOpen={(row, column) => onOpenCell(result.page, row, column)}
          />
        )}
        {!result.error && (mode === 'json' || !hasTable) && hasJson && <JsonViewer value={toJsonText(json)} />}
      </div>
    </>
  )
}

/** Shown only when there is more than one page. Shows the total row count once every page is read. */
function Pager({
  result,
  offset,
  running,
  onPage
}: {
  result: ResultState
  offset: number
  running: boolean
  onPage: (page: number) => void
}) {
  const { pages, page, hasMore, loading, downloading } = result
  if (pages.length === 1 && !hasMore) return null
  const count = pages[page].rows.length
  const range = count === 0 ? '0' : `${offset + 1}-${offset + count}`
  const total = !hasMore && !result.pageError && !result.pageNote ? pages.reduce((n, p) => n + p.rows.length, 0) : undefined
  // Pages already read stay viewable during a rerun. New pages are read after the run finishes.
  const canNext = page < pages.length - 1 || (hasMore && !running)
  return (
    <div className="pager">
      <button className="small" disabled={page === 0 || loading || downloading} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span className="pager-range">
        Rows {range}
        {total !== undefined ? ` of ${total}` : ''}
      </span>
      <button className="small" disabled={!canNext || loading || downloading} onClick={() => onPage(page + 1)}>
        {loading ? 'Loading...' : 'Next'}
      </button>
    </div>
  )
}

function DataGrid({
  columns,
  rows,
  offset,
  page,
  edit,
  edits,
  onOpen
}: {
  columns: string[]
  rows: unknown[][]
  offset: number
  page: number
  edit?: EditTarget
  edits?: Record<string, string | null>
  /** row is the index in rows, not the sorted position */
  onOpen: (row: number, column: number) => void
}) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 }>()
  const wrapRef = useRef<HTMLDivElement>(null)

  // Scroll to the top when the page changes. Saving edits replaces rows, but keeps the scroll.
  useEffect(() => {
    if (wrapRef.current) wrapRef.current.scrollTop = 0
  }, [page])

  // Row indexes in display order. Edits are kept by index, so they stay with their row when sorted.
  const order = useMemo(() => {
    const indexes = rows.map((_, i) => i)
    if (!sort) return indexes
    return indexes.sort((a, b) => compare(rows[a][sort.col], rows[b][sort.col]) * sort.dir)
  }, [rows, sort])

  function toggleSort(col: number) {
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : undefined))
  }

  if (columns.length === 0) return <div className="result-empty">No columns.</div>

  return (
    <div className="grid-wrap" ref={wrapRef}>
      <table className="grid">
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((c, i) => (
              <th
                key={i}
                onClick={() => toggleSort(i)}
                title={`Click to sort (this page only)${edit?.columns[i] ? '. Double-click a cell to edit it.' : ''}`}
              >
                {c}
                {sort?.col === i && <span className="sort">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((r, position) => (
            <tr key={r}>
              <td className="rownum">{offset + position + 1}</td>
              {columns.map((_, i) => {
                const key = cellKey(page, r, i)
                const edited = !!edits && key in edits
                const v = edited ? editedValue(edits[key], rows[r][i]) : rows[r][i]
                const text = formatCell(v)
                const kind = v === null ? 'null' : typeof v === 'object' ? 'object' : typeof v === 'number' ? 'number' : ''
                return (
                  <td
                    key={i}
                    className={edited ? `${kind} edited` : kind}
                    onDoubleClick={() => onOpen(r, i)}
                    title={text.length > 60 ? text.slice(0, 1000) : undefined}
                  >
                    {text.length > 300 ? text.slice(0, 300) + '...' : text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="result-empty">No rows.</div>}
    </div>
  )
}
