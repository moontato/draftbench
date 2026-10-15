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
import { effectiveConfig, configurationHash } from '../settings/model'
import { resolveIssue } from '../diagnostics/mapping'
import { hash } from '../diagnostics/hash'
import type { AIProvider } from '../ai/types'

const bridge = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  save: vi.fn(),
  saveSettings: vi.fn(),
}))
vi.mock('../storage/desktop', () => ({
  desktopAvailable: false,
  storage: {
    read: bridge.read,
    setMetadata: bridge.write,
    save: bridge.save,
    saveSettings: bridge.saveSettings,
  },
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
  bridge.save.mockClear().mockImplementation(async (_path, content) => hash(content))
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
it('saves the authoritative mapped feedback even when an edit and native Save begin before React rerenders', async () => {
  state.provider.current = provider
  await act(async () => state.run('block', 'clarity'))
  const original = state.findings.find((finding) => finding.quote === 'Bad one.')!
  await act(async () => {
    editor.commands.insertContentAt({ from: original.from, to: original.to }, 'New phrase.')
    expect(await state.save()).toBe(true)
  })
  const exported = state.feedbackSnapshots.current.export() as {
    documents: { findings: { issue: { quote: string }; previousReview: boolean }[] }[]
  }
  expect(exported.documents[0].findings).toHaveLength(1)
  expect(exported.documents[0].findings[0].issue.quote).toBe('Bad two.')
  expect(exported.documents[0].findings[0].previousReview).toBe(true)
})

it('updates saved feedback after exact Undo and a new review without requiring a redundant Save', async () => {
  state.provider.current = provider
  await act(async () => state.save())
  await act(async () => state.run('block', 'clarity'))
  const original = state.findings[0]
  await act(async () =>
    editor.commands.insertContentAt({ from: original.from, to: original.to }, 'New phrase.'),
  )
  await act(async () => editor.commands.undo())
  expect(state.dirty).toBe(true)
  vi.mocked(provider.completeStructured).mockImplementationOnce(async (request) => {
    const target = JSON.parse(request.user).targets[0]
    return {
      issues: [
        {
          block_id: target.block_id,
          quote: 'Bad one.',
          category: 'clarity',
          severity: 'suggestion',
          message: 'Updated review after Undo.',
          explanation: 'Explain the point.',
          action: 'replace',
          replacement: 'Better one.',
          guidance: null,
        },
      ],
    }
  })
  await act(async () => state.run('block', 'clarity', true))
  const exported = state.feedbackSnapshots.current.export() as {
    documents: { findings: { issue: { message: string } }[] }[]
  }
  expect(exported.documents[0].findings[0].issue.message).toBe('Updated review after Undo.')
  expect(bridge.save).toHaveBeenCalledTimes(1)
})

describe('closed revision references', () => {
  it('keeps mapping a hidden reference and resumes an edited quote that is no longer in the live list', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    const original = state.findings[0]
    await act(async () => state.beginRevision(original))
    const captured = state.reference!
    await act(async () => state.closeRevision())
    expect(state.reference).toBeNull()
    expect(state.canResumeRevision).toBe(true)
    await act(async () =>
      editor.commands.insertContentAt({ from: original.from, to: original.to }, 'New phrase.'),
    )
    expect(state.findings.some((finding) => finding.id === original.id)).toBe(false)
    await act(async () => state.resumeRevision())
    expect(state.reference?.finding.id).toBe(original.id)
    expect(state.reference?.finding.quote).toBe(original.quote)
    expect(state.reference?.capturedAt).toBe(captured.capturedAt)
    expect(state.reference?.capturedHash).toBe(captured.capturedHash)
    expect(state.referenceView?.state).toBe('Edited since reference')
    expect(state.referenceView?.location).toBeNull()
    expect(state.referenceView?.canApply).toBe(false)
    await act(async () => state.closeRevision())
    await act(async () => editor.commands.undo())
    await act(async () => state.resumeRevision())
    expect(state.referenceView?.state).toBe('Passage still matches')
    expect(state.referenceView?.canApply).toBe(true)
    await act(async () => state.closeRevision())
    await act(async () => state.save())
    await act(async () => state.loadDocument('other.md'))
    expect(state.canResumeRevision).toBe(false)
    await act(async () => state.resumeRevision())
    expect(state.reference).toBeNull()
  })
  it('resumes the original capture when a local recheck regenerates the same mapped Harper warning', async () => {
    const next = structuredClone(state.settings)
    next.analyzers.harper.enabled = true
    await act(async () => state.setSettings(next))
    const makeLocal = (quote: string) => {
      const input = state.current!,
        block = input.blocks[0],
        analyzer = state.analyzers.find((item) => item.id === 'harper')!
      return resolveIssue(
        {
          block_id: block.id,
          quote,
          offset: block.text.indexOf(quote),
          category: 'harper-grammar',
          severity: 'warning',
          message: 'Check this phrase.',
          explanation: 'Use the clearer phrase.',
          replacement: 'Better one.',
        },
        { ...input, selection: undefined },
        analyzer.id,
        analyzer.version,
        { kind: 'deterministic', name: 'Harper' },
        configurationHash(effectiveConfig(state.settings, analyzer.id)),
        { [block.id]: block.hash },
      )!
    }
    const original = makeLocal('Bad one.')
    await act(async () => state.setFindings([original]))
    await act(async () => state.beginRevision(original))
    const captured = state.reference!
    await act(async () =>
      editor.commands.insertContentAt({ from: original.from, to: original.to }, 'New one.'),
    )
    await act(async () => state.closeRevision())
    const fresh = makeLocal('New one.')
    expect(fresh.id).not.toBe(original.id)
    await act(async () => state.setFindings([fresh]))
    await act(async () => state.beginRevision(fresh))
    expect(state.reference?.finding.id).toBe(original.id)
    expect(state.reference?.capturedAt).toBe(captured.capturedAt)
    expect(state.reference?.capturedHash).toBe(captured.capturedHash)
    expect(state.referenceView?.state).toBe('Edited since reference')
    expect(state.referenceView?.canApply).toBe(false)
    expect(state.referenceView?.location).toBeNull()
  })
})

describe('review caret and Undo continuity', () => {
  it('allows caret placement on repeated underline clicks, including clicks before React rerenders', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    const finding = state.findings[0]
    await act(async () => {
      expect(state.findingClick(finding.id)).toBe(true)
      expect(state.findingClick(finding.id)).toBe(false)
      expect(state.findingClick(finding.id)).toBe(false)
    })
    expect(state.selected).toBe(finding.id)
  })
  it('keeps the old pin edited when a new finding on its edited range is clicked, and restores it on Undo', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    const original = state.findings.find((finding) => finding.quote === 'Bad one.')!
    await act(async () => state.beginRevision(original))
    const captured = state.reference!.capturedAt
    await act(async () =>
      editor.commands.insertContentAt({ from: original.from, to: original.to }, 'New phrase.'),
    )
    vi.mocked(provider.completeStructured).mockImplementationOnce(async (request) => {
      const target = JSON.parse(request.user).targets[0]
      return {
        issues: [
          {
            block_id: target.block_id,
            quote: 'New phrase.',
            category: 'clarity',
            severity: 'suggestion',
            message: 'New feedback.',
            explanation: 'Explain the change.',
            action: 'replace',
            replacement: 'Better phrase.',
            guidance: null,
          },
        ],
      }
    })
    await act(async () => state.run('block', 'clarity', true))
    const newFinding = state.findings.find((finding) => finding.quote === 'New phrase.')!
    await act(async () => expect(state.findingClick(newFinding.id)).toBe(false))
    expect(state.reference?.capturedAt).toBe(captured)
    expect(state.reference?.finding.id).toBe(original.id)
    expect(state.referenceView?.state).toBe('Edited since reference')
    await act(async () => editor.commands.undo())
    expect(state.findings.some((finding) => finding.id === original.id)).toBe(true)
    expect(state.referenceView?.state).toBe('Passage still matches')
    expect(state.referenceView?.canApply).toBe(true)
    await act(async () => editor.commands.redo())
    expect(state.referenceView?.state).toBe('Edited since reference')
  })
  it('never replaces an edited pin on unrelated underline clicks, including clicks before render and reopening revision mode', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    const original = state.findings.find((finding) => finding.quote === 'Bad one.')!
    const other = state.findings.find((finding) => finding.quote === 'Bad two.')!
    await act(async () => state.beginRevision(original))
    const captured = state.reference
    await act(async () =>
      editor.commands.insertContentAt({ from: original.from, to: original.to }, 'New phrase.'),
    )
    await act(async () => {
      expect(state.findingClick(other.id)).toBe(false)
      expect(state.findingClick(other.id)).toBe(false)
    })
    expect(state.reference?.finding.id).toBe(captured?.finding.id)
    expect(state.reference?.capturedAt).toBe(captured?.capturedAt)
    expect(state.reference?.finding.quote).toBe('Bad one.')
    expect(state.referenceView?.state).toBe('Edited since reference')
    expect(state.referenceView?.canApply).toBe(false)
    await act(async () => state.closeRevision())
    await act(async () => state.findingClick(other.id))
    await act(async () =>
      state.beginRevision(state.findings.find((finding) => finding.id === other.id)!),
    )
    expect(state.referenceView?.state).toBe('Review context changed')
    expect(state.referenceView?.canApply).toBe(false)
  })
  it('restores a newer review performed after editing when that edited state is Redone', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    const original = state.findings[0]
    await act(async () =>
      editor.commands.insertContentAt({ from: original.from, to: original.to }, 'New phrase.'),
    )
    vi.mocked(provider.completeStructured).mockImplementationOnce(async (request) => {
      const target = JSON.parse(request.user).targets[0]
      return {
        issues: [
          {
            block_id: target.block_id,
            quote: 'New phrase.',
            category: 'clarity',
            severity: 'suggestion',
            message: 'New feedback.',
            explanation: 'Explain the change.',
            action: 'replace',
            replacement: 'Better phrase.',
            guidance: null,
          },
        ],
      }
    })
    await act(async () => state.run('block', 'clarity', true))
    const fresh = state.findings.find((finding) => finding.quote === 'New phrase.')!
    await act(async () => state.beginRevision(fresh))
    await act(async () => editor.commands.undo())
    expect(state.referenceView?.state).toBe('Edited since reference')
    await act(async () => editor.commands.redo())
    expect(state.referenceView?.state).toBe('Passage still matches')
    expect(state.referenceView?.canApply).toBe(true)
    expect(
      state.findings
        .filter((finding) => finding.analyzerId === 'clarity')
        .map((finding) => finding.id),
    ).toEqual([fresh.id])
  })
  it('does not redefine the review baseline when stale feedback is pinned again', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    const originalId = state.findings[0].id
    await act(async () => editor.commands.insertContentAt(state.current!.blocks[0].to, ' More.'))
    await act(async () =>
      state.beginRevision(state.findings.find((finding) => finding.id === originalId)!),
    )
    expect(state.referenceView?.state).toBe('Review context changed')
    expect(state.referenceView?.canApply).toBe(false)
    await act(async () => editor.commands.undo())
    expect(state.referenceView?.state).toBe('Passage still matches')
    expect(state.referenceView?.canApply).toBe(true)
  })
})

describe('revision re-review lifecycle', () => {
  it('shows fresh feedback after an explicit rerun without closing the reference', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    await act(async () =>
      state.beginRevision(state.findings.find((finding) => finding.quote === 'Bad one.')!),
    )
    await act(async () =>
      editor.commands.insertContentAt(
        { from: state.reference!.finding.from, to: state.reference!.finding.to },
        'New wording.',
      ),
    )
    expect(state.referenceView?.state).toBe('Edited since reference')
    expect(state.findings.filter((finding) => finding.analyzerId === 'clarity')).toHaveLength(1)
    expect(state.findings.find((finding) => finding.analyzerId === 'clarity')?.stale).toBe(true)
    await act(async () => state.rereviewRevision())
    expect(state.reference?.finding.quote).toBe('Bad two.')
    expect(state.referenceView?.state).toBe('Passage still matches')
    expect(state.referenceView?.canApply).toBe(true)
    expect(vi.mocked(provider.completeStructured).mock.calls).toHaveLength(2)
    expect(state.history.current.forDocument(state.session!.id)[0].force).toBe(true)
  })
  it('shows a clean result rather than old advice, and marks it out of date on editing', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    await act(async () => state.beginRevision(state.findings[0]))
    const block = state.current!.blocks[0]
    await act(async () =>
      editor.commands.insertContentAt({ from: block.from, to: block.to }, 'Good prose.'),
    )
    await act(async () => state.rereviewRevision())
    expect(state.referenceView?.state).toBe('No issues detected')
    expect(state.reference?.cleanReview?.text).toBe('Good prose.')
    expect(state.referenceView?.canApply).toBe(false)
    await act(async () => state.changeProfile('technical'))
    expect(state.referenceView?.state).toBe('Needs a fresh review')
    await act(async () => state.changeProfile('general'))
    expect(state.referenceView?.state).toBe('No issues detected')
    await act(async () => editor.commands.insertContentAt(state.current!.blocks[0].to, ' More.'))
    expect(state.referenceView?.state).toBe('Edited since review')
  })
  it('keeps multiple fresh findings available when choosing among rerun results', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    await act(async () => state.beginRevision(state.findings[0]))
    await act(async () => state.rereviewRevision())
    expect(state.reference?.latestFindings).toHaveLength(2)
    await act(async () => state.beginRevision(state.reference!.latestFindings![1]))
    expect(state.reference?.finding.quote).toBe('Bad two.')
    expect(state.reference?.latestFindings).toHaveLength(2)
  })
  it('does not replace the reference on a failed re-review', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    await act(async () => state.beginRevision(state.findings[0]))
    const captured = state.reference!.capturedAt
    vi.mocked(provider.completeStructured).mockRejectedValueOnce(new Error('Review failed.'))
    await act(async () => state.rereviewRevision())
    expect(state.reference?.capturedAt).toBe(captured)
    expect(state.reference?.latestFindings).toBeUndefined()
    expect(state.notice?.error).toBe(true)
  })
  it('does not publish a clean result or erase feedback if typing continues during re-review', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    await act(async () => state.beginRevision(state.findings[0]))
    let release!: () => void, began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(provider.completeStructured).mockImplementationOnce(async () => {
      began()
      await waiting
      return { issues: [] }
    })
    await act(async () => {
      const review = state.rereviewRevision()
      await started
      editor.commands.insertContentAt(state.current!.blocks[0].to, ' More.')
      release()
      await review
    })
    expect(state.reference?.cleanReview).toBeUndefined()
    expect(state.reference?.latestFindings).toBeUndefined()
    expect(state.findings.filter((finding) => finding.analyzerId === 'clarity')).toHaveLength(2)
    expect(state.findings.every((finding) => finding.stale)).toBe(true)
    expect(state.notice?.message).toContain('changed during analysis')
  })
  it('does not replace a reference after closing and resuming it during a pending re-review', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    await act(async () => state.beginRevision(state.findings[0]))
    const captured = state.reference!
    let release!: () => void, began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(provider.completeStructured).mockImplementationOnce(async () => {
      began()
      await waiting
      return { issues: [] }
    })
    await act(async () => {
      const review = state.rereviewRevision()
      await started
      state.closeRevision()
      state.resumeRevision()
      release()
      await review
    })
    expect(state.reference?.capturedAt).toBe(captured.capturedAt)
    expect(state.reference?.finding.id).toBe(captured.finding.id)
    expect(state.reference?.cleanReview).toBeUndefined()
  })
  it('never opens a reference in a different document after a pending re-review completes', async () => {
    state.provider.current = provider
    await act(async () => state.run('block', 'clarity'))
    await act(async () => state.beginRevision(state.findings[0]))
    let release!: () => void, began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(provider.completeStructured).mockImplementationOnce(async () => {
      began()
      await waiting
      return { issues: [] }
    })
    await act(async () => {
      const review = state.rereviewRevision()
      await started
      await state.loadDocument('other.md')
      release()
      await review
    })
    expect(state.session?.path).toBe('other.md')
    expect(state.reference).toBeNull()
  })
  it('excludes context-changed feedback from the reopenable snapshot without rejecting fresh results', async () => {
    state.provider.current = provider
    await act(async () => state.run('document', ['clarity', 'development']))
    await act(async () =>
      state.accept(state.findings.find((finding) => finding.analyzerId === 'clarity')!),
    )
    expect(state.findings.some((finding) => finding.contextChanged)).toBe(true)
    await act(async () => state.run('block', 'clarity', true))
    expect(state.notice?.error).toBe(false)
    expect(
      state.savedReviews.current.summaries()[0].sources.every((source) => source.id === 'clarity'),
    ).toBe(true)
  })
})

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
