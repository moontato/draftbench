import { useEffect, useRef, useState } from 'react'
import type { AIProvider } from '../ai/types'
import { storage, errorMessage } from '../storage/desktop'
import {
  AI_LIMITS,
  MAX_PARALLEL_JOBS,
  backendConfig,
  legacyBackend,
  type Backend,
  type Settings,
} from './model'
import { updateBackend } from './backendEditing'
interface Props {
  draft: Settings
  onChange: (settings: Settings) => void
  provider: AIProvider
  onCredentialChange: (id?: string) => void | Promise<void>
  onWarning: (message: string) => void
  onBusyChange: (busy: boolean) => void
}
export function BackendManager({
  draft,
  onChange,
  provider,
  onCredentialChange,
  onWarning,
  onBusyChange,
}: Props) {
  const [selected, setSelected] = useState(draft.defaultBackend)
  const [key, setKey] = useState(''),
    [hasKey, setHasKey] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const connection = useRef<AbortController | null>(null)
  useEffect(() => () => connection.current?.abort(), [])
  useEffect(() => {
    onBusyChange(busy)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])
  const stored = draft.backends.find((b) => b.id === selected) ?? draft.backends[0]
  const backend = stored.id === 'default' ? { ...stored, ...draft.ai } : stored
  useEffect(() => {
    let active = true
    setKey('')
    setMessage('')
    setHasKey(false)
    void storage
      .hasKey(backend.credentialRef)
      .then((available) => {
        if (active) setHasKey(available)
      })
      .catch(() => {})
    return () => {
      active = false
      connection.current?.abort()
    }
  }, [backend.id, backend.credentialRef])
  const patch = (value: Partial<Backend>) => onChange(updateBackend(draft, backend.id, value))
  const add = () => {
    const id = `backend-${crypto.randomUUID()}`
    onChange({
      ...draft,
      backends: [
        ...draft.backends,
        {
          ...legacyBackend(),
          id,
          name: 'New backend',
          credentialRef: `backend:${id}`,
          credentialGeneration: 0,
        },
      ],
    })
    setSelected(id)
  }
  const remove = () => {
    if (Object.values(draft.analyzers).some((a) => a.backend === backend.id)) {
      setMessage('Reassign analyzer overrides before deleting this backend.')
      return
    }
    if (draft.backends.length === 1) {
      setMessage('Keep at least one backend.')
      return
    }
    const backends = draft.backends.filter((b) => b.id !== backend.id)
    onChange({
      ...draft,
      backends,
      defaultBackend: draft.defaultBackend === backend.id ? backends[0].id : draft.defaultBackend,
    })
    setSelected(backends[0].id)
    // Deletion never silently modifies an OS credential. Remove it explicitly first.
  }
  const storeKey = async (value: string) => {
    setBusy(true)
    setMessage('')
    let warning = ''
    try {
      await storage.setKey(value, backend.credentialRef)
    } catch (error) {
      warning = errorMessage(error)
    }
    try {
      await onCredentialChange(backend.id)
    } catch {
      warning += ' Credential generation could not be persisted.'
    }
    patch({ credentialGeneration: backend.credentialGeneration + 1 })
    setKey('')
    setHasKey(!!value)
    setBusy(false)
    if (warning) onWarning(warning)
    setMessage(warning || 'Backend key updated. No key is stored in settings.')
  }
  const test = async () => {
    setBusy(true)
    setMessage('')
    const controller = new AbortController()
    connection.current = controller
    try {
      const result = await provider.testConnection(
        backendConfig(draft, backend.id),
        controller.signal,
      )
      setMessage(result.message)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <h3>Named AI backends</h3>
      <p className="muted">
        OpenAI-compatible HTTP/HTTPS servers on localhost, LAN or Tailscale. No server-specific
        runtime or model downloads. Credentials belong to stable backend IDs, not display names.
      </p>
      <label className="field">
        Default backend
        <select
          value={draft.defaultBackend}
          onChange={(e) => onChange({ ...draft, defaultBackend: e.target.value })}
        >
          {draft.backends.map((b) => (
            <option value={b.id} key={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <div className="backend-list">
        {draft.backends.map((b) => (
          <button
            className={b.id === selected ? 'secondary-button active' : 'text-button'}
            key={b.id}
            onClick={() => {
              setSelected(b.id)
              setMessage('')
            }}
          >
            {b.id === draft.defaultBackend ? '★ ' : ''}
            {b.name}
          </button>
        ))}
      </div>
      <button
        className="secondary-button"
        disabled={draft.backends.length >= 20 || busy}
        onClick={add}
      >
        Add backend
      </button>
      <section className="management-editor" aria-label="Backend editor">
        <small>Stable ID: {backend.id}</small>
        <label className="field">
          Backend name
          <input
            maxLength={100}
            value={backend.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <label className="field">
          Backend server URL
          <input value={backend.serverUrl} onChange={(e) => patch({ serverUrl: e.target.value })} />
        </label>
        <label className="field">
          Backend default model
          <input value={backend.model} onChange={(e) => patch({ model: e.target.value })} />
        </label>
        <button className="secondary-button" disabled={busy} onClick={() => void test()}>
          Test backend connection
        </button>
        <details className="advanced">
          <summary>Backend advanced options</summary>
          <label className="field">
            Per-backend parallel jobs
            <select
              value={backend.parallelJobs}
              onChange={(e) => patch({ parallelJobs: Number(e.target.value) })}
            >
              {Array.from({ length: MAX_PARALLEL_JOBS }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Backend timeout (seconds)
            <input
              type="number"
              min={1}
              max={AI_LIMITS.timeoutMs / 1000}
              value={backend.timeoutMs / 1000}
              onChange={(e) => patch({ timeoutMs: Number(e.target.value) * 1000 })}
            />
          </label>
          <label className="field">
            Backend temperature
            <input
              type="number"
              min={0}
              max={2}
              step="0.1"
              value={backend.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Backend maximum output tokens
            <input
              type="number"
              min={256}
              max={AI_LIMITS.maxTokens}
              value={backend.maxTokens}
              onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Backend API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              placeholder={hasKey ? 'Key available; leave unchanged' : 'Optional'}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <p className="muted">
            Key changes apply immediately, even if other settings are cancelled. They clear cached
            reviews. New backends never inherit another server's key. An unavailable OS key store
            uses an explicit session-only override.
          </p>
          <div className="management-actions">
            <button
              className="secondary-button"
              disabled={busy || !key}
              onClick={() => void storeKey(key)}
            >
              Store backend key
            </button>
            <button className="text-button" disabled={busy} onClick={() => void storeKey('')}>
              Remove backend key
            </button>
          </div>
        </details>
        <button
          className="text-button"
          disabled={busy || draft.backends.length === 1}
          onClick={remove}
        >
          Delete backend
        </button>
        {message && <p role="status">{message}</p>}
      </section>
      <h3>Concurrency</h3>
      <label className="field">
        Global AI concurrency
        <select
          value={draft.analysis.parallelJobs}
          onChange={(e) =>
            onChange({
              ...draft,
              analysis: { ...draft.analysis, parallelJobs: Number(e.target.value) },
            })
          }
        >
          {Array.from({ length: MAX_PARALLEL_JOBS }, (_, i) => (
            <option key={i} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
      <label className="check-field">
        <input
          type="checkbox"
          checked={draft.analysis.legacySingleModel}
          onChange={(e) =>
            onChange({
              ...draft,
              analysis: { ...draft.analysis, legacySingleModel: e.target.checked },
            })
          }
        />
        Preserve v0.1 single-backend/single-model scheduling
      </label>
      <p className="muted">
        Migrated global concurrency remains unchanged (default 1). With multiple backends—or the
        legacy policy off—each server also has its own cap (default 2). Set global concurrency to 4
        to run two jobs on each of two servers. Aliases for one server share the stricter cap;
        cached/local work takes no AI slot. Server slots and RAM/VRAM must still support the chosen
        load.
      </p>
    </div>
  )
}
