import type { Transaction } from '@tiptap/pm/state'
import type { Analyzer } from '../analyzers/types'
import { configurationHash, effectiveConfig, type Settings } from '../settings/model'
import { analyzerEnabled, globallyEnabled } from '../profiles/profiles'
import { refreshDiagnostic } from './mapping'
import { reconcileReviewContexts } from '../profiles/reviewContext'
import type { Diagnostic, Snapshot } from './types'

export interface ReferencePassage {
  id: string
  text: string
  type: string
  target: boolean
}
export interface RevisionReference {
  sessionToken: string
  finding: Diagnostic
  reviewFinding: Diagnostic
  reviewer: string
  capturedAt: number
  capturedHash: string
  targetHash: string
  passages: ReferencePassage[]
  latestFindings?: Diagnostic[]
  cleanReview?: {
    hash: string
    text: string
    at: number
    profile: string
    configurationHash: string
    analyzerVersion: string
  }
  /** A transaction-mapped location, never a search for another occurrence of the quote. */
  anchor: { from: number; to: number } | null
  /** Identity tracking for resuming a local warning, NEVER a Jump/Apply location. */
  trackingRange: { from: number; to: number } | null
}
export function captureRevisionReference(
  finding: Diagnostic,
  input: Snapshot,
  sessionToken: string,
  reviewer: string,
): RevisionReference | null {
  const fresh = refreshDiagnostic(finding, input)
  if (!fresh) return null
  const target = input.blocks.find((b) => b.id === fresh.blockId)!
  return {
    sessionToken,
    finding: {
      ...fresh,
      dependencies: { ...fresh.dependencies },
      engine: { ...fresh.engine },
      reviewContext: fresh.reviewContext ? { ...fresh.reviewContext } : undefined,
      replacements: fresh.replacements ? [...fresh.replacements] : undefined,
    },
    reviewFinding: {
      ...(fresh.reviewOrigin ?? fresh),
      dependencies: { ...(fresh.reviewOrigin ?? fresh).dependencies },
    },
    reviewer,
    capturedAt: Date.now(),
    capturedHash: input.hash,
    targetHash: target.hash,
    passages: input.blocks
      .filter(
        (b) =>
          Math.abs(b.order - target.order) <= 1 && (b.id === target.id || b.type !== 'codeBlock'),
      )
      .map((b) => ({ id: b.id, text: b.text, type: b.type, target: b.id === target.id })),
    anchor: { from: fresh.from, to: fresh.to },
    trackingRange: { from: fresh.from, to: fresh.to },
  }
}
export function mapRevisionReference(
  reference: RevisionReference,
  before: Snapshot | null,
  after: Snapshot,
  transaction: Transaction,
): RevisionReference {
  const target = after.blocks.find((b) => b.id === reference.finding.blockId)
  const trackedFrom = reference.trackingRange
    ? transaction.mapping.mapResult(reference.trackingRange.from, 1)
    : null
  const trackedTo = reference.trackingRange
    ? transaction.mapping.mapResult(reference.trackingRange.to, -1)
    : null
  const trackingRange =
    target &&
    trackedFrom &&
    trackedTo &&
    !(trackedFrom.deletedAcross && trackedTo.deletedAcross) &&
    trackedFrom.pos >= target.from &&
    trackedTo.pos <= target.to &&
    trackedFrom.pos < trackedTo.pos
      ? { from: trackedFrom.pos, to: trackedTo.pos }
      : null
  const source =
    reference.anchor ?? (before ? refreshDiagnostic(reference.reviewFinding, before) : null)
  if (!source) return { ...reference, trackingRange }
  // Bias the range so insertions at either edge stay outside the tracked quote.
  const from = transaction.mapping.mapResult(source.from, 1)
  const to = transaction.mapping.mapResult(source.to, -1)
  let anchor: RevisionReference['anchor'] = null
  if (
    target &&
    !(from.deletedAcross && to.deletedAcross) &&
    from.pos >= target.from &&
    to.pos <= target.to &&
    from.pos <= to.pos
  ) {
    // The mapped range must still contain exactly the quoted text; a partial or
    // shifted mapping is dropped, never guessed from another occurrence.
    const start = target.positions.indexOf(from.pos)
    const end = target.positions.indexOf(to.pos)
    if (start >= 0 && end > start && target.text.slice(start, end) === reference.finding.quote)
      anchor = { from: from.pos, to: to.pos }
  }
  // Missing/split/deleted targets must not jump to an unrelated identical sentence.
  // Rebinding an exact restored review after Undo is handled by referenceState.
  return { ...reference, anchor, trackingRange }
}

/** Resume the OLD capture, not the new detection. A regenerated local finding
 * must uniquely overlap the transaction-tracked original warning and have the
 * same rule feedback. Never search quotes or infer identity after deletion/split. */
export function canResumeRevisionReference(
  reference: RevisionReference,
  finding: Diagnostic,
  findings: Diagnostic[],
): boolean {
  const original = reference.finding
  if (finding.documentId !== original.documentId || finding.blockId !== original.blockId)
    return false
  if (finding.id === original.id) return true
  const range = reference.trackingRange
  if (!range || original.engine.kind !== 'deterministic') return false
  const matches = findings.filter(
    (candidate) =>
      candidate.engine.kind === 'deterministic' &&
      candidate.documentId === original.documentId &&
      candidate.blockId === original.blockId &&
      candidate.analyzerId === original.analyzerId &&
      candidate.analyzerVersion === original.analyzerVersion &&
      candidate.category === original.category &&
      candidate.message === original.message &&
      candidate.explanation === original.explanation &&
      candidate.action === original.action &&
      candidate.severity === original.severity &&
      candidate.from < range.to &&
      candidate.to > range.from,
  )
  return matches.length === 1 && matches[0].id === finding.id
}

export function referenceState(
  reference: RevisionReference,
  input: Snapshot | null,
  findings: Diagnostic[],
  dismissed: Set<string>,
  analyzers: Analyzer[],
  settings: Settings,
  profile: string,
) {
  const original = reference.finding
  const target = input?.blocks.find((b) => b.id === original.blockId)
  // The live finding (rebased across edits) is the current review's view of
  // this same finding. It is always mappable when present.
  const live = input
    ? reconcileReviewContexts(
        findings.filter((f) => f.id === original.id),
        analyzers,
        settings,
        profile,
        input,
      )[0]
    : undefined
  // The captured original must still match the live draft exactly: block hash,
  // quoted range, and every captured dependency. That is what makes its
  // replacement safe to apply.
  const exact = input ? refreshDiagnostic(reference.reviewFinding, input) : null
  const anchor =
    reference.anchor &&
    target &&
    reference.anchor.from >= target.from &&
    reference.anchor.to <= target.to &&
    target.text.slice(
      target.positions.indexOf(reference.anchor.from),
      target.positions.indexOf(reference.anchor.to),
    ) === original.quote
      ? reference.anchor
      : null
  // Recover only an exact captured review (e.g. Undo), never a searched quote.
  const location = anchor ?? (exact ? { from: exact.from, to: exact.to } : null)
  const quoteIntact = !!target && !!location
  const contextChanged = !!live?.contextChanged || (quoteIntact && !exact)
  const isDismissed = dismissed.has(original.id)
  const cleanReview = !!reference.cleanReview
  const analyzer = analyzers.find((item) => item.id === original.analyzerId)
  const cleanReviewCompatible =
    !!reference.cleanReview &&
    !!analyzer &&
    reference.cleanReview.profile === profile &&
    reference.cleanReview.analyzerVersion === analyzer.version &&
    reference.cleanReview.configurationHash ===
      configurationHash(effectiveConfig(settings, analyzer.id)) &&
    (analyzerEnabled(settings, analyzer.id, profile) ||
      (analyzer.origin === 'custom' && globallyEnabled(settings, analyzer.id)))
  const cleanReviewCurrent = cleanReviewCompatible && reference.cleanReview?.hash === input?.hash
  const canApply =
    !cleanReview &&
    !!live &&
    !!exact &&
    !live.stale &&
    !live.needsRerun &&
    !contextChanged &&
    !isDismissed
  const state = cleanReview
    ? cleanReviewCurrent
      ? 'No issues detected'
      : cleanReviewCompatible
        ? 'Edited since review'
        : 'Needs a fresh review'
    : isDismissed
      ? 'Dismissed'
      : !quoteIntact
        ? 'Edited since reference'
        : live?.needsRerun
          ? 'Needs a fresh review'
          : contextChanged
            ? 'Review context changed'
            : live
              ? 'Passage still matches'
              : exact
                ? 'Reference only'
                : 'Review context changed'
  return {
    state,
    cleanReview,
    cleanReviewCurrent,
    canApply,
    finding: live,
    location,
    // A surviving block can be explicitly reviewed even after its quote was edited.
    reviewLocation: target ? { from: target.from, to: target.to } : null,
    quoteIntact,
    contextChanged,
    draftChanged: !!input && input.hash !== reference.capturedHash,
  }
}
