import { useEffect, useState } from 'react'
import { DB_LABELS, type ConnectionConfig, type TreeNode } from '@shared/types'
import { useStore } from '../store'
import { Icon, kindIcon } from './Icon'
import { api } from '../api'

/**
 * Only nodes that open a query (tables, collections, keys, indices) are filtered.
 * Databases, schemas and columns always show, so a match stays reachable.
 */
function passes(node: TreeNode, filter: string): boolean {
  return !filter || !node.openable || node.label.toLowerCase().includes(filter)
}

/** The sidebar filter, lowercased */
const useFilter = () => useStore((s) => s.treeFilter.trim().toLowerCase())

/** The note for a loaded list that shows nothing */
function emptyNote(nodes: TreeNode[] | null, shown: TreeNode[] | undefined): string | undefined {
  if (!nodes || shown?.length) return
  return nodes.length === 0 ? 'Empty' : 'No matches'
}

export function Sidebar() {
  const connections = useStore((s) => s.connections)
  const setEditing = useStore((s) => s.setEditing)
  const treeFilter = useStore((s) => s.treeFilter)
  const setFilter = (treeFilter: string) => useStore.setState({ treeFilter })

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="app-title">AnyQuery</span>
        <button className="icon-button" title="New connection" onClick={() => setEditing(null)}>
          <Icon name="plus" />
        </button>
      </div>
      {connections.length > 0 && (
        <div className="tree-filter">
          <input
            value={treeFilter}
            placeholder="Filter tables"
            title="Filters tables, collections, keys and indices in the lists already expanded. Esc clears it."
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          />
          {treeFilter && (
            <button className="icon-button" title="Clear" onClick={() => setFilter('')}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      )}
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
  const filter = useFilter()
  const shown = nodes?.filter((n) => passes(n, filter))
  const note = emptyNote(nodes, shown)

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
            shown?.map((n) => (
              <TreeItem
                key={`${generation}:${n.path.join('\u0000')}`}
                connId={conn.id}
                node={n}
                depth={1}
                onOpen={openNode}
              />
            ))}
          {!loading && note && <div className="tree-note" style={{ paddingLeft: 28 }}>{note}</div>}
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
  const filter = useFilter()
  const shown = children?.filter((n) => passes(n, filter))
  const note = emptyNote(children, shown)
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
          {shown?.map((c) => (
            <TreeItem key={c.path.join('\u0000')} connId={connId} node={c} depth={depth + 1} onOpen={onOpen} />
          ))}
          {!loading && note && <div className="tree-note" style={{ paddingLeft: indent + 32 }}>{note}</div>}
        </>
      )}
    </>
  )
}
