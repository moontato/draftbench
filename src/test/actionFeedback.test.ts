import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { planScope, runAnalyzer, engineMetadata } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { SavedReviews } from '../analyzers/savedReviews'
import { analyzers, development } from '../analyzers/registry'
import { validateResult } from '../analyzers/llm/semantic'
import { analyzerEnabled } from '../profiles/profiles'
import { reviewContextFor } from '../profiles/reviewContext'
import { defaultSettings, effectiveConfig } from '../settings/model'
import { canonical, hash } from '../diagnostics/hash'
import { resolveIssue } from '../diagnostics/mapping'
import type { AIProvider } from '../ai/types'
import type { Issue } from '../diagnostics/types'
const editors: Editor[] = []
function editor(content: string) {
  const instance = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Markdown, BlockIdentity],
    content,
    contentType: 'markdown',
  })
  ensureBlockIds(instance)
  editors.push(instance)
  return instance
}
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
})
function mockProvider(
  response: (target: { block_id: string; text: string }) => { issues: Issue[] },
): AIProvider {
  return {
    testConnection: vi.fn(),
    listModels: vi.fn(),
    completeStructured: vi.fn(async (request) => response(JSON.parse(request.user).targets[0])),
  }
}
function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    block_id: 'b0',
    quote: 'The point is unclear.',
    category: 'development',
    severity: 'warning',
    message: 'The claim is generic.',
    explanation: 'The reader cannot see why this matters.',
    replacement: 'The point is clear.',
    confidence: 0.8,
    ...overrides,
  }
}
describe('finding action feedback', () => {
  it('derives a resolution for legacy findings without an explicit action', () => {
    const legacy = validateResult({ issues: [issue({ action: undefined, replacement: 'Fixed.' })] })
    expect(legacy.issues[0].action).toBe('replace')
    const advice = validateResult(
      {
        issues: [issue({ action: undefined, replacement: undefined })],
      },
      'persisted',
    )
    expect(advice.issues[0].action).toBe('guide')
  })
  it('keeps exactly one resolution per finding and discards conflicts', () => {
    expect(
      validateResult({ issues: [issue({ action: 'replace', replacement: undefined })] }).issues,
    ).toHaveLength(0)
    expect(
      validateResult({ issues: [issue({ action: 'replace', guidance: 'Also consider this.' })] })
        .issues,
    ).toHaveLength(0)
    expect(
      validateResult({ issues: [issue({ action: 'guide', replacement: 'Fixed.' })] }).issues,
    ).toHaveLength(0)
    expect(
      validateResult({
        issues: [issue({ action: 'guide', replacement: undefined, replacements: ['Fixed.'] })],
      }).issues,
    ).toHaveLength(0)
    const question = validateResult({
      issues: [
        issue({
          action: 'question',
          replacement: undefined,
          guidance: 'Which outcome did you intend?',
        }),
      ],
    })
    expect(question.issues[0].action).toBe('question')
    expect(question.issues[0].guidance).toBe('Which outcome did you intend?')
    const guide = validateResult({
      issues: [
        issue({
          action: 'guide',
          replacement: undefined,
          guidance: 'Name the concrete consequence.',
        }),
      ],
    })
    expect(guide.issues[0].action).toBe('guide')
    expect(guide.issues[0].guidance).toBe('Name the concrete consequence.')
  })
  it('rejects empty live guidance/questions while allowing migrated legacy advice', () => {
    for (const action of ['guide', 'question'] as const)
      for (const guidance of [undefined, '', '   ']) {
        const result = validateResult({
          issues: [issue({ action, guidance, replacement: undefined })],
        })
        expect(result.issues).toHaveLength(0)
        expect(result.warnings).toHaveLength(1)
      }
    expect(
      validateResult({
        issues: [{ ...issue(), action: 'question', replacement: null, guidance: null }],
      }).issues,
    ).toHaveLength(0)
    expect(
      validateResult({ issues: [issue({ action: undefined, replacement: undefined })] }).issues,
    ).toHaveLength(0)
    expect(
      validateResult(
        { issues: [issue({ action: undefined, replacement: undefined })] },
        'persisted',
      ).issues[0].action,
    ).toBe('guide')
    expect(
      validateResult(
        { issues: [issue({ action: 'question', replacement: undefined })] },
        'persisted',
      ).issues,
    ).toHaveLength(0)
  })
  it('distinguishes actions, guidance, alternatives, and genre policies in finding identity', () => {
    const s = snapshot(editor('The point is unclear.'), 'doc', 0),
      block = s.blocks[0]
    const id = (changes: Partial<Issue>, profile = 'general') =>
      resolveIssue(
        issue({ block_id: block.id, ...changes }),
        s,
        development.id,
        development.version,
        engineMetadata(development, defaultSettings().ai),
        'config',
        { [block.id]: block.hash },
        reviewContextFor(development, profile),
      )!.id
    const guide = { action: 'guide' as const, replacement: undefined, guidance: 'Add an example.' }
    expect(id(guide)).not.toBe(id({ ...guide, guidance: 'Explain the cause.' }))
    expect(id(guide)).not.toBe(id({ ...guide, action: 'question' }))
    expect(id({ replacements: ['First.'] })).not.toBe(id({ replacements: ['Second.'] }))
    expect(id({ replacement: '' })).not.toBe(id({ action: 'guide', replacement: undefined }))
    expect(id(guide, 'general')).not.toBe(id(guide, 'technical'))
    expect(id({ message: 'a|b', explanation: 'c' })).not.toBe(
      id({ message: 'a', explanation: 'b|c' }),
    )
  })
  it('stamps the effective action on resolved findings, including findings without a rewrite', () => {
    const e = editor('The point is unclear.'),
      s = snapshot(e, 'doc', 0),
      block = s.blocks[0]
    const finding = resolveIssue(
      issue({ block_id: block.id, replacement: undefined }),
      s,
      development.id,
      development.version,
      engineMetadata(development, defaultSettings().ai),
      'config',
      { [block.id]: block.hash },
    )!
    expect(finding.action).toBe('guide')
    expect(finding.guidance).toBeUndefined()
  })
})
describe('development reviewer', () => {
  it('reviews the whole document in a single unit and surfaces guidance findings', async () => {
    const e = editor(
        'I studied abroad for two years and I did not know what I wanted to dedicate the rest of my life to.\n\nThat was until I took my first physics class.',
      ),
      s = snapshot(e, 'doc', 0)
    expect(planScope(development, s, 'document')).toHaveLength(1)
    const provider = mockProvider((target) => ({
      issues: [
        issue({
          block_id: target.block_id,
          quote: 'I did not know what I wanted to dedicate the rest of my life to.',
          action: 'question',
          replacement: undefined,
          guidance: 'What specifically changed after the physics class?',
        }),
      ],
    }))
    const result = await runAnalyzer(
      development,
      s,
      'document',
      effectiveConfig(defaultSettings(), development.id),
      provider,
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].action).toBe('question')
    expect(result.findings[0].guidance).toBe('What specifically changed after the physics class?')
    expect(result.findings[0].replacement).toBeUndefined()
  })
  it('is enabled for general, essay, and technical writing but not professional email', () => {
    const settings = defaultSettings()
    expect(analyzerEnabled(settings, 'development', 'general')).toBe(true)
    expect(analyzerEnabled(settings, 'development', 'essay')).toBe(true)
    expect(analyzerEnabled(settings, 'development', 'technical')).toBe(true)
    expect(analyzerEnabled(settings, 'development', 'email')).toBe(false)
    expect(development.engine).toBe('ai')
    expect(development.scopes).toEqual(['document'])
  })
})
describe('action persistence', () => {
  const settings = defaultSettings()
  const TEXT = 'The point is unclear.'
  function savedFinding(action: 'question' | 'guide', guidance?: string) {
    const e = editor(TEXT),
      s = snapshot(e, 'doc', 0),
      block = s.blocks[0]
    return {
      snapshot: s,
      finding: resolveIssue(
        issue({ block_id: block.id, action, guidance, replacement: undefined }),
        s,
        development.id,
        development.version,
        engineMetadata(development, settings.ai),
        hash(canonical(settings.ai)),
        { [block.id]: block.hash },
        reviewContextFor(development, 'general'),
      )!,
    }
  }
  it('round-trips question actions with guidance through saved reviews', () => {
    const saved = savedFinding('question', 'Which outcome did you intend?')
    const store = new SavedReviews(analyzers)
    expect(
      store.capture(
        saved.snapshot,
        hash('text'),
        hash('serialized'),
        'general',
        settings,
        [saved.finding],
        ['development'],
      ),
    ).toBe(true)
    const restored = store.restore(
      snapshot(editor(TEXT), 'doc', 0),
      hash('text'),
      hash('serialized'),
      'general',
      settings,
    )!
    expect(restored.findings[0].action).toBe('question')
    expect(restored.findings[0].guidance).toBe('Which outcome did you intend?')
  })
  it('restores genuinely legacy saved findings as guide without guidance', () => {
    const saved = savedFinding('guide', 'Name the consequence.')
    const store = new SavedReviews(analyzers)
    expect(
      store.capture(
        saved.snapshot,
        hash('text'),
        hash('serialized'),
        'general',
        settings,
        [saved.finding],
        ['development'],
      ),
    ).toBe(true)
    const data = store.export() as {
      reviews: { findings: { issue: { action?: string; guidance?: string } }[] }[]
    }
    delete data.reviews[0].findings[0].issue.action
    delete data.reviews[0].findings[0].issue.guidance
    const imported = new SavedReviews(analyzers)
    imported.import(data)
    const restored = imported.restore(
      snapshot(editor(TEXT), 'doc', 0),
      hash('text'),
      hash('serialized'),
      'general',
      settings,
    )!
    expect(restored.findings[0].action).toBe('guide')
  })
  it('keeps guidance through the analysis cache and its persisted round-trip', async () => {
    const e = editor(TEXT),
      s = snapshot(e, 'doc', 0),
      config = effectiveConfig(settings, development.id),
      cache = new AnalysisCache()
    const provider = mockProvider((target) => ({
      issues: [
        issue({
          block_id: target.block_id,
          action: 'guide',
          replacement: undefined,
          guidance: 'Name the concrete consequence.',
        }),
      ],
    }))
    const first = await runAnalyzer(
      development,
      s,
      'document',
      config,
      provider,
      new AbortController().signal,
      cache,
    )
    expect(first.findings[0].guidance).toBe('Name the concrete consequence.')
    const rerun = await runAnalyzer(
      development,
      s,
      'document',
      config,
      mockProvider(() => ({ issues: [] })),
      new AbortController().signal,
      cache,
    )
    expect(rerun.cacheHits).toBe(1)
    expect(rerun.findings[0].action).toBe('guide')
    expect(rerun.findings[0].guidance).toBe('Name the concrete consequence.')
    const persisted = new AnalysisCache()
    persisted.import(cache.export())
    const imported = await runAnalyzer(
      development,
      s,
      'document',
      config,
      mockProvider(() => ({ issues: [] })),
      new AbortController().signal,
      persisted,
    )
    expect(imported.cacheHits).toBe(1)
    expect(imported.findings[0].guidance).toBe('Name the concrete consequence.')
  })
})
