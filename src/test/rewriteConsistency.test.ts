import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { clarity } from '../analyzers/llm/semantic'
import { defaultSettings, effectiveConfig } from '../settings/model'
import type { AIProvider } from '../ai/types'
const REPLACEMENT = 'That changed when I joined the robotics club.'
const DOC =
  'I spent two years abroad and I did not know what I wanted to dedicate the rest of my life to.\n\nThat was until I joined the robotics club.'
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
  vi.clearAllMocks()
})
function mockProvider(): AIProvider {
  return {
    testConnection: vi.fn(),
    listModels: vi.fn(),
    completeStructured: vi.fn(async (request) => {
      const input = JSON.parse(request.user)
      return input.targets[0].text.includes('That was until')
        ? {
            issues: [
              {
                block_id: input.targets[0].block_id,
                quote: 'That was until I joined the robotics club.',
                category: 'clarity',
                severity: 'suggestion',
                message: 'The transition depends on the prior paragraph.',
                explanation: 'The prior state must be visible to the reviewer.',
                replacement: REPLACEMENT,
                confidence: 0.7,
              },
            ],
          }
        : { issues: [] }
    }),
  }
}
const config = effectiveConfig(defaultSettings(), 'clarity')
it('sends neighboring context to Clarity so cross-paragraph references are visible', async () => {
  const e = editor(DOC),
    provider = mockProvider()
  await runAnalyzer(
    clarity,
    snapshot(e, 'doc', 0),
    'document',
    config,
    provider,
    new AbortController().signal,
    new AnalysisCache(),
  )
  const requests = vi
    .mocked(provider.completeStructured)
    .mock.calls.map((call) => JSON.parse(call[0].user))
  const second = requests.find((r) => r.targets[0].text.includes('That was until'))!
  expect(second.context.map((b: { text: string }) => b.text).join(' ')).toContain(
    'I spent two years abroad',
  )
})
it('keeps the replacement when the shared reviewer is re-run for a different profile', async () => {
  const e = editor(DOC),
    s = snapshot(e, 'doc', 0),
    provider = mockProvider(),
    cache = new AnalysisCache()
  const first = await runAnalyzer(
    clarity,
    s,
    'document',
    config,
    provider,
    new AbortController().signal,
    cache,
    false,
    undefined,
    undefined,
    'essay',
  )
  expect(first.findings).toHaveLength(1)
  expect(first.findings[0].replacement).toBe(REPLACEMENT)
  // Clarity stays genre-neutral; a real profile change must reuse its cache.
  const rerun = await runAnalyzer(
    clarity,
    s,
    'document',
    config,
    provider,
    new AbortController().signal,
    cache,
    false,
    undefined,
    undefined,
    'technical',
  )
  expect(rerun.cacheHits).toBe(2)
  expect(rerun.findings.map((f) => [f.id, f.replacement])).toEqual(
    first.findings.map((f) => [f.id, f.replacement]),
  )
  const persisted = new AnalysisCache()
  persisted.import(cache.export())
  const again = await runAnalyzer(
    clarity,
    s,
    'document',
    config,
    mockProvider(),
    new AbortController().signal,
    persisted,
  )
  expect(again.findings).toHaveLength(1)
  expect(again.findings[0].replacement).toBe(REPLACEMENT)
})
it('makes a fresh request when the inference configuration changes, which can change the model answer', async () => {
  const e = editor(DOC),
    s = snapshot(e, 'doc', 0),
    provider = mockProvider(),
    cache = new AnalysisCache(),
    signal = new AbortController().signal
  await runAnalyzer(clarity, s, 'document', config, provider, signal, cache)
  const fresh = await runAnalyzer(
    clarity,
    s,
    'document',
    { ...config, model: 'other-model' },
    provider,
    signal,
    cache,
  )
  expect(fresh.cacheHits).toBe(0)
  expect(provider.completeStructured).toHaveBeenCalledTimes(4)
})
