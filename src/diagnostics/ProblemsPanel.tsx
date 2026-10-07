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
interface Props {
  findings: Diagnostic[]
  selected: string | null
  dismissed: Set<string>
  analyzers: Analyzer[]
  busy: boolean
  status: string
  hasDocument: boolean
  canApply: boolean
  onSelect: (finding: Diagnostic) => void
  onApply: (finding: Diagnostic) => void
  onDismiss: (id: string) => void
  onResetDismissed: () => void
  onRun: (analyzerId?: string) => void
  onSettings: () => void
  onHistory: () => void
}
const severityOrder: Record<Severity, number> = { error: 0, warning: 1, suggestion: 2, info: 3 }
export function ProblemsPanel(props: Props) {
  const [filter, setFilter] = useState('all'),
    [severity, setSeverity] = useState('all'),
    [category, setCategory] = useState('all'),
    [group, setGroup] = useState('analyzer'),
    [showDismissed, setShowDismissed] = useState(false)
  const [engineOpen, setEngineOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const reviewId = useId()
  const { areaRef, height, separatorProps } = useReviewResize()
  useEffect(() => {
    setCollapsed(false)
  }, [props.selected])
  const visible = props.findings.filter(
    (f) =>
      (showDismissed || !props.dismissed.has(f.id)) &&
      (filter === 'all' || f.analyzerId === filter) &&
      (severity === 'all' || f.severity === severity) &&
      (category === 'all' || f.category === category),
  )
  const groups = useMemo(() => {
    const result = new Map<string, Diagnostic[]>()
    for (const finding of [...visible].sort((a, b) =>
      group === 'severity'
        ? severityOrder[a.severity] - severityOrder[b.severity]
        : a.from - b.from,
    )) {
      const key =
        group === 'analyzer'
          ? (props.analyzers.find((a) => a.id === finding.analyzerId)?.name ?? finding.analyzerId)
          : group === 'severity'
            ? finding.severity
            : `Passage ${finding.blockIndex + 1}`
      result.set(key, [...(result.get(key) ?? []), finding])
    }
    return [...result]
  }, [visible, group, props.analyzers])
  const chosen = props.findings.find((f) => f.id === props.selected)
  return (
    <aside className="analysis-pane" aria-label="Document analysis">
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
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All analyzers</option>
          {props.analyzers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
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
          value={category}
          onChange={(e) => setCategory(e.target.value)}
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
                  ? 'Adjust your filters or show dismissed findings.'
                  : 'Analyze your draft for meaningful problems. You decide what to change.'}
              </p>
              <button
                className="text-button"
                disabled={!props.hasDocument || props.busy}
                onClick={() => props.onRun()}
              >
                Analyze document <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {groups.map(([label, findings]) => (
            <section className="finding-group" key={label}>
              <h3>
                {label}
                <span>{findings.length}</span>
              </h3>
              {findings.map((f) => (
                <button
                  key={f.id}
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
              <button
                className="text-button"
                onClick={() => props.onSelect(chosen)}
                title="Jump to source"
              >
                Jump <ArrowUpRight size={13} />
              </button>
            </div>
            <div className="inspector-body" id={reviewId} hidden={collapsed}>
              <p>{chosen.explanation}</p>
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
              <button
                className="engine-toggle text-button"
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
                  <dt>Engine</dt>
                  <dd>{chosen.engine.name}</dd>
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
                        {chosen.engine.kind === 'ai' ? 'model estimate' : 'rule confidence'})
                      </dd>
                    </>
                  )}
                </dl>
              )}
              <div className="fix-actions">
                {chosen.replacement !== undefined && (
                  <button
                    className="primary-button"
                    disabled={!props.canApply}
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
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
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
