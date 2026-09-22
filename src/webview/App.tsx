import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { QueryTab } from './components/QueryTab'
import { ConnectionDialog } from './components/ConnectionDialog'
import { ValueModal } from './components/ValueModal'
import { Icon } from './components/Icon'

export default function App() {
  const load = useStore((s) => s.load)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const editing = useStore((s) => s.editing)
  const preview = useStore((s) => s.preview)

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {tabs.length > 0 ? (
          <>
            <TabBar />
            {tabs.map((t) => (
              <QueryTab key={t.id} tab={t} active={t.id === activeTabId} />
            ))}
          </>
        ) : (
          <Welcome />
        )}
      </main>
      {editing !== undefined && <ConnectionDialog initial={editing} />}
      {preview && <ValueModal />}
    </div>
  )
}

function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const connections = useStore((s) => s.connections)

  return (
    <div className="tab-bar">
      {tabs.map((t) => {
        const conn = connections.find((c) => c.id === t.connectionId)
        return (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? 'active' : ''}`}
            onClick={() => useStore.setState({ activeTabId: t.id })}
            onAuxClick={(e) => e.button === 1 && useStore.getState().closeTab(t.id)}
            title={conn ? `${conn.name} · ${t.title}` : t.title}
          >
            <span className={`type-dot ${conn?.type ?? ''}`} />
            <span className="tab-title">{t.title}</span>
            {t.running && <span className="spinner" />}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().closeTab(t.id)
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Welcome() {
  const setEditing = useStore((s) => s.setEditing)
  const hasConnections = useStore((s) => s.connections.length > 0)
  return (
    <div className="welcome">
      <h1>AnyQuery</h1>
      <p>Query MySQL, PostgreSQL, MongoDB, Redis and OpenSearch in one place.</p>
      <p className="muted">
        {hasConnections
          ? 'Expand a connection on the left, then click a table or key to query it.'
          : 'Add a connection to get started.'}
      </p>
      <button className="primary" onClick={() => setEditing(null)}>
        New connection
      </button>
    </div>
  )
}
