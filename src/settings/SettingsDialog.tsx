import { useEffect, useRef, useState } from 'react'
import { Modal } from '../ui/Modal'
import { CheckCircle2, ExternalLink, LoaderCircle, LockKeyhole, X } from 'lucide-react'
import { analyzers } from '../analyzers/registry'
import { AI_LIMITS, defaultSettings, type Settings } from './model'
import { storage, errorMessage } from '../storage/desktop'
import type { AIProvider } from '../ai/types'
interface Props {
  settings: Settings
  initialTab: string
  provider: AIProvider
  onSave: (settings: Settings) => Promise<void>
  onClose: () => void
  onClearCache: () => void
  onCredentialChange: () => void
  onWarning: (message: string) => void
}
export function SettingsDialog({
  settings,
  initialTab,
  provider,
  onSave,
  onClose,
  onClearCache,
  onCredentialChange,
  onWarning,
}: Props) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings))
  const [tab, setTab] = useState(initialTab),
    [key, setKey] = useState(''),
    [hasKey, setHasKey] = useState(false)
  const connection = useRef<AbortController | null>(null)
  useEffect(() => () => connection.current?.abort(), [])
  const [testing, setTesting] = useState(false),
    [result, setResult] = useState(''),
    [models, setModels] = useState<string[]>([]),
    [failed, setFailed] = useState(false),
    [saving, setSaving] = useState(false),
    [changeKey, setChangeKey] = useState(false)
  useEffect(() => {
    void storage
      .hasKey()
      .then(setHasKey)
      .catch(() => {})
  }, [])
  const ai = <K extends keyof Settings['ai']>(field: K, value: Settings['ai'][K]) =>
    setDraft((old) => ({ ...old, ai: { ...old.ai, [field]: value } }))
  const storeKey = async (): Promise<string> => {
    if (!changeKey) return ''
    let warning = ''
    try {
      await storage.setKey(key)
    } catch (error) {
      warning = errorMessage(error)
    }
    setHasKey(!!key)
    onCredentialChange()
    ai('credentialGeneration', draft.ai.credentialGeneration + 1)
    setChangeKey(false)
    setKey('')
    return warning
  }
  const test = async () => {
    setTesting(true)
    setResult('')
    setFailed(false)
    const warning = await storeKey()
    if (warning) onWarning(warning)
    const controller = new AbortController()
    connection.current = controller
    try {
      const response = await provider.testConnection(draft.ai, controller.signal)
      setModels(response.models)
      setResult(response.message + (warning ? ` ${warning}` : ''))
      setFailed(!!warning)
    } catch (error) {
      setFailed(true)
      setResult(errorMessage(error) + (warning ? ` ${warning}` : ''))
    } finally {
      setTesting(false)
    }
  }
  const save = async () => {
    setSaving(true)
    const warning = await storeKey()
    try {
      await onSave({
        ...draft,
        ai: {
          ...draft.ai,
          credentialGeneration: draft.ai.credentialGeneration + (changeKey ? 1 : 0),
        },
      })
      if (warning) onWarning(warning)
      onClose()
    } catch (error) {
      setFailed(true)
      setResult(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      onEscape={() => {
        if (!saving) {
          connection.current?.abort()
          onClose()
        }
      }}
    >
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <header>
          <div>
            <span className="eyebrow">DRAFTBENCH</span>
            <h2>Settings</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close settings"
            disabled={saving}
            onClick={() => {
              connection.current?.abort()
              onClose()
            }}
          >
            <X size={19} />
          </button>
        </header>
        <div className="settings-body">
          <nav aria-label="Settings categories">
            {['General', 'Editor', 'Analysis', 'AI'].map((name) => (
              <button
                key={name}
                className={tab === name ? 'active' : ''}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
            <div className="settings-nav-note">
              <LockKeyhole size={16} />
              <p>
                Local files.
                <br />
                Your choice of AI.
                <br />
                No account.
              </p>
            </div>
          </nav>
          <div className="settings-content">
            {tab === 'AI' && (
              <>
                <span className="eyebrow">YOUR INFERENCE SERVER</span>
                <h3>OpenAI-Compatible / llama.cpp</h3>
                <p className="muted">
                  Draftbench is a client. Run your model wherever you like—on this computer, your
                  LAN, or your tailnet.
                </p>
                <label className="field">
                  Server URL
                  <input
                    autoFocus
                    value={draft.ai.serverUrl}
                    placeholder="http://localhost:8080"
                    onChange={(e) => ai('serverUrl', e.target.value)}
                  />
                  <small>HTTP and HTTPS supported. No browser CORS configuration needed.</small>
                </label>
                <label className="field">
                  Default Model ID
                  <input
                    list="discovered-models"
                    value={draft.ai.model}
                    placeholder="qwen3-8b"
                    onChange={(e) => ai('model', e.target.value)}
                  />
                  <small>
                    Use the ID or alias served by your server. Every AI analyzer inherits this model
                    unless overridden.
                  </small>
                </label>
                <datalist id="discovered-models">
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <button
                  className="secondary-button"
                  disabled={testing}
                  onClick={() => {
                    void test()
                  }}
                >
                  {testing ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <ExternalLink size={15} />
                  )}{' '}
                  {testing ? 'Testing connection…' : 'Test Connection'}
                </button>
                <details className="advanced">
                  <summary>Advanced settings</summary>
                  <p className="muted">
                    Key changes apply on Test Connection or Save, even if you later cancel other
                    settings. Cached reviews are cleared.
                  </p>
                  <label className="field">
                    API key {hasKey && <small>Key available; leave unchanged to keep it.</small>}
                    <input
                      type="password"
                      autoComplete="off"
                      value={key}
                      placeholder={hasKey ? '•••••••• (leave unchanged)' : 'Optional'}
                      onChange={(e) => {
                        setKey(e.target.value)
                        setChangeKey(true)
                      }}
                    />
                  </label>
                  <button
                    className="text-button"
                    onClick={() => {
                      setKey('')
                      setChangeKey(true)
                      setHasKey(false)
                    }}
                  >
                    Remove saved key
                  </button>
                  <div className="field-row">
                    <label className="field">
                      Timeout (seconds)
                      <input
                        type="number"
                        min="1"
                        max={AI_LIMITS.timeoutMs / 1000}
                        value={draft.ai.timeoutMs / 1000}
                        onChange={(e) => ai('timeoutMs', Number(e.target.value) * 1000)}
                      />
                    </label>
                    <label className="field">
                      Temperature
                      <input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={draft.ai.temperature}
                        onChange={(e) => ai('temperature', Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <label className="field">
                    Maximum output tokens
                    <input
                      type="number"
                      min="256"
                      max={AI_LIMITS.maxTokens}
                      value={draft.ai.maxTokens}
                      onChange={(e) => ai('maxTokens', Number(e.target.value))}
                    />
                  </label>
                </details>
                <div className="privacy-note">
                  <LockKeyhole size={16} />
                  <span>
                    Text is sent only to the server you configure, and only when you run analysis.
                    No telemetry.
                  </span>
                </div>
              </>
            )}
            {tab === 'Analysis' && (
              <>
                <span className="eyebrow">REVIEWERS, NOT REWRITERS</span>
                <h3>Choose your analyzers</h3>
                <p className="muted">
                  Semantic analysis runs only when requested. Rules can run locally as you write.
                </p>
                {analyzers.map((analyzer) => (
                  <section className="analyzer-setting" key={analyzer.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.analyzers[analyzer.id]?.enabled ?? true}
                        onChange={(e) =>
                          setDraft((old) => ({
                            ...old,
                            analyzers: {
                              ...old.analyzers,
                              [analyzer.id]: {
                                model: old.analyzers[analyzer.id]?.model ?? '',
                                enabled: e.target.checked,
                              },
                            },
                          }))
                        }
                      />
                      <strong>{analyzer.name}</strong>
                      <span className="ai-tag">{analyzer.engine === 'ai' ? 'AI' : 'LOCAL'}</span>
                    </label>
                    <p>{analyzer.description}</p>
                    {analyzer.engine === 'ai' && (
                      <label className="field small-field">
                        Model override
                        <input
                          value={draft.analyzers[analyzer.id]?.model ?? ''}
                          placeholder={`Default · ${draft.ai.model}`}
                          onChange={(e) =>
                            setDraft((old) => ({
                              ...old,
                              analyzers: {
                                ...old.analyzers,
                                [analyzer.id]: {
                                  enabled: old.analyzers[analyzer.id]?.enabled ?? true,
                                  model: e.target.value,
                                },
                              },
                            }))
                          }
                        />
                      </label>
                    )}
                  </section>
                ))}
                <button className="secondary-button" onClick={onClearCache}>
                  Clear analysis cache
                </button>
                <p className="muted">
                  Project analysis caches may contain excerpts from your writing.
                </p>
              </>
            )}
            {tab === 'Editor' && (
              <>
                <h3>A comfortable writing surface</h3>
                <label className="field">
                  Prose size
                  <input
                    type="range"
                    min="14"
                    max="24"
                    value={draft.editor.fontSize}
                    onChange={(e) =>
                      setDraft((old) => ({
                        ...old,
                        editor: { ...old.editor, fontSize: Number(e.target.value) },
                      }))
                    }
                  />
                  <small>{draft.editor.fontSize}px</small>
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.editor.spellcheck}
                    onChange={(e) =>
                      setDraft((old) => ({
                        ...old,
                        editor: { ...old.editor, spellcheck: e.target.checked },
                      }))
                    }
                  />
                  Native spellcheck
                </label>
                <p className="muted">
                  Inline analyzer diagnostics remain separate from operating-system spellcheck.
                </p>
              </>
            )}
            {tab === 'General' && (
              <>
                <h3>Your writing, your files</h3>
                <p className="muted">
                  Draftbench works directly in normal Markdown folders. Nothing is hidden in an
                  application database.
                </p>
                <label className="field">
                  Default writing profile
                  <select
                    value={draft.general.defaultProfile}
                    onChange={(e) =>
                      setDraft((old) => ({
                        ...old,
                        general: {
                          defaultProfile: e.target.value as Settings['general']['defaultProfile'],
                        },
                      }))
                    }
                  >
                    <option value="general">General prose</option>
                    <option value="technical">Technical writing</option>
                    <option value="essay">Essay</option>
                    <option value="email">Professional email</option>
                  </select>
                </label>
                <div className="privacy-note">
                  <CheckCircle2 size={18} />
                  <span>
                    No accounts, telemetry, cloud sync, chat, or automatic prose generation.
                  </span>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    const defaults = defaultSettings()
                    defaults.ai.credentialGeneration = draft.ai.credentialGeneration
                    setDraft(defaults)
                  }}
                >
                  Restore defaults
                </button>
              </>
            )}
            {result && (
              <div className={`connection-result ${failed ? 'error' : 'success'}`} role="status">
                {result}
              </div>
            )}
          </div>
        </div>
        <footer>
          <button
            className="secondary-button"
            disabled={saving}
            onClick={() => {
              connection.current?.abort()
              onClose()
            }}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={testing || saving}
            onClick={() => {
              void save()
            }}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
