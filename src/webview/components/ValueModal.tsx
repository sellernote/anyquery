import { useEffect, useState } from 'react'
import { plural } from '@shared/format'
import { useStore, type CellRef } from '../store'
import { api } from '../api'
import { cellKey, editText } from '../edits'
import { JsonViewer } from './Editor'

/** Pretty-prints the string if it is JSON */
function pretty(value: unknown): { text: string; isJson: boolean } {
  if (typeof value === 'string') {
    const t = value.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return { text: JSON.stringify(JSON.parse(t), null, 2), isJson: true }
      } catch {
        // Not JSON: show as is
      }
    }
    return { text: value, isJson: false }
  }
  if (value === null) return { text: 'NULL', isJson: false }
  if (value === undefined) return { text: '', isJson: false }
  return { text: JSON.stringify(value, null, 2), isJson: typeof value === 'object' }
}

export function ValueModal() {
  const preview = useStore((s) => s.preview)
  const setPreview = useStore((s) => s.setPreview)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPreview(undefined)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPreview])

  if (!preview) return null

  return (
    <div className="modal-backdrop" onMouseDown={() => setPreview(undefined)}>
      <div className="modal value-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{preview.title}</h2>
        {preview.detail && <div className="muted">{preview.detail}</div>}
        {preview.cell ? <CellEditor cell={preview.cell} value={preview.value} /> : <ValueView value={preview.value} />}
      </div>
    </div>
  )
}

function ValueView({ value }: { value: unknown }) {
  const setPreview = useStore((s) => s.setPreview)
  const [copied, setCopied] = useState(false)
  const { text, isJson } = pretty(value)

  async function copy() {
    await api.copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <>
      <div className="value-body">{isJson ? <JsonViewer value={text} /> : <pre>{text}</pre>}</div>
      <div className="modal-actions">
        <span className="muted">{plural(text.length, 'character')}</span>
        <span className="spacer" />
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button className="primary" onClick={() => setPreview(undefined)}>
          Close
        </button>
      </div>
    </>
  )
}

/** Edits a cell. The change stays unsaved until Save is clicked above the results. */
function CellEditor({ cell, value }: { cell: CellRef; value: unknown }) {
  const setPreview = useStore((s) => s.setPreview)
  const editCell = useStore((s) => s.editCell)
  const pending = useStore(
    (s) => s.tabs.find((t) => t.id === cell.tabId)?.results[cell.index]?.edits?.[cellKey(cell.page, cell.row, cell.column)]
  )
  const [text, setText] = useState(() => (pending !== undefined ? (pending ?? '') : editText(value)))
  const [isNull, setIsNull] = useState(() => (pending !== undefined ? pending === null : value === null))
  const close = () => setPreview(undefined)

  function apply() {
    const next = isNull ? null : text
    const unchanged = next === null ? value === null : value !== null && next === editText(value)
    editCell(cell, unchanged ? undefined : next)
    close()
  }

  function undo() {
    editCell(cell, undefined)
    close()
  }

  return (
    <>
      <div className="value-body">
        <textarea
          autoFocus
          spellCheck={false}
          value={text}
          placeholder={isNull ? 'NULL' : ''}
          onChange={(e) => {
            setText(e.target.value)
            setIsNull(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              apply()
            }
          }}
        />
      </div>
      <div className="modal-actions">
        <button
          onClick={() => {
            setText('')
            setIsNull(true)
          }}
          disabled={isNull}
        >
          Set NULL
        </button>
        {pending !== undefined && <button onClick={undo}>Undo change</button>}
        <span className="muted">{isNull ? 'NULL' : plural(text.length, 'character')}</span>
        <span className="spacer" />
        <button onClick={close}>Cancel</button>
        <button className="primary" onClick={apply} title="Cmd+Enter / Ctrl+Enter">
          Apply
        </button>
      </div>
    </>
  )
}
