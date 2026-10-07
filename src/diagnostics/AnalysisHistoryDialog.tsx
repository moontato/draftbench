import { History, X } from 'lucide-react'
import type { AnalysisRun } from '../analyzers/history'
import { profiles } from '../profiles/profiles'
import { Modal } from '../ui/Modal'

const statusLabels: Record<string, string> = {
  running: 'Running',
  pending: 'Not started',
  completed: 'Completed',
  warnings: 'Completed with warnings',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Not run',
  stale: 'Stale results discarded',
  interrupted: 'Interrupted',
  saved: 'Recovered saved review',
}
const scopeLabels = { document: 'Document', selection: 'Selection', block: 'Current paragraph' }
export function AnalysisHistoryDialog({
  runs,
  documentName,
  currentHash,
  onClose,
}: {
  runs: AnalysisRun[]
  documentName: string
  currentHash?: string
  onClose: () => void
}) {
  return (
    <Modal onEscape={onClose}>
      <section
        className="history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        aria-describedby="history-description"
      >
        <header>
          <div>
            <span className="eyebrow">{documentName}</span>
            <h2 id="history-title">
              <History size={20} /> Analysis history
            </h2>
          </div>
          <button className="icon-button" aria-label="Close analysis history" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p id="history-description">
          Manual runs and recovered saved reviews for this document, newest first. Opening history
          does not restore or apply old suggestions. Automatic local checks are not logged.
        </p>
        <div className="history-scroll" tabIndex={0} aria-label="Analysis run history">
          {!runs.length ? (
            <p className="history-empty">
              No run history is available yet. Older request caches can contain suggestions without
              the metadata needed to reconstruct past runs. New manual analyses are recorded here.
            </p>
          ) : (
            <ol className="history-list">
              {runs.map((run) => (
                <li key={run.id} className="history-run">
                  <div className="history-run-heading">
                    <time dateTime={new Date(run.startedAt).toISOString()}>
                      {new Date(run.startedAt).toLocaleString()}
                    </time>
                    <span className={`history-outcome history-${run.status}`}>
                      {statusLabels[run.status]}
                    </span>
                  </div>
                  <p className="history-summary">
                    {scopeLabels[run.scope]} · {profiles[run.profile].name} ·{' '}
                    {run.reviewers.reduce((n, r) => n + r.findings, 0)}{' '}
                    {run.origin === 'saved-review' ? 'saved findings' : 'findings'}
                    {run.force ? ' · Force rerun' : ''}
                    {run.parallelJobs !== undefined
                      ? run.parallelJobs === 1
                        ? ' · Sequential'
                        : ` · Up to ${run.parallelJobs} parallel AI jobs`
                      : ''}
                    {run.finishedAt !== null
                      ? ` · ${Math.max(0, (run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
                      : ''}
                  </p>
                  {run.inputBudgets && (
                    <p className="history-input-budgets">
                      Input budgets: {run.inputBudgets.paragraphInputChars.toLocaleString()}{' '}
                      paragraph/context · {run.inputBudgets.documentInputChars.toLocaleString()}{' '}
                      document characters
                    </p>
                  )}
                  {run.origin === 'saved-review' && (
                    <p className="history-recovery-note">
                      Recovered from the last saved review, not a complete log of earlier runs. Its
                      timestamp and findings were saved; original model settings, request counts,
                      duration, and force-rerun status were not recorded.
                    </p>
                  )}
                  {currentHash && currentHash !== run.documentHash && (
                    <p className="history-version">Earlier document version</p>
                  )}
                  <ul className="history-reviewers">
                    {run.reviewers.map((reviewer) => (
                      <li key={reviewer.id}>
                        <div>
                          <strong>{reviewer.name}</strong>
                          <span>
                            {reviewer.status === 'saved' ? 'Saved' : statusLabels[reviewer.status]}{' '}
                            · {reviewer.findings} findings
                          </span>
                        </div>
                        <p>
                          {reviewer.engine === 'ai'
                            ? `Model: ${reviewer.model || 'not recorded'}`
                            : reviewer.engine === 'deterministic'
                              ? 'Local rules'
                              : 'Engine not recorded'}{' '}
                          · analyzer v{reviewer.version}
                        </p>
                        {reviewer.server && <p className="history-endpoint">{reviewer.server}</p>}
                        {['completed', 'warnings', 'stale'].includes(reviewer.status) ? (
                          <p>
                            {reviewer.cacheHits} cache hits · {reviewer.requests}{' '}
                            {reviewer.engine === 'ai' ? 'review requests' : 'local checks'}
                            {reviewer.warnings ? ` · ${reviewer.warnings} warnings` : ''}
                            {reviewer.discarded
                              ? ` · ${reviewer.discarded} stale findings discarded`
                              : ''}
                          </p>
                        ) : ['failed', 'cancelled', 'interrupted'].includes(reviewer.status) ? (
                          <p>Request counts unavailable for this incomplete review.</p>
                        ) : null}
                        {reviewer.options && (
                          <p>
                            {reviewer.options.maxTokens.toLocaleString()} output tokens ·{' '}
                            {reviewer.options.timeoutMs / 1000}s timeout · temperature{' '}
                            {reviewer.options.temperature}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
        <footer>
          <span>Bounded local history. Settings → Clear analysis cache also removes this log.</span>
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </Modal>
  )
}
