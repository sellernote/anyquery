import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@uiw/react-codemirror'
import { DB_LABELS, type CompletionSchema } from '@shared/types'
import { useStore, type Tab } from '../store'
import { Editor, selectedText } from './Editor'
import { ResultView } from './ResultView'
import { Icon } from './Icon'
import { api } from '../api'

export function QueryTab({ tab, active }: { tab: Tab; active: boolean }) {
  const conn = useStore((s) => s.connections.find((c) => c.id === tab.connectionId))
  const { updateTab, runTab, cancelTab, showPage, download, openCell, saveEdits, discardEdits } = useStore.getState()
  const [databases, setDatabases] = useState<string[]>([])
  const [schema, setSchema] = useState<CompletionSchema>()
  const [split, setSplit] = useState(40)
  const viewRef = useRef<EditorView>(undefined)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Tabs restored when the panel opens connect only once they are shown
  const [shown, setShown] = useState(active)
  useEffect(() => {
    if (active) setShown(true)
  }, [active])

  const type = conn?.type
  const connId = shown ? conn?.id : undefined

  useEffect(() => {
    if (!connId || type === 'opensearch') return
    api.databases(connId).then(setDatabases, () => {})
  }, [connId, type])

  // MySQL and PostgreSQL autocomplete table and column names from the selected database
  useEffect(() => {
    setSchema(undefined)
    if (!connId || (type !== 'mysql' && type !== 'postgres')) return
    // Ignore a slow answer for a database that is no longer selected
    let current = true
    api.completions(connId, tab.database).then((s) => current && setSchema(s), () => {})
    return () => {
      current = false
    }
  }, [connId, type, tab.database])

  if (!conn) return null

  const run = (text?: string) => runTab(tab.id, text)

  function startDrag(e: React.MouseEvent) {
    e.preventDefault()
    const rect = bodyRef.current!.getBoundingClientRect()
    const onMove = (ev: MouseEvent) => {
      const pct = ((ev.clientY - rect.top) / rect.height) * 100
      setSplit(Math.min(85, Math.max(15, pct)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const defaultDbLabel =
    conn.type === 'mongodb'
      ? `Default (${conn.database || 'test'})`
      : conn.type === 'postgres'
        ? `Default (${conn.database || 'postgres'})`
        : 'None'
  const dbOptions = tab.database && !databases.includes(tab.database) ? [tab.database, ...databases] : databases

  return (
    <div className="query-tab" style={{ display: active ? 'flex' : 'none' }}>
      <div className="toolbar">
        <span className={`db-badge ${conn.type}`}>{DB_LABELS[conn.type]}</span>
        <span className="conn-name">{conn.name}</span>
        {conn.type !== 'opensearch' && (
          <select
            value={tab.database ?? ''}
            onChange={(e) => updateTab(tab.id, { database: e.target.value || undefined })}
            title="Database"
          >
            {conn.type !== 'redis' && <option value="">{defaultDbLabel}</option>}
            {dbOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <button
          className="primary run-button"
          disabled={tab.running || tab.saving}
          onClick={() => run(selectedText(viewRef.current))}
          title="Cmd+Enter / Ctrl+Enter"
        >
          <Icon name="play" size={12} />
          {tab.running ? 'Running...' : 'Run'}
        </button>
        {tab.running && (
          <button onClick={() => cancelTab(tab.id)} disabled={tab.canceling} title="Stop the running query">
            {tab.canceling ? 'Canceling...' : 'Cancel'}
          </button>
        )}
        <span className="hint">Cmd+Enter to run. Select text to run only that part.</span>
      </div>
      <div className="tab-content" ref={bodyRef}>
        <div className="editor-pane" style={{ height: `${split}%` }}>
          <Editor
            type={conn.type}
            value={tab.query}
            schema={schema}
            onChange={(query) => updateTab(tab.id, { query })}
            onRun={run}
            onView={(view) => (viewRef.current = view)}
          />
        </div>
        <div className="splitter" onMouseDown={startDrag} />
        <div className="result-pane">
          <ResultView
            key={tab.runId}
            results={tab.results}
            running={tab.running}
            saving={tab.saving}
            onPage={(index, page) => showPage(tab.id, index, page)}
            onDownload={(index, format) => download(tab.id, index, format)}
            onOpenCell={(index, page, row, column) => openCell({ tabId: tab.id, index, page, row, column })}
            onSave={(index) => saveEdits(tab.id, index)}
            onDiscard={(index) => discardEdits(tab.id, index)}
          />
        </div>
      </div>
    </div>
  )
}
