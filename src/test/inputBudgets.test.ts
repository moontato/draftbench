import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INPUT_BUDGETS,
  INPUT_BUDGET_LIMITS,
  defaultSettings,
  effectiveConfig,
  settingsSchema,
  type InputBudgets,
} from '../settings/model'
import { runAnalyzer } from '../analyzers/runner'
import { analyzers, ambiguousReference, redundancy, structure } from '../analyzers/registry'
import { clarity } from '../analyzers/llm/semantic'
import { AnalysisCache } from '../analyzers/cache'
import { SavedReviews } from '../analyzers/savedReviews'
import { AnalysisHistory } from '../analyzers/history'
import type { AIProvider } from '../ai/types'
import type { Analyzer } from '../analyzers/types'
import type { Snapshot } from '../diagnostics/types'
import { hash } from '../diagnostics/hash'

function snapshot(texts: string[]): Snapshot {
  let position = 1
  return {
    documentId: 'doc',
    revision: 0,
    hash: hash(texts.join('\n\n')),
    blocks: texts.map((text, order) => {
      const from = position
      position += text.length + 2
      return {
        id: `b${order}`,
        text,
        type: 'paragraph',
        hash: hash(text),
        from,
        to: from + text.length,
        order,
        positions: Array.from({ length: text.length + 1 }, (_, i) => from + i),
      }
    }),
  }
}
function provider(): AIProvider {
  return {
    testConnection: vi.fn(),
    listModels: vi.fn(),
    completeStructured: vi.fn(async () => ({ issues: [] })),
  }
}
function run(
  analyzer: Analyzer,
  input: Snapshot,
  mock: AIProvider,
  budgets: InputBudgets,
  cache = new AnalysisCache(),
  force = false,
) {
  return runAnalyzer(
    analyzer,
    input,
    'document',
    defaultSettings().ai,
    mock,
    new AbortController().signal,
    cache,
    force,
    undefined,
    budgets,
  )
}

describe('configurable input budgets', () => {
  it('migrates both old settings and parallel-only settings with unchanged defaults', () => {
    for (const raw of [{ version: 1 }, { version: 1, analysis: { parallelJobs: 3 } }]) {
      const settings = settingsSchema.parse(raw)
      expect(settings.analysis.paragraphInputChars).toBe(12000)
      expect(settings.analysis.documentInputChars).toBe(48000)
      expect(settings.ai.maxTokens).toBe(2048)
    }
    const settings = settingsSchema.parse({
      analysis: { paragraphInputChars: 100000, documentInputChars: 1000 },
    })
    expect(settings.analysis).toMatchObject({
      paragraphInputChars: 100000,
      documentInputChars: 1000,
    })
  })
  it('validates independent integer character budgets with a generous bounded range', () => {
    for (const field of ['paragraphInputChars', 'documentInputChars']) {
      for (const value of [999, 1_000_001, 12000.5, '12000', NaN, Infinity, null])
        expect(settingsSchema.safeParse({ analysis: { [field]: value } }).success).toBe(false)
      for (const value of [INPUT_BUDGET_LIMITS.min, INPUT_BUDGET_LIMITS.max])
        expect(
          settingsSchema.parse({ analysis: { [field]: value } }).analysis[
            field as keyof InputBudgets
          ],
        ).toBe(value)
    }
  })
  it('accepts exact paragraph and document boundaries, then skips oversized units without inference', async () => {
    const budgets = { paragraphInputChars: 1000, documentInputChars: 2000 }
    for (const [analyzer, size] of [
      [clarity, 1000],
      [redundancy, 2000],
      [structure, 2000],
    ] as const) {
      const mock = provider()
      expect((await run(analyzer, snapshot(['A'.repeat(size)]), mock, budgets)).requests).toBe(1)
      const blocked = await run(analyzer, snapshot(['A'.repeat(size + 1)]), mock, budgets)
      expect(blocked.requests).toBe(0)
      expect(blocked.warnings[0]).toContain((size + 1).toLocaleString('en-US'))
      expect(blocked.warnings[0]).toContain(size.toLocaleString('en-US'))
      expect(blocked.warnings[0]).toContain('Settings → Analysis')
      expect(blocked.warnings[0]).toContain('No text was truncated')
      expect(mock.completeStructured).toHaveBeenCalledTimes(1)
    }
  })
  it('counts neighboring context and document code context, not just target prose', async () => {
    const mock = provider(),
      budgets = { paragraphInputChars: 1000, documentInputChars: 1000 }
    const input = snapshot(['A'.repeat(900), 'B'.repeat(200)])
    expect((await run(clarity, input, mock, budgets)).requests).toBe(2)
    expect((await run(ambiguousReference, input, mock, budgets)).requests).toBe(0)
    input.blocks[1].type = 'codeBlock'
    expect((await run(structure, input, mock, budgets)).requests).toBe(0)
    expect(mock.completeStructured).toHaveBeenCalledTimes(2)
  })
  it('sends the entire oversized paragraph/document when its configured budget permits it', async () => {
    const text = 'A'.repeat(60000),
      input = snapshot([text]),
      mock = provider()
    const budgets = { paragraphInputChars: 80000, documentInputChars: 120000 }
    for (const analyzer of [clarity, redundancy, structure]) {
      expect((await run(analyzer, input, mock, DEFAULT_INPUT_BUDGETS)).requests).toBe(0)
      expect((await run(analyzer, input, mock, budgets)).requests).toBe(1)
    }
    for (const [request] of vi.mocked(mock.completeStructured).mock.calls)
      expect(JSON.parse(request.user).targets[0].text).toBe(text)
  })
  it('enforces lowered budgets before cache lookup while retaining eligible exact-input cache entries', async () => {
    const mock = provider(),
      cache = new AnalysisCache(),
      input = snapshot(['A'.repeat(2000)])
    const high = { paragraphInputChars: 3000, documentInputChars: 3000 }
    const low = { ...high, paragraphInputChars: 1000 }
    expect((await run(clarity, input, mock, high, cache)).requests).toBe(1)
    expect((await run(clarity, input, mock, low, cache)).warnings).toHaveLength(1)
    expect((await run(clarity, input, mock, high, cache)).cacheHits).toBe(1)
    expect(mock.completeStructured).toHaveBeenCalledTimes(1)
    await run(clarity, input, mock, high, cache, true)
    expect(mock.completeStructured).toHaveBeenCalledTimes(2)
    const settings = defaultSettings(),
      before = effectiveConfig(settings, clarity.id)
    settings.analysis.paragraphInputChars = 100000
    expect(effectiveConfig(settings, clarity.id)).toEqual(before)
  })
  it('never limits deterministic local checks', async () => {
    const mock = provider(),
      local = analyzers.find((a) => a.engine === 'deterministic')!
    const result = await run(local, snapshot(['A'.repeat(60000)]), mock, {
      paragraphInputChars: 1000,
      documentInputChars: 1000,
    })
    expect(result.warnings).toEqual([])
    expect(mock.completeStructured).not.toHaveBeenCalled()
    const settings = defaultSettings(),
      store = new SavedReviews(analyzers),
      input = snapshot(['A passage.'])
    expect(
      store.capture(
        input,
        hash('markdown'),
        hash('serialization'),
        'general',
        settings,
        [],
        [local.id],
      ),
    ).toBe(true)
    settings.analysis.paragraphInputChars = 1000
    settings.analysis.documentInputChars = 1000
    expect(
      store.restore(input, hash('markdown'), hash('serialization'), 'general', settings),
    ).not.toBeNull()
  })
  it('matches saved-review budgets conservatively while preserving legacy-default and parallel-only restoration', () => {
    const settings = defaultSettings(),
      store = new SavedReviews(analyzers),
      input = snapshot(['A passage.'])
    const capture = () =>
      store.capture(
        input,
        hash('markdown'),
        hash('serialization'),
        'general',
        settings,
        [],
        ['clarity'],
      )
    const restore = (target = store) =>
      target.restore(input, hash('markdown'), hash('serialization'), 'general', settings)
    expect(capture()).toBe(true)
    expect(restore()).not.toBeNull()
    const legacyData = store.export() as { reviews: { inputBudgets?: InputBudgets }[] }
    for (const review of legacyData.reviews) delete review.inputBudgets
    const legacy = new SavedReviews(analyzers)
    legacy.import(legacyData)
    expect(restore(legacy)).not.toBeNull()
    settings.analysis.parallelJobs = 3
    expect(restore(legacy)).not.toBeNull()
    settings.analysis.paragraphInputChars = 24000
    expect(restore(legacy)).toBeNull()
    expect(capture()).toBe(true)
    const imported = new SavedReviews(analyzers)
    imported.import(store.export())
    expect(restore(imported)).not.toBeNull()
    settings.analysis.documentInputChars = 96000
    expect(restore(imported)).toBeNull()
  })
  it('records actual budgets and recovers known saved budgets without inventing legacy metadata', () => {
    const settings = defaultSettings(),
      history = new AnalysisHistory(),
      store = new SavedReviews(analyzers)
    settings.analysis.documentInputChars = 120000
    history.start('doc', hash('text'), 'document', 'general', false, analyzers, settings)
    expect(history.forDocument('doc')[0].inputBudgets).toEqual({
      paragraphInputChars: 12000,
      documentInputChars: 120000,
    })
    expect(
      store.capture(
        snapshot(['A passage.']),
        hash('markdown'),
        hash('serialization'),
        'general',
        settings,
        [],
        ['clarity'],
      ),
    ).toBe(true)
    const recovered = new AnalysisHistory()
    recovered.recoverSavedReviews(store.summaries(), analyzers)
    expect(recovered.forDocument('doc')[0].inputBudgets?.documentInputChars).toBe(120000)
    const data = history.export() as { runs: { inputBudgets?: InputBudgets }[] }
    for (const run of data.runs) delete run.inputBudgets
    const legacy = new AnalysisHistory()
    legacy.import(data)
    expect(legacy.forDocument('doc')[0].inputBudgets).toBeUndefined()
  })
})
