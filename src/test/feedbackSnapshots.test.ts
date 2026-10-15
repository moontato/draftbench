import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { ReviewEditHistory } from '../editor/reviewEdits'
import { FeedbackSnapshots } from '../analyzers/feedbackSnapshots'
import { analyzers } from '../analyzers/registry'
import { resolveIssue } from '../diagnostics/mapping'
import { hash } from '../diagnostics/hash'
import { defaultSettings, effectiveConfig, configurationHash } from '../settings/model'
import { reconcileReviewContexts } from '../profiles/reviewContext'
import { applyFix } from '../editor/diagnostics'
import { captureRevisionReference, referenceState } from '../diagnostics/revisionReference'
import type { Diagnostic, Snapshot } from '../diagnostics/types'

const settings = defaultSettings()
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))
function open(text: string) {
  const editor = new Editor({
    extensions: [StarterKit, Markdown, BlockIdentity],
    content: text,
    contentType: 'markdown',
  })
  ensureBlockIds(editor)
  editors.push(editor)
  return editor
}
function setup(text = 'Bad one. Bad two.\n\nOther paragraph.', documentScope = true) {
  const editor = open(text)
  let input = snapshot(editor, 'doc', 0)
  const analyzer = analyzers.find((analyzer) => analyzer.id === 'clarity')!
  let findings = ['Bad one.', 'Bad two.'].map((quote) => {
    const block = input.blocks.find((block) => block.text.includes(quote))!
    return resolveIssue(
      {
        block_id: block.id,
        quote,
        message: 'Explain this.',
        explanation: 'Add details.',
        replacement: quote.replace('Bad', 'Better'),
        severity: 'suggestion',
        category: 'clarity',
      },
      input,
      analyzer.id,
      analyzer.version,
      { kind: 'ai', name: 'Original reviewer', model: 'original-model' },
      configurationHash(effectiveConfig(settings, analyzer.id)),
      documentScope ? { $document: input.hash } : { [block.id]: block.hash },
    )!
  })
  const history = new ReviewEditHistory()
  editor.on('update', ({ transaction }) => {
    const after = snapshot(editor, 'doc', input.revision + 1)
    findings = history.update(findings, input, after, transaction)
    input = after
  })
  return { editor, input: () => input, findings: () => findings }
}
function roundTrip(input: Snapshot, findings: Diagnostic[], text: string) {
  const store = new FeedbackSnapshots()
  expect(store.capture(input, hash(text), hash(text), findings)).toBe(true)
  const encoded = JSON.stringify(store.export())
  expect(encoded).not.toContain('"from":')
  expect(encoded).not.toContain('"to":')
  for (const block of input.blocks) expect(encoded).not.toContain(block.id)
  const imported = new FeedbackSnapshots()
  imported.import(JSON.parse(encoded))
  const editor = open(text)
  const current = snapshot(editor, 'doc', 0)
  const restored = imported.restore(
    current,
    hash(text),
    hash(text),
    analyzers,
    settings,
    'general',
  )!
  expect(restored).not.toBeNull()
  return { imported, editor, current, restored }
}
it('persists mapped previous feedback after edits/save and rebinds exact locations on restart', () => {
  const state = setup()
  const originHash = state.input().hash
  const first = state.findings()[0]
  state.editor.commands.insertContentAt({ from: first.from, to: first.to }, 'New prose.')
  expect(state.findings()).toHaveLength(1)
  const text = state.editor.getMarkdown()
  const { restored, current, editor } = roundTrip(state.input(), state.findings(), text)
  expect(restored[0].quote).toBe('Bad two.')
  expect(restored[0].blockId).toBe(current.blocks[0].id)
  expect(restored[0].stale).toBe(true)
  expect(restored[0].reviewOrigin?.contentHash).toBe(originHash)
  expect(applyFix(editor, restored[0], 'doc', 0)).toBe(false)
  const pin = captureRevisionReference(restored[0], current, 'session', 'Clarity')!
  expect(
    referenceState(pin, current, restored, new Set(), analyzers, settings, 'general').canApply,
  ).toBe(false)
})
it('keeps unaffected feedback applicable after an unrelated edit and restart', () => {
  const state = setup(undefined, false)
  state.editor.commands.insertContentAt(state.input().blocks[1].to, ' Extra.')
  const { restored, editor } = roundTrip(
    state.input(),
    state.findings(),
    state.editor.getMarkdown(),
  )
  expect(restored.every((finding) => !finding.stale && !finding.needsRerun)).toBe(true)
  expect(applyFix(editor, restored[0], 'doc', 0)).toBe(true)
})
it('retains original model provenance and flags changed settings instead of dropping feedback', () => {
  const state = setup()
  const { imported, current, restored } = roundTrip(
    state.input(),
    state.findings(),
    state.editor.getMarkdown(),
  )
  const changed = structuredClone(settings)
  changed.ai.model = 'new-model'
  const text = state.editor.getMarkdown()
  const incompatible = imported.restore(
    current,
    hash(text),
    hash(text),
    analyzers,
    changed,
    'general',
  )!
  expect(incompatible).toHaveLength(2)
  expect(incompatible.every((finding) => finding.needsRerun === 'reviewer')).toBe(true)
  expect(incompatible[0].engine.model).toBe(restored[0].engine.model)
  expect(incompatible[0].configurationHash).toBe(restored[0].configurationHash)
})
it('preserves input-budget compatibility across restoration, edits and another save', () => {
  const state = setup(undefined, false)
  const text = state.editor.getMarkdown()
  const { imported, current, editor } = roundTrip(state.input(), state.findings(), text)
  const changed = structuredClone(settings)
  changed.analysis.paragraphInputChars++
  const restored = imported.restore(current, hash(text), hash(text), analyzers, changed, 'general')!
  expect(restored.every((finding) => finding.needsRerun === 'reviewer')).toBe(true)
  editor.commands.insertContentAt(current.blocks[1].to, ' Extra.')
  const after = snapshot(editor, 'doc', 1)
  const mapped = reconcileReviewContexts(restored, analyzers, changed, 'general', after)
  expect(mapped.every((finding) => finding.needsRerun === 'reviewer')).toBe(true)
  const savedAgain = new FeedbackSnapshots()
  const serialized = editor.getMarkdown()
  expect(
    savedAgain.capture(after, hash(serialized), hash(serialized), mapped, changed.analysis),
  ).toBe(true)
  const reopened = savedAgain.restore(
    after,
    hash(serialized),
    hash(serialized),
    analyzers,
    changed,
    'general',
  )!
  expect(reopened.every((finding) => finding.needsRerun === 'reviewer')).toBe(true)
  expect(reopened[0].reviewInputBudgets).toEqual({
    paragraphInputChars: settings.analysis.paragraphInputChars,
    documentInputChars: settings.analysis.documentInputChars,
  })
  expect(applyFix(editor, reopened[0], 'doc', 1)).toBe(false)
})
it('retains disabled/profile-incompatible feedback as non-applicable previous review', () => {
  const state = setup()
  const text = state.editor.getMarkdown()
  const { imported, current, editor } = roundTrip(state.input(), state.findings(), text)
  const disabled = structuredClone(settings)
  disabled.analyzers.clarity.enabled = false
  const restored = imported.restore(
    current,
    hash(text),
    hash(text),
    analyzers,
    disabled,
    'general',
  )!
  expect(restored).toHaveLength(2)
  expect(restored[0].needsRerun).toBe('disabled')
  expect(applyFix(editor, restored[0], 'doc', 0)).toBe(false)
  const profiles = structuredClone(settings)
  profiles.customProfiles.push({
    id: 'local-only',
    name: 'Local only',
    description: '',
    enabled: [],
  })
  const excluded = imported.restore(
    current,
    hash(text),
    hash(text),
    analyzers,
    profiles,
    'local-only',
  )!
  expect(excluded.every((finding) => finding.needsRerun === 'disabled')).toBe(true)
  expect(
    imported
      .restore(current, hash(text), hash(text), analyzers, profiles, 'general')!
      .every((finding) => !finding.needsRerun),
  ).toBe(true)
})
it('refuses external changes, a different disk/serialization or document identity without quote searching', () => {
  const state = setup()
  const text = state.editor.getMarkdown()
  const { imported, current } = roundTrip(state.input(), state.findings(), text)
  expect(
    imported.restore(current, hash(text + '\n'), hash(text), analyzers, settings, 'general'),
  ).toBeNull()
  expect(
    imported.restore(
      current,
      hash(text),
      hash('other serialization'),
      analyzers,
      settings,
      'general',
    ),
  ).toBeNull()
  expect(
    imported.restore(
      { ...current, documentId: 'copy' },
      hash(text),
      hash(text),
      analyzers,
      settings,
      'general',
    ),
  ).toBeNull()
  const changed = snapshot(open('New location.\n\n' + text), 'doc', 0)
  expect(
    imported.restore(changed, hash(text), hash(text), analyzers, settings, 'general'),
  ).toBeNull()
})
it('honors an empty saved-feedback snapshot instead of resurrecting an older review', () => {
  const state = setup()
  const store = new FeedbackSnapshots()
  const text = state.editor.getMarkdown()
  expect(store.capture(state.input(), hash(text), hash(text), state.findings())).toBe(true)
  expect(store.capture(state.input(), hash(text), hash(text), [])).toBe(true)
  expect(
    store.restore(state.input(), hash(text), hash(text), analyzers, settings, 'general'),
  ).toEqual([])
})
it('rejects corrupt offsets rather than selecting another identical occurrence', () => {
  const state = setup()
  const text = state.editor.getMarkdown()
  const { imported, current } = roundTrip(state.input(), state.findings(), text)
  const data = imported.export() as { documents: { findings: { location: { start: number } }[] }[] }
  data.documents[0].findings[0].location.start = 999
  const corrupt = new FeedbackSnapshots()
  corrupt.import(data)
  expect(
    corrupt.restore(current, hash(text), hash(text), analyzers, settings, 'general'),
  ).toBeNull()
  expect(() => corrupt.import({ version: 999, documents: [] })).toThrow('corrupt')
})
