import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Analyzer } from '../analyzers/types'
import type { Scope } from '../diagnostics/types'

interface Props {
  analyzers: Analyzer[]
  enabled: (id: string) => boolean
  globallyEnabled: (id: string) => boolean
  hasDocument: boolean
  busy: boolean
  onRun: (scope: Scope, reviewerIds: string[], force: boolean) => void
}

export function ReviewerRunMenu({
  analyzers,
  enabled,
  globallyEnabled,
  hasDocument,
  busy,
  onRun,
}: Props) {
  const menu = useRef<HTMLDetailsElement>(null)
  const menuId = useId()
  const [scope, setScope] = useState<Scope>('document')
  const [force, setForce] = useState(false)
  // Null means the profile defaults, until the author makes an explicit choice.
  // Keep preferences across documents/scopes; unavailable choices never run.
  const [choices, setChoices] = useState<Set<string> | null>(null)
  useEffect(() => {
    const known = new Set(analyzers.map((a) => a.id))
    setChoices((old) => {
      if (!old) return old
      const next = new Set([...old].filter((id) => known.has(id)))
      return next.size === old.size ? old : next
    })
  }, [analyzers])
  const chosen = choices ?? new Set(analyzers.filter((a) => enabled(a.id)).map((a) => a.id))
  const available = (a: Analyzer) =>
    (a.origin === 'custom' ? globallyEnabled(a.id) : enabled(a.id)) && a.scopes.includes(scope)
  const runnable = analyzers.filter(available)
  const selectedIds = runnable.filter((a) => chosen.has(a.id)).map((a) => a.id)
  const label = (a: Analyzer) =>
    analyzers.filter((other) => other.name === a.name).length > 1 ? `${a.name} (${a.id})` : a.name
  const reason = (a: Analyzer) => {
    if (!(a.origin === 'custom' ? globallyEnabled(a.id) : enabled(a.id))) return 'Disabled'
    if (a.scopes.includes(scope)) return ''
    if (a.scopes.length === 1 && a.scopes[0] === 'document') return 'Document only'
    if (a.scopes.length === 1 && a.scopes[0] === 'selection') return 'Selection only'
    return 'Unsupported scope'
  }
  // The component stays mounted when no document is open, preserving session choices.
  if (!hasDocument) return null
  return (
    <details
      ref={menu}
      className="action-menu upward reviewer-run-menu"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu.current?.open) {
          event.preventDefault()
          event.stopPropagation()
          menu.current.open = false
          menu.current.querySelector('summary')?.focus()
        }
      }}
    >
      <summary>
        <span>Run reviewers</span>
        <ChevronDown size={13} />
      </summary>
      <div>
        <label className="reviewer-run-scope">
          Review scope
          <select
            aria-label="Review scope"
            value={scope}
            disabled={busy}
            onChange={(event) => setScope(event.target.value as Scope)}
          >
            <option value="document">Entire document</option>
            <option value="selection">Selected text</option>
            <option value="block">Current paragraph</option>
          </select>
        </label>
        <div className="reviewer-run-shortcuts">
          <button
            type="button"
            disabled={busy || !runnable.length}
            onClick={() => setChoices(new Set(runnable.map((a) => a.id)))}
          >
            Select all
          </button>
          <button type="button" disabled={busy} onClick={() => setChoices(new Set())}>
            Clear
          </button>
        </div>
        <fieldset className="reviewer-run-list">
          <legend>Reviewers to run</legend>
          {analyzers.map((a) => (
            <label key={a.id} className="reviewer-run-choice" title={reason(a) || a.description}>
              <input
                type="checkbox"
                aria-label={label(a)}
                aria-describedby={reason(a) ? `${menuId}-${a.id}-reason` : undefined}
                checked={available(a) && chosen.has(a.id)}
                disabled={busy || !available(a)}
                onChange={(event) => {
                  const next = new Set(chosen)
                  if (event.target.checked) next.add(a.id)
                  else next.delete(a.id)
                  setChoices(next)
                }}
              />
              <span>{label(a)}</span>
              {reason(a) && <small id={`${menuId}-${a.id}-reason`}>{reason(a)}</small>}
            </label>
          ))}
        </fieldset>
        <label className="reviewer-run-force">
          <input
            type="checkbox"
            checked={force}
            disabled={busy}
            onChange={(event) => setForce(event.target.checked)}
          />
          Force rerun (bypass cache)
        </label>
        <button
          type="button"
          className="reviewer-run-submit"
          disabled={busy || !selectedIds.length}
          onClick={() => {
            if (menu.current) {
              menu.current.open = false
              menu.current.querySelector('summary')?.focus()
            }
            onRun(scope, selectedIds, force)
          }}
        >
          Run selected ({selectedIds.length})
        </button>
        <p className="reviewer-run-note">
          Checking boxes does not start analysis or change your profile.
        </p>
      </div>
    </details>
  )
}
