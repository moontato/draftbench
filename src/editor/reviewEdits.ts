import type { Transaction } from '@tiptap/pm/state'
import { isHistoryTransaction } from '@tiptap/pm/history'
import { hash } from '../diagnostics/hash'
import { refreshDiagnostic } from '../diagnostics/mapping'
import type { Diagnostic, Snapshot } from '../diagnostics/types'
import { appliedSuggestionMeta } from './diagnostics'

interface ReviewHistoryEntry {
  documentId: string
  beforeHash: string
  afterHash: string
  beforeFindings: Diagnostic[]
  afterFindings: Diagnostic[]
}

/** Session-local review snapshots for the editor's apply/undo/redo history. */
export class ReviewEditHistory {
  private entries: ReviewHistoryEntry[] = []
  private recorded = new WeakSet<Transaction>()

  update(
    findings: Diagnostic[],
    before: Snapshot | null,
    after: Snapshot,
    transaction: Transaction,
  ): Diagnostic[] {
    if (before && isHistoryTransaction(transaction)) {
      // Restore review snapshots on real Undo/Redo, including grouped typing
      // transactions. Ordinary edits that recreate text never resurrect removed quotes.
      // Newest matching snapshots win after a history branch.
      const entry = [...this.entries]
        .reverse()
        .find(
          (item) =>
            item.documentId === after.documentId &&
            (item.beforeHash === after.hash || item.afterHash === after.hash),
        )
      if (entry) {
        const restored =
          after.hash === entry.beforeHash ? entry.beforeFindings : entry.afterFindings
        // Keep genuinely unaffected new reviews, but do not carry stale feedback
        // from the state being left into a restored snapshot.
        const refreshed = updateReviewAfterEdit(findings, before, after, transaction).filter(
          (finding) => !finding.stale && !finding.contextChanged,
        )
        const merged = new Map(refreshed.map((finding) => [finding.id, finding]))
        for (const finding of restored) {
          const fresh = refreshDiagnostic(finding, after)
          if (fresh) merged.set(fresh.id, fresh)
        }
        return this.remember(findings, before, after, transaction, [...merged.values()])
      }
    }
    const next = updateReviewAfterEdit(findings, before, after, transaction)
    return this.remember(findings, before, after, transaction, next)
  }

  private remember(
    findings: Diagnostic[],
    before: Snapshot | null,
    after: Snapshot,
    transaction: Transaction,
    next: Diagnostic[],
  ): Diagnostic[] {
    // Also remember the state being left by Undo/Redo: a fresh analysis may have
    // happened since the original edit, and Redo must restore that newer review.
    if (before && !this.recorded.has(transaction)) {
      // React may replay a state updater. Record each transaction only once.
      this.recorded.add(transaction)
      this.entries.push({
        documentId: after.documentId,
        beforeHash: before.hash,
        afterHash: after.hash,
        beforeFindings: [...findings],
        afterFindings: next,
      })
      if (this.entries.length > 100) this.entries.shift()
    }
    return next
  }
}

// Preserve still-intact quotes through transaction mapping. Manual context changes
// retain feedback as stale, never as applicable advice. Late AI results remain strict.
export function updateReviewAfterEdit(
  findings: Diagnostic[],
  before: Snapshot | null,
  after: Snapshot,
  transaction: Transaction,
): Diagnostic[] {
  const appliedId = transaction.getMeta(appliedSuggestionMeta) as string | undefined
  return findings.flatMap((finding) => {
    if (!before) {
      const fresh = refreshDiagnostic(finding, after)
      return fresh ? [fresh] : []
    }
    if (finding.id === appliedId) return []
    const original = refreshDiagnostic(finding, before)
    if (!original) return []
    let from = original.from
    let to = original.to
    // Reject overlap even when the replacement happens to contain the old quote.
    for (const map of transaction.mapping.maps) {
      let overlaps = false
      map.forEach((start, end) => {
        if (start < to && end > from) overlaps = true
        if (start === end && start > from && start < to) overlaps = true
      })
      if (overlaps) return []
      from = map.map(from, 1)
      to = map.map(to, -1)
    }
    const block = after.blocks.find((b) => b.id === finding.blockId)
    if (!block) return []
    const start = block.positions.indexOf(from)
    const end = block.positions.indexOf(to)
    if (start < 0 || end <= start || block.text.slice(start, end) !== finding.quote) return []
    const dependencies: Record<string, string> = {}
    for (const key of Object.keys(finding.dependencies)) {
      if (key === '$document') dependencies[key] = after.hash
      else if (key.startsWith('$neighbors:')) {
        const target = after.blocks.find((b) => b.id === key.slice('$neighbors:'.length))
        if (!target) continue
        dependencies[key] = hash(
          JSON.stringify(
            after.blocks
              .filter((b) => Math.abs(b.order - target.order) === 1)
              .map((b) => [b.id, b.hash]),
          ),
        )
      } else {
        const dependency = after.blocks.find((b) => b.id === key)
        if (!dependency) continue
        dependencies[key] = dependency.hash
      }
    }
    const reviewOrigin = finding.reviewOrigin ?? finding
    const originalContextMatches = !!refreshDiagnostic(reviewOrigin, after)
    return [
      {
        ...finding,
        reviewOrigin,
        from,
        to,
        start,
        end,
        blockIndex: block.order,
        blockHash: block.hash,
        contentHash: after.hash,
        revision: after.revision,
        dependencies,
        contextChanged: !originalContextMatches,
        stale: !originalContextMatches && (finding.stale || !appliedId),
      },
    ]
  })
}
