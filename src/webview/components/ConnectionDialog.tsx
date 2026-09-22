import { useEffect, useState } from 'react'
import { DB_LABELS, DEFAULT_PORTS, type ConnectionConfig, type DbType } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'

const TYPES = Object.keys(DB_LABELS) as DbType[]

function blank(): ConnectionConfig {
  return { id: crypto.randomUUID(), name: '', type: 'mysql', host: '127.0.0.1', port: DEFAULT_PORTS.mysql }
}

export function ConnectionDialog({ initial }: { initial: ConnectionConfig | null }) {
  const saveConnection = useStore((s) => s.saveConnection)
  const setEditing = useStore((s) => s.setEditing)
  const [form, setForm] = useState<ConnectionConfig>(() => initial ?? blank())
  const [test, setTest] = useState<{ ok: boolean; message: string } | 'running'>()
  const [saveError, setSaveError] = useState<string>()

  const close = () => setEditing(undefined)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function set<K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setTest(undefined)
  }

  function setType(type: DbType) {
    setForm((f) => ({
      ...f,
      type,
      // If the port was not changed by hand, switch to the new type's default port
      port: f.port === DEFAULT_PORTS[f.type] ? DEFAULT_PORTS[type] : f.port
    }))
    setTest(undefined)
  }

  function normalized(): ConnectionConfig {
    const name = form.name.trim() || `${form.host}:${form.port}`
    return { ...form, name, host: form.host.trim(), port: Number(form.port) || DEFAULT_PORTS[form.type] }
  }

  async function onTest() {
    setTest('running')
    try {
      setTest({ ok: true, message: `Connected: ${await api.testConnection(normalized())}` })
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message })
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    try {
      await saveConnection(normalized())
      close()
    } catch (err) {
      setSaveError((err as Error).message)
    }
  }

  const t = form.type
  const usesUri = t === 'mongodb' && !!form.uri?.trim()

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={onSave}>
        <h2>{initial ? 'Edit connection' : 'New connection'}</h2>

        <div className="type-picker">
          {TYPES.map((type) => (
            <button
              type="button"
              key={type}
              className={`type-option ${type} ${t === type ? 'selected' : ''}`}
              onClick={() => setType(type)}
            >
              {DB_LABELS[type]}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Name</span>
          <input value={form.name} placeholder={`${form.host}:${form.port}`} onChange={(e) => set('name', e.target.value)} />
        </label>

        {t === 'mongodb' && (
          <label className="field">
            <span>URI</span>
            <input
              value={form.uri ?? ''}
              placeholder="mongodb+srv://user:pass@cluster.example.net/ (overrides the fields below)"
              onChange={(e) => set('uri', e.target.value)}
            />
          </label>
        )}

        <fieldset disabled={usesUri} className="field-group">
          <div className="field-row">
            <label className="field grow">
              <span>Host</span>
              <input
                value={form.host}
                placeholder={t === 'opensearch' ? 'localhost or https://search.example.com' : 'localhost'}
                onChange={(e) => set('host', e.target.value)}
                required={!usesUri}
              />
            </label>
            <label className="field port">
              <span>Port</span>
              <input
                type="number"
                value={form.port}
                onChange={(e) => set('port', Number(e.target.value))}
                min={1}
                max={65535}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field grow">
              <span>User</span>
              <input
                value={form.user ?? ''}
                placeholder={t === 'redis' ? 'ACL user (leave empty if none)' : ''}
                onChange={(e) => set('user', e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="field grow">
              <span>Password</span>
              <input
                type="password"
                value={form.password ?? ''}
                onChange={(e) => set('password', e.target.value)}
                autoComplete="new-password"
              />
            </label>
          </div>

          <div className="checks">
            <label className="check">
              <input type="checkbox" checked={!!form.tls} onChange={(e) => set('tls', e.target.checked)} />
              Use TLS
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={!!form.allowInvalidCert}
                onChange={(e) => set('allowInvalidCert', e.target.checked)}
              />
              Skip certificate verification (self-signed)
            </label>
          </div>
        </fieldset>

        {(t === 'mysql' || t === 'postgres' || t === 'mongodb') && (
          <label className="field">
            <span>Default database</span>
            <input
              value={form.database ?? ''}
              placeholder="Optional"
              onChange={(e) => set('database', e.target.value)}
            />
          </label>
        )}

        <p className="note">Passwords are encrypted with the OS keychain and stored only on this computer.</p>

        {test && test !== 'running' && <div className={`test-result ${test.ok ? 'ok' : 'fail'}`}>{test.message}</div>}
        {saveError && <div className="test-result fail">{saveError}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onTest} disabled={test === 'running'}>
            {test === 'running' ? 'Testing...' : 'Test connection'}
          </button>
          <span className="spacer" />
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
