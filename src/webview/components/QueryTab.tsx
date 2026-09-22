import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@uiw/react-codemirror'
import type { SQLNamespace } from '@codemirror/lang-sql'
import { DB_LABELS } from '@shared/types'
import { useStore, type Tab } from '../store'
import { Editor, selectedText } from './Editor'
import { ResultView } from './ResultView'
import { Icon } from './Icon'
import { api } from '../api'

export function QueryTab({ tab, active }: { tab: Tab; active: boolean }) {
  const conn = useStore((s) => s.connections.find((c) => c.id === tab.connectionId))
  const { updateTab, runTab, showPage, download, openCell, saveEdits, discardEdits } = useStore.getState()
  const [databases, setDatabases] = useState<string[]>([])
  const [schema, setSchema] = useState<SQLNamespace>()
  const [split, setSplit] = useState(40)
  const viewRef = useRef<EditorView>(undefined)
  const bodyRef = useRef<HTMLDivElement>(null)

  const type = conn?.type
  const connId = conn?.id

  useEffect(() => {
    if (!connId || type === 'opensearch') return
    api.databases(connId).then(setDatabases, () => {})
  }, [connId, type])

  // For MySQL, autocomplete uses table names from the selected database
  useEffect(() => {
    if (!connId || type !== 'mysql' || !tab.database) {
      setSchema(undefined)
      return
    }
    api
      .children(connId, [tab.database])
      .then((nodes) => setSchema(Object.fromEntries(nodes.map((n) => [n.label, []]))), () => {})
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
