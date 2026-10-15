import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { applyFix } from '../editor/diagnostics'
import { ReviewEditHistory } from '../editor/reviewEdits'
import { analyzers, development, structure } from '../analyzers/registry'
import { clarity } from '../analyzers/llm/semantic'
import { runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { SavedReviews } from '../analyzers/savedReviews'
import { defaultSettings, effectiveConfig } from '../settings/model'
import { hash } from '../diagnostics/hash'
import { reconcileReviewContexts, reviewContextFor } from '../profiles/reviewContext'
import type { AIProvider } from '../ai/types'
import type { Analyzer } from '../analyzers/types'
import type { Diagnostic } from '../diagnostics/types'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))
const provider: AIProvider = {
  testConnection: vi.fn(),
  listModels: vi.fn(),
  completeStructured: vi.fn(async (request) => {
    const target = JSON.parse(request.user).targets[0]
    return {
      issues: ['Bad one.', 'Bad two.']
        .filter((quote) => target.text.includes(quote))
        .map((quote) => ({
          block_id: target.block_id,
          quote,
          category: 'review',
          severity: 'suggestion',
          message: 'Clarify this.',
          explanation: 'The reader cannot follow the point.',
          action: 'replace',
          replacement: quote.replace('Bad', 'Better'),
          guidance: null,
        })),
    }
  }),
}
async function review(analyzer: Analyzer = development, initialProfile = 'general') {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Markdown, BlockIdentity],
    content: 'Bad one. Bad two.',
    contentType: 'markdown',
  })
  ensureBlockIds(editor)
  editors.push(editor)
  const settings = defaultSettings(),
    cache = new AnalysisCache(),
    history = new ReviewEditHistory()
  let current = snapshot(editor, 'doc', 0),
    profile = initialProfile
  const run = () =>
    runAnalyzer(
      analyzer,
      current,
      'document',
      effectiveConfig(settings, analyzer.id),
      provider,
      new AbortController().signal,
      cache,
      false,
      undefined,
      settings.analysis,
      profile,
    )
  let findings = (await run()).findings
  editor.on('update', ({ transaction }) => {
    const next = snapshot(editor, 'doc', current.revision + 1)
    findings = reconcileReviewContexts(
      history.update(findings, current, next, transaction),
      analyzers,
      settings,
      profile,
      next,
    )
    current = next
  })
  return {
    editor,
    settings,
    cache,
    run,
    findings: () => findings,
    input: () => current,
    changeProfile: (next: string) => {
      profile = next
      findings = reconcileReviewContexts(findings, analyzers, settings, profile, current)
    },
    apply: () => applyFix(editor, findings[0], 'doc', current.revision),
    rerun: async () => {
      const result = await run()
      findings = result.findings
      return result
    },
    capture: (target: SavedReviews, values: Diagnostic[] = findings) =>
      target.capture(current, hash('disk'), hash('serialized'), profile, settings, values, [
        analyzer.id,
      ]),
    restore: (target: SavedReviews) =>
      target.restore(current, hash('disk'), hash('serialized'), profile, settings),
  }
}
describe('review context continuity', () => {
  it('keeps neutral reviews and clears disabled flags when their reviewer becomes enabled again', async () => {
    const state = await review(clarity)
    const ids = state.findings().map((f) => f.id)
    const dismissed = new Set(ids)
    state.settings.customProfiles.push({
      id: 'empty-profile',
      name: 'Empty',
      description: '',
      enabled: [],
    })
    state.changeProfile('empty-profile')
    expect(state.findings().every((f) => f.needsRerun === 'disabled')).toBe(true)
    state.changeProfile('technical')
    expect(state.findings().every((f) => !f.needsRerun)).toBe(true)
    expect(state.findings().map((f) => f.id)).toEqual(ids)
    expect(state.findings().every((f) => dismissed.has(f.id))).toBe(true)
    expect((await state.run()).cacheHits).toBe(1)
  })
  it('retains original genre context and restores compatibility when switching back', async () => {
    const state = await review(development, 'essay')
    const ids = state.findings().map((f) => f.id)
    state.changeProfile('general')
    expect(
      state
        .findings()
        .every((f) => f.needsRerun === 'genre' && f.reviewContext?.profile === 'essay'),
    ).toBe(true)
    state.changeProfile('email')
    expect(state.findings().every((f) => f.needsRerun === 'disabled')).toBe(true)
    state.changeProfile('essay')
    expect(state.findings().every((f) => !f.needsRerun)).toBe(true)
    expect(state.findings().map((f) => f.id)).toEqual(ids)
  })
  it('treats custom profiles with identical genre-neutral policies as compatible', async () => {
    const state = await review(development, 'custom-a')
    for (const id of ['custom-a', 'custom-b'])
      state.settings.customProfiles.push({
        id,
        name: id,
        description: '',
        enabled: ['development'],
      })
    state.changeProfile('custom-b')
    expect(state.findings().every((f) => !f.needsRerun)).toBe(true)
    expect((await state.run()).cacheHits).toBe(1)
    expect(reviewContextFor(development, 'custom-a').policyHash).toBe(
      reviewContextFor(development, 'custom-b').policyHash,
    )
  })
  it('reconciles both Undo and Redo against the current profile rather than old journal flags', async () => {
    const state = await review()
    expect(state.apply()).toBe(true)
    state.changeProfile('technical')
    expect(state.editor.commands.undo()).toBe(true)
    expect(state.findings()).toHaveLength(2)
    expect(state.findings().every((f) => f.needsRerun === 'genre')).toBe(true)
    const store = new SavedReviews(analyzers)
    expect(state.capture(store)).toBe(false)
    // A caller accidentally stripping UI flags still cannot mislabel old reviews.
    expect(
      state.capture(
        store,
        state.findings().map((f) => ({ ...f, needsRerun: undefined })),
      ),
    ).toBe(false)
    expect(state.editor.commands.redo()).toBe(true)
    expect(state.findings()).toHaveLength(1)
    expect(state.findings()[0].needsRerun).toBe('genre')
    expect(state.editor.commands.undo()).toBe(true)
    state.changeProfile('general')
    expect(state.findings().every((f) => !f.needsRerun)).toBe(true)
    expect(state.capture(store)).toBe(true)
    const imported = new SavedReviews(analyzers)
    imported.import(store.export())
    expect(
      state.restore(imported)?.findings.every((f) => f.reviewContext?.profile === 'general'),
    ).toBe(true)
  })
  it('fresh reruns clear genre flags and can be saved under their actual context', async () => {
    const state = await review(structure)
    state.changeProfile('technical')
    expect(state.findings()[0].needsRerun).toBe('genre')
    const result = await state.rerun()
    expect(result.cacheHits).toBe(0)
    expect(
      state.findings().every((f) => !f.needsRerun && f.reviewContext?.profile === 'technical'),
    ).toBe(true)
    const store = new SavedReviews(analyzers)
    expect(state.capture(store)).toBe(true)
    expect(state.restore(store)?.findings).toHaveLength(2)
  })
  it('rejects missing finding provenance and incompatible source policies, including zero findings', async () => {
    const state = await review()
    const store = new SavedReviews(analyzers)
    expect(
      state.capture(
        store,
        state.findings().map((f) => ({ ...f, reviewContext: undefined })),
      ),
    ).toBe(false)
    expect(state.capture(store, [])).toBe(true)
    const data = store.export() as { reviews: { sources: { policyHash?: string }[] }[] }
    data.reviews[0].sources[0].policyHash = hash('old policy')
    const imported = new SavedReviews(analyzers)
    imported.import(data)
    expect(state.restore(imported)).toBeNull()
    delete data.reviews[0].sources[0].policyHash
    const legacy = new SavedReviews(analyzers)
    legacy.import(data)
    expect(state.restore(legacy)).toBeNull()
  })
  it('ordinary edits preserve intact quotes as stale without clearing profile incompatibility', async () => {
    const state = await review()
    state.changeProfile('technical')
    state.editor.commands.insertContentAt(state.findings()[0].from, 'Changed ')
    expect(state.findings()).toHaveLength(2)
    expect(
      state.findings().every((finding) => finding.stale && finding.needsRerun === 'genre'),
    ).toBe(true)
  })
})
