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
      // Match both sides of the exact history transition, never an ordinary edit
      // that happens to produce the same text. Newest matches win after branching.
      const entry = [...this.entries]
        .reverse()
        .find(
          (item) =>
            item.documentId === after.documentId &&
            ((item.beforeHash === before.hash && item.afterHash === after.hash) ||
              (item.afterHash === before.hash && item.beforeHash === after.hash)),
        )
      if (entry) {
        const restored =
          after.hash === entry.beforeHash ? entry.beforeFindings : entry.afterFindings
        const refreshed = updateReviewAfterEdit(findings, before, after, transaction)
        const merged = new Map(refreshed.map((finding) => [finding.id, finding]))
        for (const finding of restored) {
          const fresh = refreshDiagnostic(finding, after)
          if (fresh) merged.set(fresh.id, fresh)
        }
        return [...merged.values()]
      }
    }
    const next = updateReviewAfterEdit(findings, before, after, transaction)
    if (before && transaction.getMeta(appliedSuggestionMeta) && !this.recorded.has(transaction)) {
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

// Only reviewed replacements may rebase a review. Ordinary typing still uses strict
// invalidation, and late analysis results must never be rebased onto different text.
export function updateReviewAfterEdit(
  findings: Diagnostic[],
  before: Snapshot | null,
  after: Snapshot,
  transaction: Transaction,
): Diagnostic[] {
  const appliedId = transaction.getMeta(appliedSuggestionMeta) as string | undefined
  return findings.flatMap((finding) => {
    if (!appliedId || !before) {
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
        if (!target) return []
        dependencies[key] = hash(
          JSON.stringify(
            after.blocks
              .filter((b) => Math.abs(b.order - target.order) === 1)
              .map((b) => [b.id, b.hash]),
          ),
        )
      } else {
        const dependency = after.blocks.find((b) => b.id === key)
        if (!dependency) return []
        dependencies[key] = dependency.hash
      }
    }
    return [
      {
        ...finding,
        from,
        to,
        start,
        end,
        blockIndex: block.order,
        blockHash: block.hash,
        contentHash: after.hash,
        revision: after.revision,
        dependencies,
        contextChanged: finding.contextChanged || !refreshDiagnostic(finding, after),
      },
    ]
  })
}
