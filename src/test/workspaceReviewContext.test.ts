import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { useWorkspaceSession } from '../app/useWorkspaceSession'
import { BlockIdentity, ensureBlockIds } from '../editor/blocks'
import { runAnalyzer } from '../analyzers/runner'
import { development } from '../analyzers/registry'
import { AnalysisCache } from '../analyzers/cache'
import { effectiveConfig } from '../settings/model'
import { hash } from '../diagnostics/hash'
import type { AIProvider } from '../ai/types'

const bridge = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), saveSettings: vi.fn() }))
vi.mock('../storage/desktop', () => ({
  desktopAvailable: false,
  storage: { read: bridge.read, setMetadata: bridge.write, saveSettings: bridge.saveSettings },
  errorMessage: (error: unknown) => String(error),
}))
let root: Root, editor: Editor, state: ReturnType<typeof useWorkspaceSession>
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
          category: 'development',
          severity: 'suggestion',
          message: 'Clarify this.',
          explanation: 'Explain the point.',
          action: 'replace',
          replacement: quote.replace('Bad', 'Better'),
          guidance: null,
        })),
    }
  }),
}
function Probe() {
  state = useWorkspaceSession()
  return null
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(provider.completeStructured).mockClear()
  bridge.read.mockResolvedValue({ content: 'Bad one. Bad two.', hash: hash('Bad one. Bad two.') })
  bridge.write.mockResolvedValue(undefined)
  bridge.saveSettings.mockResolvedValue(undefined)
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  await act(async () => state.loadDocument('essay.md'))
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Markdown, BlockIdentity],
    content: 'Bad one. Bad two.',
    contentType: 'markdown',
  })
  ensureBlockIds(editor)
  await act(async () => state.onReady(editor))
  editor.on('update', ({ transaction }) => state.onChange(editor, transaction))
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor?.destroy()
})
async function analyze() {
  const result = await runAnalyzer(
    development,
    state.current!,
    'document',
    effectiveConfig(state.settings, 'development'),
    provider,
    new AbortController().signal,
    new AnalysisCache(),
    false,
    undefined,
    state.settings.analysis,
    state.profile,
  )
  await act(async () => state.setFindings(result.findings))
}
describe('manual reviewer batches', () => {
  it('runs only requested reviewers, deduplicates IDs, and preserves other findings', async () => {
    state.provider.current = provider
    await act(async () => state.run('document', 'ambiguous-reference'))
    const old = state.findings.filter((f) => f.analyzerId === 'ambiguous-reference')
    const settings = structuredClone(state.settings)
    await act(async () => state.run('document', ['clarity', 'development', 'clarity']))
    const run = state.history.current.forDocument(state.session!.id)[0]
    expect(run.reviewers.map((r) => r.id)).toEqual(['clarity', 'development'])
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(3)
    expect(state.findings.filter((f) => f.analyzerId === 'ambiguous-reference')).toEqual(old)
    expect(new Set(state.findings.map((f) => f.analyzerId))).toEqual(
      new Set(['clarity', 'development', 'ambiguous-reference']),
    )
    expect(state.settings).toEqual(settings)
    await act(async () => state.run('document', ['clarity', 'development']))
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(3)
    expect(
      state.history.current
        .forDocument(state.session!.id)[0]
        .reviewers.every((r) => r.cacheHits === 1 && r.requests === 0),
    ).toBe(true)
    const developmentFindings = state.findings.filter((f) => f.analyzerId === 'development')
    await act(async () => state.run('document', ['clarity'], true))
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(4)
    expect(state.findings.filter((f) => f.analyzerId === 'development')).toEqual(
      developmentFindings,
    )
    expect(state.findings.filter((f) => f.analyzerId === 'ambiguous-reference')).toEqual(old)
    expect(state.history.current.forDocument(state.session!.id)[0]).toMatchObject({
      force: true,
      reviewers: [{ id: 'clarity', cacheHits: 0, requests: 1 }],
    })
  })
  it('empty, unknown, disabled, and unsupported selections never fall back to all reviewers', async () => {
    state.provider.current = provider
    for (const ids of [[], ['not-a-reviewer'], ['harper']]) {
      await act(async () => state.run('document', ids))
      expect(state.notice?.message).toContain('No selected reviewers')
    }
    await act(async () => state.run('block', ['development', 'structure']))
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(0)
    expect(state.history.current.forDocument(state.session!.id)).toHaveLength(0)
    expect(state.busy).toBe(false)
  })
  it('supports explicit custom batches outside preset membership without enabling disabled tasks', async () => {
    const next = structuredClone(state.settings)
    next.customAnalyzers.push({
      id: 'my-reviewer',
      name: 'My reviewer',
      description: '',
      instructions: 'Check the reasoning.',
      scope: 'document',
      enabled: true,
      severity: 'warning',
    })
    next.customAnalyzers.push({
      ...next.customAnalyzers[0],
      id: 'disabled-reviewer',
      enabled: false,
    })
    await act(async () => state.saveSettings(next))
    state.provider.current = provider
    await act(async () =>
      state.run('document', ['clarity', 'my-reviewer', 'disabled-reviewer', 'harper']),
    )
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(2)
    expect(
      state.history.current.forDocument(state.session!.id)[0].reviewers.map((r) => r.id),
    ).toEqual(['clarity', 'my-reviewer'])
    expect(new Set(state.findings.map((f) => f.analyzerId))).toEqual(
      new Set(['clarity', 'my-reviewer']),
    )
    expect(state.settings.customProfiles).toEqual([])
  })
  it('supports paragraph and selected-text batches without running document-only reviewers', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', ['clarity', 'development']))
    expect(state.history.current.forDocument(state.session!.id)[0]).toMatchObject({
      scope: 'block',
      reviewers: [{ id: 'clarity' }],
    })
    const block = state.current!.blocks[0]
    await act(async () => {
      editor.commands.setTextSelection({ from: block.from, to: block.from + 'Bad one.'.length })
    })
    await act(async () => state.run('selection', ['ambiguous-reference', 'structure']))
    expect(state.history.current.forDocument(state.session!.id)[0]).toMatchObject({
      scope: 'selection',
      reviewers: [{ id: 'ambiguous-reference' }],
    })
    expect(
      state.findings.filter((f) => f.analyzerId === 'ambiguous-reference').map((f) => f.quote),
    ).toEqual(['Bad one.'])
  })
  it('isolates failures within a selected batch without capturing a partial saved review', async () => {
    state.provider.current = provider
    vi.mocked(provider.completeStructured).mockRejectedValueOnce(new Error('Test failure.'))
    await act(async () => state.run('document', ['clarity', 'development']))
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(2)
    expect(state.history.current.forDocument(state.session!.id)[0]).toMatchObject({
      status: 'warnings',
      reviewers: [
        { id: 'clarity', status: 'failed' },
        { id: 'development', status: 'completed' },
      ],
    })
    expect(state.findings.every((f) => f.analyzerId === 'development')).toBe(true)
    expect(state.savedReviews.current.summaries()).toHaveLength(0)
  })
  it('cancels a selected batch before queued reviewers start and never caches aborted responses', async () => {
    state.provider.current = provider
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.mocked(provider.completeStructured).mockImplementationOnce(async () => {
      started()
      await waiting
      return { issues: [] }
    })
    await act(async () => {
      const running = state.run('document', ['clarity', 'development'])
      await began
      state.running.current!.abort()
      release()
      await running
    })
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(1)
    expect(state.history.current.forDocument(state.session!.id)[0].status).toBe('cancelled')
    expect(state.cache.current.export()).toMatchObject({ entries: [] })
    expect(state.busy).toBe(false)
  })
})

it('actual workspace Undo/Redo cannot erase flags added by a profile switch', async () => {
  await analyze()
  await act(async () => state.accept(state.findings[0]))
  await act(async () => state.changeProfile('technical'))
  await act(async () => {
    expect(editor.commands.undo()).toBe(true)
  })
  expect(state.findings).toHaveLength(2)
  expect(
    state.findings.every((f) => f.needsRerun === 'genre' && f.reviewContext?.profile === 'general'),
  ).toBe(true)
  await act(async () => {
    expect(editor.commands.redo()).toBe(true)
  })
  expect(state.findings).toHaveLength(1)
  expect(state.findings[0].needsRerun).toBe('genre')
  await act(async () => {
    expect(editor.commands.undo()).toBe(true)
  })
  await act(async () => state.changeProfile('general'))
  expect(state.findings.every((f) => !f.needsRerun)).toBe(true)
})
it('Undo cannot resurrect findings as current after the inference configuration changes', async () => {
  await analyze()
  await act(async () => state.accept(state.findings[0]))
  const next = structuredClone(state.settings)
  next.ai.model = 'new-model'
  await act(async () => state.saveSettings(next))
  expect(state.findings).toHaveLength(0)
  await act(async () => {
    expect(editor.commands.undo()).toBe(true)
  })
  expect(state.findings).toHaveLength(2)
  expect(state.findings.every((f) => f.needsRerun === 'reviewer')).toBe(true)
})
it('preserves explicitly requested custom reviews in their original profile without broadening others', async () => {
  const next = structuredClone(state.settings)
  next.customAnalyzers.push({
    id: 'my-reviewer',
    name: 'My reviewer',
    description: '',
    instructions: 'Review meaningful reader problems.',
    scope: 'paragraph',
    enabled: true,
    severity: 'suggestion',
  })
  await act(async () => state.saveSettings(next))
  const reviewer = state.analyzers.find((a) => a.id === 'my-reviewer')!
  const result = await runAnalyzer(
    reviewer,
    state.current!,
    'document',
    effectiveConfig(state.settings, reviewer.id),
    provider,
    new AbortController().signal,
    new AnalysisCache(),
    false,
    undefined,
    state.settings.analysis,
    state.profile,
  )
  await act(async () => state.setFindings(result.findings))
  await act(async () => state.accept(state.findings[0]))
  expect(state.findings[0].needsRerun).toBeUndefined()
  await act(async () => {
    expect(editor.commands.undo()).toBe(true)
  })
  expect(state.findings.every((f) => !f.needsRerun)).toBe(true)
  const requests = vi.mocked(provider.completeStructured).mock.calls.length
  await act(async () => state.changeProfile('technical'))
  expect(state.findings.every((f) => f.needsRerun === 'disabled')).toBe(true)
  await act(async () => state.changeProfile('general'))
  expect(state.findings.every((f) => !f.needsRerun)).toBe(true)
  expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(requests)
})
it('settings-driven fallback to General prose also reconciles genre context', async () => {
  const settings = structuredClone(state.settings)
  settings.customProfiles.push({
    id: 'custom-prose',
    name: 'Custom prose',
    description: '',
    enabled: ['development'],
  })
  await act(async () => state.saveSettings(settings))
  await act(async () => state.changeProfile('custom-prose'))
  await analyze()
  const next = structuredClone(state.settings)
  next.customProfiles = []
  await act(async () => state.saveSettings(next))
  expect(state.profile).toBe('general')
  expect(
    state.findings.every(
      (f) => f.needsRerun === 'genre' && f.reviewContext?.profile === 'custom-prose',
    ),
  ).toBe(true)
})
