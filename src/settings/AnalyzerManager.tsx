import { useState } from 'react'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { backendConfig, type Settings } from './model'
import { customAnalyzerSchema, uniqueId, type CustomAnalyzer } from './definitions'
import type { Analyzer } from '../analyzers/types'
interface Props {
  draft: Settings
  onChange: (settings: Settings) => void
}
export function AnalyzerManager({ draft, onChange }: Props) {
  const registry = createAnalyzerRegistry(draft)
  const [editing, setEditing] = useState<CustomAnalyzer | null>(null)
  const [originalId, setOriginalId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copiedConfig, setCopiedConfig] = useState<Settings['analyzers'][string] | null>(null)
  const start = (definition: CustomAnalyzer, original: string | null = null) => {
    setEditing(structuredClone(definition))
    setOriginalId(original)
    setCopiedConfig(null)
    setError('')
  }
  const create = () =>
    start({
      id: uniqueId(
        'custom-reviewer',
        registry.map((a) => a.id),
      ),
      name: '',
      description: '',
      scope: 'document',
      instructions: '',
      enabled: true,
      severity: 'suggestion',
    })
  const duplicate = (analyzer: Analyzer) => {
    const definition = draft.customAnalyzers.find((a) => a.id === analyzer.id)
    start({
      id: uniqueId(
        'custom-reviewer',
        registry.map((a) => a.id),
      ),
      name: `${analyzer.name} copy`,
      description: analyzer.description,
      scope: analyzer.preferredScope,
      enabled: true,
      severity: definition?.severity ?? 'suggestion',
      instructions:
        definition?.instructions ??
        analyzer.instructions ??
        `Review this writing for ${analyzer.description}`,
    })
    setCopiedConfig(
      draft.analyzers[analyzer.id] ? { ...draft.analyzers[analyzer.id], enabled: true } : null,
    )
  }
  const save = () => {
    const parsed = customAnalyzerSchema.safeParse(editing)
    if (!parsed.success) {
      setError(
        'Enter a name, a lowercase unique ID, a supported scope, and 1–16,000 characters of instructions.',
      )
      return
    }
    if (registry.some((a) => a.id === parsed.data.id && a.id !== originalId)) {
      setError('That analyzer ID already exists.')
      return
    }
    if (!originalId && draft.customAnalyzers.length >= 40) {
      setError('The limit is 40 custom analyzers.')
      return
    }
    onChange({
      ...draft,
      analyzers: copiedConfig
        ? { ...draft.analyzers, [parsed.data.id]: copiedConfig }
        : draft.analyzers,
      customAnalyzers: [...draft.customAnalyzers.filter((a) => a.id !== originalId), parsed.data],
    })
    setEditing(null)
  }
  const remove = (id: string) => {
    const configs = { ...draft.analyzers }
    delete configs[id]
    onChange({
      ...draft,
      analyzers: configs,
      customAnalyzers: draft.customAnalyzers.filter((a) => a.id !== id),
      customProfiles: draft.customProfiles.map((p) => ({
        ...p,
        enabled: p.enabled.filter((a) => a !== id),
      })),
    })
    if (originalId === id) setEditing(null)
  }
  return (
    <div className="analyzer-manager">
      <p className="muted">
        Built-in prompts are read-only. Custom reviewers use the same exact-quote protocol and
        reviewed fixes. Run a custom reviewer individually, or include it in a custom profile for
        full-document analysis.
      </p>
      <button
        className="secondary-button"
        disabled={draft.customAnalyzers.length >= 40}
        onClick={create}
      >
        Create custom analyzer
      </button>
      {editing && (
        <section className="management-editor" aria-label="Custom analyzer editor">
          <h3>{originalId ? 'Edit custom analyzer' : 'New custom analyzer'}</h3>
          <label className="field">
            Analyzer ID
            <input
              value={editing.id}
              disabled={!!originalId}
              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
            />
          </label>
          <label className="field">
            Analyzer name
            <input
              value={editing.name}
              maxLength={100}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label className="field">
            Analyzer description
            <textarea
              value={editing.description}
              maxLength={1000}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </label>
          <label className="field">
            Analyzer scope
            <select
              value={editing.scope}
              onChange={(e) =>
                setEditing({ ...editing, scope: e.target.value as CustomAnalyzer['scope'] })
              }
            >
              <option value="paragraph">Paragraph</option>
              <option value="nearby">Paragraph + nearby context</option>
              <option value="selection">Selection only</option>
              <option value="document">Document</option>
            </select>
          </label>
          <label className="field">
            Instructions
            <textarea
              aria-label="Instructions"
              rows={8}
              maxLength={16000}
              value={editing.instructions}
              placeholder="Describe what to flag and when to return no findings. Draftbench supplies JSON and exact-quote instructions."
              onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
            />
          </label>
          <label className="field">
            Default severity
            <select
              value={editing.severity}
              onChange={(e) =>
                setEditing({ ...editing, severity: e.target.value as CustomAnalyzer['severity'] })
              }
            >
              {['info', 'suggestion', 'warning', 'error'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="management-actions">
            <button className="secondary-button" onClick={() => setEditing(null)}>
              Cancel analyzer edit
            </button>
            <button className="primary-button" onClick={save}>
              Keep analyzer changes
            </button>
          </div>
          <p className="muted">
            Then choose backend/model below and Save settings. IDs are stable after creation.
          </p>
        </section>
      )}
      {registry.map((analyzer) => {
        const custom = draft.customAnalyzers.find((a) => a.id === analyzer.id)
        const config = draft.analyzers[analyzer.id] ?? {
          enabled: custom?.enabled ?? analyzer.id !== 'harper',
          model: '',
        }
        const backendId = config.backend || draft.defaultBackend
        let model = ''
        try {
          model = backendConfig(draft, backendId).model
        } catch {
          /* Render a repairable missing override. */
        }
        const patch = (value: Partial<typeof config>) =>
          onChange({
            ...draft,
            analyzers: { ...draft.analyzers, [analyzer.id]: { ...config, ...value } },
          })
        return (
          <section
            className="analyzer-setting"
            key={analyzer.id}
            aria-label={`${analyzer.name} analyzer settings`}
          >
            <label>
              <input
                type="checkbox"
                checked={config.enabled && (custom?.enabled ?? true)}
                onChange={(e) => {
                  const next = {
                    ...draft,
                    analyzers: {
                      ...draft.analyzers,
                      [analyzer.id]: { ...config, enabled: e.target.checked },
                    },
                    customAnalyzers: draft.customAnalyzers.map((a) =>
                      a.id === analyzer.id ? { ...a, enabled: e.target.checked } : a,
                    ),
                  }
                  onChange(next)
                }}
              />
              <strong>{analyzer.name}</strong>
              <span className="ai-tag">{analyzer.engine === 'ai' ? 'AI' : 'LOCAL'}</span>
            </label>
            <p>{analyzer.description}</p>
            <small>
              {analyzer.origin === 'custom' ? 'Custom' : 'Built-in'} ·{' '}
              {analyzer.preferredScope === 'nearby'
                ? 'paragraph + context'
                : analyzer.preferredScope}
            </small>
            {analyzer.engine === 'ai' && (
              <>
                <label className="field small-field">
                  Backend
                  <select
                    aria-label="Backend"
                    value={config.backend ?? ''}
                    onChange={(e) => patch({ backend: e.target.value })}
                  >
                    <option value="">
                      Default ({draft.backends.find((b) => b.id === draft.defaultBackend)?.name})
                    </option>
                    {config.backend && !draft.backends.some((b) => b.id === config.backend) && (
                      <option value={config.backend}>Missing ({config.backend})</option>
                    )}
                    {draft.backends.map((b) => (
                      <option value={b.id} key={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field small-field">
                  Model override
                  <input
                    value={config.model}
                    placeholder={`Default · ${model}`}
                    onChange={(e) => patch({ model: e.target.value })}
                  />
                </label>
                <small>
                  Effective:{' '}
                  {draft.backends.find((b) => b.id === backendId)?.name ?? 'missing backend'} ·{' '}
                  {config.model.trim() || model || 'model required'}
                </small>
              </>
            )}
            <div className="management-actions">
              {custom && (
                <button className="text-button" onClick={() => start(custom, custom.id)}>
                  Edit {analyzer.name}
                </button>
              )}
              {analyzer.engine === 'ai' && (
                <button className="text-button" onClick={() => duplicate(analyzer)}>
                  Duplicate {analyzer.name}
                </button>
              )}
              {custom && (
                <button className="text-button" onClick={() => remove(analyzer.id)}>
                  Delete {analyzer.name}
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
