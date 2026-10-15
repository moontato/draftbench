import { useId, useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { diffWords } from 'diff'
import type { Diagnostic, Scope } from './types'
import { hasDistinctExplanation } from './feedbackText'
import type { RevisionReference, referenceState } from './revisionReference'
import type { useRevisionLayout } from './useRevisionLayout'

interface Props {
  reference: RevisionReference
  view: ReturnType<typeof referenceState>
  layout: ReturnType<typeof useRevisionLayout>
  canApply: boolean
  canReview: boolean
  busy: boolean
  status: string
  scope: Scope | null
  onClose: () => void
  onChoose: () => void
  onJump: () => void
  onApply: (alternative: number) => void
  onDismiss: () => void
  onReview: () => void
  onSelectFinding: (finding: Diagnostic) => void
}
export function RevisionPane({
  reference,
  view,
  layout,
  canApply,
  canReview,
  busy,
  status,
  scope,
  onClose,
  onChoose,
  onJump,
  onApply,
  onDismiss,
  onReview,
  onSelectFinding,
}: Props) {
  const finding = reference.finding
  const variants = finding.replacements?.length
    ? finding.replacements
    : finding.replacement !== undefined
      ? [finding.replacement]
      : []
  const [alternative, setAlternative] = useState(() =>
    Math.max(0, variants.indexOf(finding.replacement ?? variants[0])),
  )
  const [collapsed, setCollapsed] = useState(false)
  const hidden = collapsed && layout.compact
  const bodyId = useId()
  const target = reference.passages.find((p) => p.target)
  const context = reference.passages.filter((p) => !p.target)
  const replacement = variants[alternative]
  return (
    <aside
      className={`revision-pane ${hidden ? 'revision-collapsed' : ''}`}
      aria-label="Revision reference"
      style={layout.compact ? { height: hidden ? 54 : layout.height } : undefined}
    >
      {layout.compact && !hidden && (
        <div className="inspector-resize revision-resize" {...layout.separatorProps}>
          <span />
        </div>
      )}
      <header className="revision-heading">
        <h2>
          {layout.compact ? (
            <button
              className="text-button revision-toggle"
              aria-expanded={!hidden}
              aria-controls={bodyId}
              aria-label={hidden ? 'Expand revision reference' : 'Collapse revision reference'}
              onClick={() => setCollapsed((old) => !old)}
            >
              {hidden ? <ChevronRight size={15} /> : <ChevronDown size={15} />}Revision reference
            </button>
          ) : (
            'Revision reference'
          )}
        </h2>
        <button
          className="icon-button"
          aria-label="Close revision reference"
          title="Return to the normal writing layout"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div id={bodyId} className="revision-content" hidden={hidden}>
        <p className="revision-capture">
          Read-only · Captured at{' '}
          <time
            dateTime={new Date(reference.cleanReview?.at ?? reference.capturedAt).toISOString()}
          >
            {new Date(reference.cleanReview?.at ?? reference.capturedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </p>
        <span
          className={`revision-state ${view.state === 'Passage still matches' ? 'revision-state-current' : 'revision-state-stale'}`}
          role="status"
        >
          {view.state}
        </span>
        {(busy || status) && (
          <p className="revision-run-status" role="status">
            {busy && <span className="spinner" />} {status || 'Reviewing…'}
          </p>
        )}
        {reference.latestFindings && reference.latestFindings.length > 1 && (
          <label className="field">
            Findings from latest review ({reference.latestFindings.length})
            <select
              value={finding.id}
              disabled={view.draftChanged}
              onChange={(event) => {
                const chosen = reference.latestFindings?.find(
                  (item) => item.id === event.target.value,
                )
                if (chosen) onSelectFinding(chosen)
              }}
            >
              {reference.latestFindings.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.message}
                </option>
              ))}
            </select>
          </label>
        )}
        {view.cleanReview && (
          <>
            <p className="revision-explanation">
              {view.cleanReviewCurrent
                ? `No issues detected by ${reference.reviewer} in this review. This is not confirmation that every concern is fixed.`
                : 'The draft, reviewer settings, or profile changed after the latest review. Re-review to check the current wording.'}
            </p>
            <span className="eyebrow">LATEST REVIEWED TEXT</span>
            <div className="revision-passage">{reference.cleanReview?.text}</div>
          </>
        )}
        {!view.cleanReview && !view.quoteIntact && (
          <p className="revision-note">
            The passage has changed or been removed. Keep this feedback as a reference; re-review to
            check the new wording. Editing is not confirmation that the concern is fixed.
          </p>
        )}
        {!view.cleanReview && view.contextChanged && (
          <p className="revision-note">
            The review context has changed. This captured advice stays visible, but its replacement
            cannot be applied from this reference.
          </p>
        )}
        {!view.cleanReview && view.quoteIntact && !view.contextChanged && view.draftChanged && (
          <p className="revision-note">
            Other draft text has changed since capture. This reference does not update as you type.
          </p>
        )}
        {!view.cleanReview && view.state === 'Reference only' && (
          <p className="revision-note">
            This finding is no longer in the current results. Choose a current finding or explicitly
            re-review; the old feedback is not automatically replaced.
          </p>
        )}
        {!view.cleanReview && view.finding?.needsRerun && (
          <p className="revision-note">
            The reviewer, its settings, or writing profile no longer matches this review. Re-review
            before using its replacement.
          </p>
        )}
        {!view.cleanReview && (
          <>
            <span className="eyebrow">REFERENCE PASSAGE</span>
            {target && (
              <div className="revision-passage">
                {target.text.slice(0, finding.start)}
                <mark className="revision-quote">
                  {target.text.slice(finding.start, finding.end)}
                </mark>
                {target.text.slice(finding.end)}
              </div>
            )}
            {!!context.length && (
              <details className="revision-context">
                <summary>
                  <ChevronRight size={12} aria-hidden="true" />
                  Surrounding context at capture
                </summary>
                {reference.passages.map((p) => (
                  <p key={p.id} className={p.target ? 'revision-context-target' : ''}>
                    {p.text}
                  </p>
                ))}
              </details>
            )}
            <span className="eyebrow">
              {reference.reviewer.toUpperCase()} · {finding.severity.toUpperCase()}
            </span>
            <h3 className="revision-message">{finding.message}</h3>
            {hasDistinctExplanation(finding.message, finding.explanation) && (
              <p className="revision-explanation">{finding.explanation}</p>
            )}
            {finding.action === 'replace' && replacement !== undefined && (
              <>
                {variants.length > 1 && (
                  <label className="field">
                    Suggested replacement
                    <select
                      value={alternative}
                      onChange={(event) => setAlternative(Number(event.target.value))}
                    >
                      {variants.map((value, index) => (
                        <option key={index} value={index}>
                          {value || 'Remove quoted text'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <span className="eyebrow">SUGGESTED CHANGE · CAPTURED REVIEW</span>
                <div className="replacement-review">
                  {diffWords(finding.quote, replacement).map((part, index) =>
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
            {finding.action !== 'replace' && finding.guidance && (
              <>
                <span className="eyebrow">
                  {finding.action === 'question' ? 'A QUESTION FOR YOU' : 'REVISION GUIDANCE'}
                </span>
                <div className="source-review">{finding.guidance}</div>
              </>
            )}
            <details className="revision-provenance">
              <summary>
                <ChevronRight size={12} aria-hidden="true" />
                Reviewer & original review context
              </summary>
              <p>
                {finding.engine.name}
                {finding.engine.model ? ` · ${finding.engine.model}` : ''}
              </p>
              {finding.reviewContext && (
                <p>Originally reviewed for: {finding.reviewContext.profile}</p>
              )}
              <p>Reviewer version: {finding.analyzerVersion}</p>
            </details>
          </>
        )}
      </div>
      <footer className="revision-actions" hidden={hidden}>
        <button className="text-button" disabled={!view.location} onClick={onJump}>
          Jump to draft <ArrowUpRight size={13} />
        </button>
        <button className="text-button" onClick={onChoose}>
          Choose another finding
        </button>
        <div className="fix-actions">
          {!view.cleanReview && finding.action === 'replace' && replacement !== undefined && (
            <button
              className="primary-button"
              disabled={!canApply || !view.canApply}
              onClick={() => onApply(alternative)}
            >
              <Check size={14} />
              Apply suggestion
            </button>
          )}
          {!view.cleanReview && (
            <button
              className="secondary-button"
              disabled={view.state === 'Dismissed'}
              onClick={onDismiss}
            >
              Dismiss finding
            </button>
          )}
          <button
            className="secondary-button"
            disabled={!canReview}
            onClick={onReview}
            title={
              finding.engine.kind === 'ai'
                ? `Request fresh feedback from ${reference.reviewer}, bypassing the request cache`
                : `Run ${reference.reviewer} locally; no AI server request is made`
            }
          >
            {scope === 'document'
              ? 'Re-review document'
              : scope === 'selection'
                ? 'Re-review selected text'
                : 'Re-review paragraph'}
          </button>
        </div>
      </footer>
    </aside>
  )
}
