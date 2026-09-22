import { useEffect, useState } from 'react'
import { plural } from '@shared/format'
import { useStore } from '../store'
import { api } from '../api'
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
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPreview(undefined)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPreview])

  if (!preview) return null
  const { text, isJson } = pretty(preview.value)

  async function copy() {
    await api.copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => setPreview(undefined)}>
      <div className="modal value-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{preview.title}</h2>
        <div className="value-body">{isJson ? <JsonViewer value={text} /> : <pre>{text}</pre>}</div>
        <div className="modal-actions">
          <span className="muted">{plural(text.length, 'character')}</span>
          <span className="spacer" />
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button className="primary" onClick={() => setPreview(undefined)}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
