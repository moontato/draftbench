import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { ReviewEditHistory } from '../editor/reviewEdits'
import { resolveIssue, refreshDiagnostic } from '../diagnostics/mapping'
import {
  captureRevisionReference,
  canResumeRevisionReference,
  mapRevisionReference,
  referenceState,
  type RevisionReference,
} from '../diagnostics/revisionReference'
import { configurationHash, defaultSettings, effectiveConfig } from '../settings/model'
import { clarity } from '../analyzers/llm/semantic'
import { analyzers, structure } from '../analyzers/registry'
import { harper } from '../analyzers/builtin/harper'
import type { Analyzer } from '../analyzers/types'
import type { Diagnostic } from '../diagnostics/types'

const settings = defaultSettings()
let editor: Editor
let history: ReviewEditHistory
let current: ReturnType<typeof snapshot>
let findings: Diagnostic[]
let beforeSnapshot: ReturnType<typeof snapshot> | null
let lastTransaction: import('@tiptap/pm/state').Transaction | null
afterEach(() => editor?.destroy())
function setup(content = 'Bad one. Bad two. Bad three.\n\nBad four.') {
  editor = new Editor({
    extensions: [StarterKit, Markdown, BlockIdentity],
    content,
    contentType: 'markdown',
  })
  ensureBlockIds(editor)
  history = new ReviewEditHistory()
  current = snapshot(editor, 'doc', 0)
  findings = []
  beforeSnapshot = null
  lastTransaction = null
  editor.on('update', ({ transaction }) => {
    beforeSnapshot = current
    lastTransaction = transaction
    current = snapshot(editor, 'doc', current.revision + 1)
    findings = history.update(findings, beforeSnapshot, current, transaction)
  })
}
function makeFinding(
  quote: string,
  analyzer: Analyzer = clarity,
  deps: Record<string, string>,
): Diagnostic {
  const block = current.blocks.find((b) => b.text.includes(quote))!
  const finding = resolveIssue(
    {
      block_id: block.id,
      quote,
      replacement: quote.replace('Bad', 'Fixed'),
      category: 'clarity',
      severity: 'suggestion',
      message: `Check ${quote}`,
      explanation: 'For testing.',
    },
    current,
    analyzer.id,
    analyzer.version,
    { kind: analyzer.engine, name: analyzer.name },
    configurationHash(effectiveConfig(settings, analyzer.id)),
    deps,
  )!
  findings.push(finding)
  return finding
}
function pin(finding: Diagnostic) {
  return captureRevisionReference(finding, current, 'token', finding.analyzerId)!
}
function apply(reference: RevisionReference, transaction: import('@tiptap/pm/state').Transaction) {
  editor.view.dispatch(transaction)
  return mapRevisionReference(reference, beforeSnapshot, current, lastTransaction!)
}
function view(reference: RevisionReference, findingsOverride?: Diagnostic[]) {
  return referenceState(
    reference,
    current,
    findingsOverride ?? findings,
    new Set<string>(),
    analyzers,
    settings,
    'general',
  )
}
it('captures the quoted passage, its context, and a live anchor', () => {
  setup()
  const finding = makeFinding('Bad one.', clarity, { $document: current.hash })
  const reference = pin(finding)
  expect(reference.passages.filter((p) => p.target)).toHaveLength(1)
  expect(reference.passages.find((p) => p.target)!.text).toBe('Bad one. Bad two. Bad three.')
  expect(reference.passages).toHaveLength(2)
  expect(reference.anchor).toEqual({ from: finding.from, to: finding.to })
  const live = view(reference)
  expect(live.state).toBe('Passage still matches')
  expect(live.canApply).toBe(true)
  expect(live.location).toEqual({ from: finding.from, to: finding.to })
})
it('refuses to capture a finding that no longer matches the draft', () => {
  setup()
  const finding = makeFinding('Bad one.', clarity, { $document: current.hash })
  editor.chain().setTextSelection(editor.state.doc.content.size).insertContent('x').run()
  expect(captureRevisionReference(finding, current, 'token', 'clarity')).toBeNull()
})
it('keeps the reference applicable when an unrelated paragraph changes', () => {
  setup()
  const block = current.blocks.find((b) => b.text.startsWith('Bad one'))!
  const finding = makeFinding('Bad one.', clarity, { [block.id]: block.hash })
  const reference = apply(
    pin(finding),
    editor.state.tr.insert(editor.state.doc.content.size, editor.schema.text(' More.')),
  )
  const live = view(reference)
  expect(live.state).toBe('Passage still matches')
  expect(live.canApply).toBe(true)
  expect(live.location).toEqual({ from: finding.from, to: finding.to })
})
it('blocks applying after nearby text changes, while keeping a mapped location', () => {
  setup()
  const finding = makeFinding('Bad four.', clarity, { $document: current.hash })
  const reference = apply(
    pin(finding),
    editor.state.tr.insert(editor.state.doc.content.size, editor.schema.text(' More.')),
  )
  expect(findings).toHaveLength(1)
  expect(findings[0].stale).toBe(true)
  const live = view(reference)
  expect(live.state).toBe('Review context changed')
  expect(live.canApply).toBe(false)
  expect(live.location).toEqual({ from: finding.from, to: finding.to })
})
it('tracks the quote when text is inserted before it in the same block', () => {
  setup()
  const block = current.blocks.find((b) => b.text === 'Bad four.')!
  const finding = makeFinding('Bad four.', clarity, { $document: current.hash })
  const reference = apply(
    pin(finding),
    editor.state.tr.insert(block.from, editor.schema.text('OK ')),
  )
  expect(reference.anchor).toEqual({ from: finding.from + 3, to: finding.to + 3 })
  const live = view(reference)
  expect(live.state).toBe('Review context changed')
  expect(live.canApply).toBe(false)
  expect(live.location).toEqual(reference.anchor)
})
it('reports the reference as edited when the quoted text changes', () => {
  setup()
  const finding = makeFinding('Bad four.', clarity, { $document: current.hash })
  const reference = apply(
    pin(finding),
    editor.state.tr.replaceWith(finding.from, finding.to, editor.schema.text('Worse four.')),
  )
  const live = view(reference)
  expect(live.state).toBe('Edited since reference')
  expect(live.canApply).toBe(false)
  expect(live.location).toBeNull()
  const target = current.blocks.find((block) => block.id === finding.blockId)!
  expect(live.reviewLocation).toEqual({ from: target.from, to: target.to })
})
it('recognizes a regenerated local warning without adopting its reviewed text or making it applicable', () => {
  setup()
  const original = makeFinding('Bad one.', harper, {
    [current.blocks[0].id]: current.blocks[0].hash,
  })
  const reference = apply(
    pin(original),
    editor.state.tr.replaceWith(original.from, original.to, editor.schema.text('Worse one.')),
  )
  const fresh = makeFinding('Worse one.', harper, {
    [current.blocks[0].id]: current.blocks[0].hash,
  })
  fresh.message = original.message
  expect(fresh.id).not.toBe(original.id)
  expect(canResumeRevisionReference(reference, fresh, findings)).toBe(true)
  expect(view(reference).state).toBe('Edited since reference')
  expect(view(reference).location).toBeNull()
  expect(view(reference).canApply).toBe(false)
  // Tracking keeps moving after the quote anchor is lost, including while hidden.
  const shifted = apply(
    reference,
    editor.state.tr.insert(current.blocks[0].from, editor.schema.text('Prefix. ')),
  )
  const mapped = findings.find((finding) => finding.id === fresh.id)!
  expect(canResumeRevisionReference(shifted, mapped, findings)).toBe(true)
  expect(view(shifted).location).toBeNull()
})
it('does not resume a different occurrence, an overlapping ambiguity or a different local rule', () => {
  setup()
  const original = makeFinding('Bad one.', harper, {
    [current.blocks[0].id]: current.blocks[0].hash,
  })
  const reference = apply(
    pin(original),
    editor.state.tr.replaceWith(original.from, original.to, editor.schema.text('Worse one.')),
  )
  const fresh = makeFinding('Worse one.', harper, {
    [current.blocks[0].id]: current.blocks[0].hash,
  })
  fresh.message = original.message
  const other = { ...fresh, id: 'other', from: fresh.to + 1, to: fresh.to + 8 }
  expect(canResumeRevisionReference(reference, other, [fresh, other])).toBe(false)
  expect(canResumeRevisionReference(reference, fresh, [fresh, { ...fresh, id: 'overlap' }])).toBe(
    false,
  )
  expect(
    canResumeRevisionReference(reference, { ...fresh, category: 'different-rule' }, [
      { ...fresh, category: 'different-rule' },
    ]),
  ).toBe(false)
})
it('does not correlate a new local occurrence after deleting or splitting the tracked passage', () => {
  setup('Bad one. End.')
  const original = makeFinding('Bad one.', harper, {
    [current.blocks[0].id]: current.blocks[0].hash,
  })
  let reference = apply(pin(original), editor.state.tr.delete(original.from, original.to))
  reference = apply(
    reference,
    editor.state.tr.insert(current.blocks[0].from, editor.schema.text('New Bad one. ')),
  )
  const fresh = makeFinding('Bad one.', harper, { [current.blocks[0].id]: current.blocks[0].hash })
  expect(reference.trackingRange).toBeNull()
  expect(canResumeRevisionReference(reference, fresh, findings)).toBe(false)
  expect(view(reference).location).toBeNull()
})
it('restores the analysis snapshot and applicability on exact Undo', () => {
  setup()
  const finding = makeFinding('Bad four.', clarity, { $document: current.hash })
  let reference = apply(
    pin(finding),
    editor.state.tr.replaceWith(finding.from, finding.to, editor.schema.text('Worse four.')),
  )
  expect(view(reference).state).toBe('Edited since reference')
  editor.commands.undo()
  reference = mapRevisionReference(reference, beforeSnapshot, current, lastTransaction!)
  expect(findings).toHaveLength(1)
  const live = view(reference)
  expect(live.state).toBe('Passage still matches')
  expect(live.canApply).toBe(true)
  expect(live.draftChanged).toBe(false)
})
it('allows applying again after a review rerun for the restored text', () => {
  setup()
  const finding = makeFinding('Bad four.', clarity, { $document: current.hash })
  const reference = pin(finding)
  editor.view.dispatch(
    editor.state.tr.replaceWith(finding.from, finding.to, editor.schema.text('Worse four.')),
  )
  editor.commands.undo()
  expect(findings).toHaveLength(1)
  const live = view(reference, [refreshDiagnostic(reference.finding, current)!])
  expect(live.state).toBe('Passage still matches')
  expect(live.canApply).toBe(true)
})
it('does not rebind a split block to its sibling, even with an identical quote', () => {
  setup('Bad one. Bad two.\n\nBad four.')
  const finding = makeFinding('Bad two.', clarity, { $document: current.hash })
  const reference = pin(finding)
  editor.chain().setTextSelection(finding.from).splitBlock().run()
  const block = current.blocks.find((b) => b.id === finding.blockId)!
  expect(block.text.trim()).toBe('Bad one.')
  const live = view(reference)
  expect(live.state).toBe('Edited since reference')
  expect(live.canApply).toBe(false)
  expect(live.location).toBeNull()
})
it('drops ambiguous quote matches instead of guessing an occurrence', () => {
  setup('Bad two. End.')
  const finding = makeFinding('Bad two.', clarity, { $document: current.hash })
  const block = current.blocks[0]
  let reference = apply(pin(finding), editor.state.tr.delete(finding.from, finding.to))
  reference = apply(
    reference,
    editor.state.tr.insert(block.from, editor.schema.text('Bad two. Bad two. ')),
  )
  const live = view(reference)
  expect(live.state).toBe('Edited since reference')
  expect(live.canApply).toBe(false)
  expect(live.location).toBeNull()
})
it('never jumps to a unique replacement occurrence after deleting the tracked quote', () => {
  setup('Bad two. End.')
  const finding = makeFinding('Bad two.', clarity, { $document: current.hash })
  const block = current.blocks[0]
  let reference = apply(pin(finding), editor.state.tr.delete(finding.from, finding.to))
  reference = apply(
    reference,
    editor.state.tr.insert(block.from, editor.schema.text('New Bad two. ')),
  )
  expect(view(reference).location).toBeNull()
  expect(view(reference).state).toBe('Edited since reference')
  expect(view(reference).canApply).toBe(false)
})
it('marks a dismissed reference', () => {
  setup()
  const finding = makeFinding('Bad one.', clarity, { $document: current.hash })
  const live = referenceState(
    pin(finding),
    current,
    findings,
    new Set([finding.id]),
    analyzers,
    settings,
    'general',
  )
  expect(live.state).toBe('Dismissed')
  expect(live.canApply).toBe(false)
})
it('flags a profile mismatch as needing a fresh review', () => {
  setup()
  const finding = makeFinding('Bad one.', structure, { $document: current.hash })
  const live = referenceState(
    pin(finding),
    current,
    findings,
    new Set<string>(),
    analyzers,
    settings,
    'email',
  )
  expect(live.state).toBe('Needs a fresh review')
  expect(live.canApply).toBe(false)
})
it('reports reference-only when a rerun replaced the finding on unchanged text', () => {
  setup()
  const finding = makeFinding('Bad one.', clarity, { $document: current.hash })
  const live = view(pin(finding), [])
  expect(live.state).toBe('Reference only')
  expect(live.canApply).toBe(false)
})
