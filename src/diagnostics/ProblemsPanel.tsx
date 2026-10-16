import { useEffect, useId, useMemo, useState } from 'react'
import { diffWords } from 'diff'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  History,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { Diagnostic, Severity } from './types'
import type { Analyzer } from '../analyzers/types'
import { useReviewResize } from './useReviewResize'
import { hasDistinctExplanation } from './feedbackText'
import { clearFindingFilters, countHiddenFindings, type FindingFilters } from './filters'
interface Props {
  findings: Diagnostic[]
  /** Findings the current filters leave visible, shared with the editor underlines. */
  visible: Diagnostic[]
  filters: FindingFilters
  onFilters: (patch: Partial<FindingFilters>) => void
  hidden?: boolean
  selected: string | null
  dismissed: Set<string>
  analyzers: Analyzer[]
  busy: boolean
  status: string
  hasDocument: boolean
  canApply: boolean
  onSelect: (finding: Diagnostic) => void
  onRevise?: (finding: Diagnostic) => void
  reviseAsNew?: boolean
  onApply: (finding: Diagnostic) => void
  onDismiss: (id: string) => void
  onResetDismissed: () => void
  onRun: (analyzerId?: string) => void
  onSettings: () => void
  onHistory: () => void
}
const severityOrder: Record<Severity, number> = { error: 0, warning: 1, suggestion: 2, info: 3 }
export function ProblemsPanel(props: Props) {
  const [group, setGroup] = useState('analyzer')
  const [engineOpen, setEngineOpen] = useState(false)
  const [alternative, setAlternative] = useState(0)
  useEffect(() => setAlternative(0), [props.selected])
  const [collapsed, setCollapsed] = useState(false)
  const reviewId = useId()
  const { areaRef, height, separatorProps } = useReviewResize()
  useEffect(() => {
    setCollapsed(false)
  }, [props.selected])
  const analyzerLabel = (analyzer: Analyzer) =>
    props.analyzers.filter((a) => a.name === analyzer.name).length > 1
      ? `${analyzer.name} (${analyzer.id})`
      : analyzer.name
  const visible = props.visible,
    hiddenByFilters = countHiddenFindings(props.findings, props.dismissed, visible)
  const groups = useMemo(() => {
    const result = new Map<string, Diagnostic[]>()
    for (const finding of [...visible].sort((a, b) =>
      group === 'severity'
        ? severityOrder[a.severity] - severityOrder[b.severity]
        : a.from - b.from,
    )) {
      const key =
        group === 'analyzer'
          ? finding.analyzerId
          : group === 'severity'
            ? finding.severity
            : `Passage ${finding.blockIndex + 1}`
      const list = result.get(key)
      if (list) list.push(finding)
      else result.set(key, [finding])
    }
    return [...result].map(([key, findings]) => {
      const analyzer = group === 'analyzer' ? props.analyzers.find((a) => a.id === key) : undefined
      return { key, findings, label: analyzer ? analyzerLabel(analyzer) : key }
    })
  }, [visible, group, props.analyzers])
  const original = props.findings.find((f) => f.id === props.selected)
  const chosen = original?.replacements?.length
    ? { ...original, replacement: original.replacements[alternative] ?? original.replacements[0] }
    : original
  return (
    <aside className="analysis-pane" aria-label="Document analysis" hidden={props.hidden}>
      <div className="pane-heading">
        <div>
          <span className="eyebrow">REVIEW YOUR WRITING</span>
          <h2>
            Analysis{' '}
            <span className="count-pill">
              {props.findings.filter((f) => !props.dismissed.has(f.id)).length}
            </span>
          </h2>
        </div>
        <div className="analysis-heading-actions">
          <button
            className="icon-button"
            onClick={props.onHistory}
            disabled={!props.hasDocument}
            title="Analysis history"
            aria-label="Analysis history"
          >
            <History size={17} />
          </button>
          <button
            className="icon-button"
            onClick={props.onSettings}
            title="Configure analyzers"
            aria-label="Configure analyzers"
          >
            <SlidersHorizontal size={17} />
          </button>
        </div>
      </div>
      <div className="analysis-controls">
        <select
          aria-label="Filter by analyzer"
          value={props.filters.analyzer}
          onChange={(e) => props.onFilters({ analyzer: e.target.value })}
        >
          <option value="all">All analyzers</option>
          {props.analyzers.map((a) => (
            <option key={a.id} value={a.id}>
              {analyzerLabel(a)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by severity"
          value={props.filters.severity}
          onChange={(e) => props.onFilters({ severity: e.target.value })}
        >
          <option value="all">All severities</option>
          {Object.keys(severityOrder).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Group findings"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="analyzer">Group by analyzer</option>
          <option value="severity">Group by severity</option>
          <option value="location">Group by location</option>
        </select>
        <select
          aria-label="Filter by category"
          value={props.filters.category}
          onChange={(e) => props.onFilters({ category: e.target.value })}
        >
          <option value="all">All categories</option>
          {[...new Set(props.findings.map((f) => f.category))].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="analysis-status" role="status">
        {props.busy && <span className="spinner" />}
        {props.status || 'Ready when you are.'}
        {hiddenByFilters > 0 && (
          <button
            className="text-button filter-hint"
            onClick={() => props.onFilters(clearFindingFilters)}
            title="Clear these filters and underline every finding again"
          >
            {hiddenByFilters} hidden by filters · Show all
          </button>
        )}
      </div>
      <div className="analysis-review-area" ref={areaRef}>
        <div className="findings-scroll">
          {!visible.length && (
            <div className="analysis-empty">
              <div className="empty-symbol">
                <CircleCheck size={28} strokeWidth={1.4} />
              </div>
              <h3>{props.findings.length ? 'Nothing in this view' : 'A second pair of eyes'}</h3>
              <p>
                {props.findings.length
                  ? 'Adjust your filters or show dismissed findings. The editor underlines follow this view.'
                  : 'Analyze your draft for meaningful problems. You decide what to change.'}
              </p>
              <button
                className="text-button"
                disabled={!props.hasDocument || props.busy}
                onClick={() =>
                  props.onRun(props.filters.analyzer === 'all' ? undefined : props.filters.analyzer)
                }
              >
                Analyze document <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {groups.map(({ key, label, findings }) => (
            <section className="finding-group" key={key}>
              <h3>
                {label}
                <span>{findings.length}</span>
              </h3>
              {findings.map((f) => (
                <button
                  key={f.id}
                  aria-pressed={props.selected === f.id}
                  className={`finding-card ${props.selected === f.id ? 'selected' : ''} ${props.dismissed.has(f.id) ? 'dismissed' : ''}`}
                  onClick={() => {
                    setCollapsed(false)
                    props.onSelect(f)
                  }}
                >
                  <span className={`severity-label ${f.severity}`}>
                    <span className="severity-dot" />
                    {f.severity}
                    {f.engine.kind === 'ai' && <span className="ai-tag">AI</span>}
                  </span>
                  {f.contextChanged && (
                    <span className="finding-link">
                      {f.stale
                        ? 'Previous review · re-review before applying'
                        : 'Context changed · review carefully'}
                    </span>
                  )}
                  {f.needsRerun && (
                    <span className="finding-link">
                      {f.needsRerun === 'genre'
                        ? 'Needs a rerun for this profile'
                        : f.needsRerun === 'disabled'
                          ? 'Reviewer disabled in this profile'
                          : 'Reviewer settings changed · rerun'}
                    </span>
                  )}
                  <span className="finding-message">{f.message}</span>
                  <span className="finding-quote">
                    “{f.quote.length > 100 ? f.quote.slice(0, 100) + '…' : f.quote}”
                  </span>
                  <span className="finding-link">
                    Inspect passage <ChevronRight size={12} />
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
        {chosen && (
          <section
            className={`fix-inspector ${collapsed ? 'collapsed' : ''}`}
            aria-label="Review finding"
            style={collapsed ? undefined : { height }}
          >
            {!collapsed && (
              <div className="inspector-resize" {...separatorProps}>
                <span />
              </div>
            )}
            <div className="inspector-heading">
              <h3>
                <button
                  className="text-button inspector-toggle"
                  onClick={() => setCollapsed((old) => !old)}
                  aria-expanded={!collapsed}
                  aria-controls={reviewId}
                  aria-label={collapsed ? 'Expand review finding' : 'Collapse review finding'}
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />} Review
                  finding
                </button>
              </h3>
              <div className="inspector-heading-actions">
                {props.onRevise && (
                  <button
                    className="text-button"
                    disabled={!props.canApply}
                    onClick={() => props.onRevise?.(chosen)}
                    title={
                      props.reviseAsNew
                        ? 'Replace the retained reference with a new capture of this finding'
                        : 'Open the captured passage and feedback without resetting an existing reference'
                    }
                  >
                    {props.reviseAsNew ? 'New reference' : 'Revise'}
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => props.onSelect(chosen)}
                  title="Jump to source"
                >
                  Jump <ArrowUpRight size={13} />
                </button>
              </div>
            </div>
            <div className="inspector-body" id={reviewId} hidden={collapsed}>
              {chosen.contextChanged && (
                <p role="note">
                  The analysis context changed. The quoted text is unchanged, but this is
                  previous-review feedback. Re-review for advice on the current draft.
                </p>
              )}
              {chosen.needsRerun && (
                <p role="note">
                  {chosen.needsRerun === 'genre'
                    ? 'This finding’s review context does not match the current writing profile. The quoted text is unchanged; rerun this reviewer for the current genre guidance.'
                    : chosen.needsRerun === 'disabled'
                      ? 'This reviewer is not enabled in the current profile. This previous-review finding remains visible; dismiss it, or enable the reviewer and rerun it. Returning to a compatible profile restores its current status.'
                      : 'This finding was made with a different reviewer version or inference settings. Rerun this reviewer to refresh it before relying on the advice.'}
                  {chosen.reviewContext && (
                    <> Originally reviewed for: {chosen.reviewContext.profile}.</>
                  )}
                </p>
              )}
              {hasDistinctExplanation(chosen.message, chosen.explanation) && (
                <p>{chosen.explanation}</p>
              )}
              {chosen.replacements && chosen.replacements.length > 1 && (
                <label className="field">
                  Suggested replacement
                  <select
                    value={alternative}
                    onChange={(e) => setAlternative(Number(e.target.value))}
                  >
                    {chosen.replacements.map((replacement, index) => (
                      <option key={index} value={index}>
                        {replacement || 'Remove quoted text'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {chosen.replacement !== undefined && (
                <>
                  <span className="eyebrow">ORIGINAL</span>
                  <div className="source-review">{chosen.quote}</div>
                  <span className="eyebrow">SUGGESTED CHANGE</span>
                  <div className="replacement-review">
                    {diffWords(chosen.quote, chosen.replacement).map((part, index) =>
                      part.removed ? (
                        <del key={index}>{part.value}</del>
                      ) : part.added ? (
                        <ins key={index}>{part.value}</ins>
                      ) : (
                        <span key={index}>{part.value}</span>
                      ),
                    )}
                  </div>
                </>
              )}
              {chosen.action !== 'replace' && chosen.guidance && (
                <>
                  <span className="eyebrow">
                    {chosen.action === 'question' ? 'A QUESTION FOR YOU' : 'REVISION GUIDANCE'}
                  </span>
                  <div className="source-review">{chosen.guidance}</div>
                </>
              )}
              <button
                className="engine-toggle text-button"
                aria-expanded={engineOpen}
                onClick={() => setEngineOpen(!engineOpen)}
              >
                Analyzer & engine <ChevronDown size={13} />
              </button>
              {engineOpen && (
                <dl className="engine-details">
                  <dt>Analyzer</dt>
                  <dd>
                    {props.analyzers.find((a) => a.id === chosen.analyzerId)?.name} ·{' '}
                    {chosen.analyzerVersion}
                  </dd>
                  {chosen.reviewContext && (
                    <>
                      <dt>Review profile</dt>
                      <dd>{chosen.reviewContext.profile}</dd>
                    </>
                  )}
                  <dt>Engine</dt>
                  <dd>{chosen.engine.name}</dd>
                  {chosen.engine.backend && (
                    <>
                      <dt>Backend</dt>
                      <dd>{chosen.engine.backend}</dd>
                    </>
                  )}
                  {chosen.engine.model && (
                    <>
                      <dt>Model</dt>
                      <dd>{chosen.engine.model}</dd>
                      <dt>Server</dt>
                      <dd>{chosen.engine.server}</dd>
                    </>
                  )}
                  {chosen.confidence !== undefined && (
                    <>
                      <dt>Confidence</dt>
                      <dd>
                        {Math.round(chosen.confidence * 100)}% (
                        {chosen.engine.kind === 'ai'
                          ? 'model estimate'
                          : 'deterministic rule match'}
                        )
                      </dd>
                    </>
                  )}
                </dl>
              )}
              <div className="fix-actions">
                {chosen.replacement !== undefined && (
                  <button
                    className="primary-button"
                    disabled={!props.canApply || !!chosen.stale || !!chosen.needsRerun}
                    title={
                      chosen.stale || chosen.needsRerun
                        ? 'Re-review this passage with compatible reviewer settings before applying'
                        : undefined
                    }
                    onClick={() => props.onApply(chosen)}
                  >
                    <Check size={14} />
                    Apply suggestion
                  </button>
                )}
                <button className="secondary-button" onClick={() => props.onDismiss(chosen.id)}>
                  <X size={14} />
                  Dismiss
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
      <div className="analysis-footer">
        <label>
          <input
            type="checkbox"
            checked={props.filters.showDismissed}
            onChange={(e) => props.onFilters({ showDismissed: e.target.checked })}
          />{' '}
          Show dismissed
        </label>
        {props.dismissed.size > 0 && (
          <button className="text-button" onClick={props.onResetDismissed}>
            Reset
          </button>
        )}
        <span>You're the author.</span>
      </div>
    </aside>
  )
}
