import { useEffect, useState } from 'react'
import { DB_LABELS, type ConnectionConfig, type TreeNode } from '@shared/types'
import { useStore } from '../store'
import { Icon, kindIcon } from './Icon'
import { api } from '../api'

export function Sidebar() {
  const connections = useStore((s) => s.connections)
  const setEditing = useStore((s) => s.setEditing)

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="app-title">AnyQuery</span>
        <button className="icon-button" title="New connection" onClick={() => setEditing(null)}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="conn-list">
        {connections.length === 0 && (
          <div className="empty-hint">
            No connections yet.
            <button className="link" onClick={() => setEditing(null)}>
              Add a connection
            </button>
          </div>
        )}
        {connections.map((c) => (
          <ConnectionItem key={c.id} conn={c} />
        ))}
      </div>
    </aside>
  )
}

function ConnectionItem({ conn }: { conn: ConnectionConfig }) {
  const status = useStore((s) => s.status[conn.id])
  const { setStatus, setEditing, removeConnection, disconnect, openTab, runTab } = useStore.getState()
  const [expanded, setExpanded] = useState(false)
  const [nodes, setNodes] = useState<TreeNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  /** Added to keys so the whole subtree re-renders on refresh */
  const [generation, setGeneration] = useState(0)

  // Reset the tree when the settings change
  useEffect(() => {
    setNodes(null)
    setExpanded(false)
    setError(undefined)
  }, [conn])

  async function load() {
    setLoading(true)
    setError(undefined)
    setStatus(conn.id, 'connecting')
    try {
      setNodes(await api.children(conn.id, []))
      setGeneration((g) => g + 1)
      setStatus(conn.id, 'connected')
    } catch (err) {
      setError((err as Error).message)
      setStatus(conn.id, 'error')
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    const next = !expanded
    setExpanded(next)
    if (next && !nodes) load()
  }

  async function openNode(node: TreeNode) {
    try {
      const q = await api.openQuery(conn.id, node.path)
      const id = openTab(conn.id, { query: q.query, database: q.database, title: node.label })
      runTab(id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function onDisconnect() {
    await disconnect(conn.id)
    setNodes(null)
    setExpanded(false)
  }

  async function onRemove() {
    if (!(await api.confirm(`Delete connection '${conn.name}'?`, 'Delete'))) return
    await removeConnection(conn.id)
  }

  return (
    <div className="conn">
      <div className="tree-row conn-row" onClick={toggle}>
        <Icon name="chevron" size={12} className={`chevron ${expanded ? 'open' : ''}`} />
        <span className={`db-badge ${conn.type}`}>{DB_LABELS[conn.type]}</span>
        <span className="label">{conn.name}</span>
        <span className={`status-dot ${status ?? ''}`} title={status ?? 'not connected'} />
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-button" title="New query" onClick={() => openTab(conn.id)}>
            <Icon name="query" />
          </button>
          <button
            className="icon-button"
            title="Refresh"
            onClick={() => {
              setExpanded(true)
              load()
            }}
          >
            <Icon name="refresh" />
          </button>
          <button className="icon-button" title="Edit" onClick={() => setEditing(conn)}>
            <Icon name="edit" />
          </button>
          {status === 'connected' ? (
            <button className="icon-button" title="Disconnect" onClick={onDisconnect}>
              <Icon name="unplug" />
            </button>
          ) : (
            <button className="icon-button" title="Delete" onClick={onRemove}>
              <Icon name="trash" />
            </button>
          )}
        </span>
      </div>
      {expanded && (
        <div className="tree-children">
          {loading && <div className="tree-note" style={{ paddingLeft: 28 }}>Loading...</div>}
          {error && <div className="tree-note error" style={{ paddingLeft: 28 }}>{error}</div>}
          {!loading &&
            nodes?.map((n) => (
              <TreeItem
                key={`${generation}:${n.path.join('\u0000')}`}
                connId={conn.id}
                node={n}
                depth={1}
                onOpen={openNode}
              />
            ))}
          {!loading && nodes?.length === 0 && <div className="tree-note" style={{ paddingLeft: 28 }}>Empty</div>}
        </div>
      )}
    </div>
  )
}

interface TreeItemProps {
  connId: string
  node: TreeNode
  depth: number
  onOpen(node: TreeNode): void
}

function TreeItem({ connId, node, depth, onOpen }: TreeItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<TreeNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const indent = 8 + depth * 14

  async function toggle() {
    const next = !expanded
    setExpanded(next)
    if (next && !children) {
      setLoading(true)
      setError(undefined)
      try {
        setChildren(await api.children(connId, node.path))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    }
  }

  function onClick() {
    if (node.openable) onOpen(node)
    else if (node.expandable) toggle()
  }

  if (node.kind === 'more') {
    return (
      <div className="tree-note" style={{ paddingLeft: indent + 18 }}>
        {node.label}
      </div>
    )
  }

  return (
    <>
      <div
        className={`tree-row ${node.openable ? 'openable' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={onClick}
        title={node.openable ? 'Click to query' : undefined}
      >
        {node.expandable ? (
          <span
            className="chevron-hit"
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
          >
            <Icon name="chevron" size={12} className={`chevron ${expanded ? 'open' : ''}`} />
          </span>
        ) : (
          <span className="chevron-space" />
        )}
        <Icon name={kindIcon(node.kind)} className={`kind-icon ${node.kind}`} />
        <span className="label">{node.label}</span>
        {node.detail && <span className="detail">{node.detail}</span>}
      </div>
      {expanded && (
        <>
          {loading && <div className="tree-note" style={{ paddingLeft: indent + 32 }}>Loading...</div>}
          {error && <div className="tree-note error" style={{ paddingLeft: indent + 32 }}>{error}</div>}
          {children?.map((c) => (
            <TreeItem key={c.path.join('\u0000')} connId={connId} node={c} depth={depth + 1} onOpen={onOpen} />
          ))}
          {!loading && children?.length === 0 && (
            <div className="tree-note" style={{ paddingLeft: indent + 32 }}>Empty</div>
          )}
        </>
      )}
    </>
  )
}
