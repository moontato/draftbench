import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { applyFix } from '../editor/diagnostics'
import { harper } from '../analyzers/builtin/harper'
import { runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { defaultSettings, effectiveConfig } from '../settings/model'
import { SavedReviews } from '../analyzers/savedReviews'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { evalSnapshot } from '../eval/harness'
import { hash } from '../diagnostics/hash'
import type { AIProvider } from '../ai/types'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.length = 0
  vi.clearAllMocks()
})
const provider: AIProvider = {
  testConnection: vi.fn(),
  listModels: vi.fn(),
  completeStructured: vi.fn(),
}
function finding(text: string, quote = 'could of') {
  return {
    offset: text.indexOf(quote),
    quote,
    category: 'harper-grammar',
    severity: 'warning',
    message: 'Use could have.',
    explanation: 'Could of is not the intended verb phrase.',
    replacement: 'could have',
    replacements: ['could have', "could've"],
    confidence: 1,
  }
}
function editor(source: string) {
  const ed = new Editor({
    extensions: [StarterKit, Markdown, BlockIdentity],
    content: source,
    contentType: 'markdown',
  })
  ensureBlockIds(ed)
  editors.push(ed)
  return ed
}
describe('Harper common deterministic pipeline', () => {
  it('bounds native workers to one and drops cancelled queued typing/manual work', async () => {
    const input = evalSnapshot('She could of finished.')
    let finish!: (value: unknown) => void
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    vi.mocked(invoke).mockResolvedValue([finding(input.blocks[0].text)])
    const run = (signal: AbortSignal) =>
      runAnalyzer(
        harper,
        input,
        'document',
        defaultSettings().ai,
        provider,
        signal,
        new AnalysisCache(),
      )
    const firstController = new AbortController(),
      queuedController = new AbortController()
    const first = run(firstController.signal)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const queued = run(queuedController.signal).catch((error: unknown) => error)
    const latest = run(new AbortController().signal)
    queuedController.abort()
    firstController.abort()
    expect(await queued).toBeInstanceOf(Error)
    expect(invoke).toHaveBeenCalledTimes(1)
    const abandoned = first.catch((error: unknown) => error)
    finish([finding(input.blocks[0].text)])
    expect(await abandoned).toBeInstanceOf(Error)
    expect((await latest).findings).toHaveLength(1)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('maps Unicode UTF-16 offsets and alternative suggestions without any AI request', async () => {
    const input = evalSnapshot('😀 She could of finished the report.')
    vi.mocked(invoke).mockResolvedValue([finding(input.blocks[0].text)])
    const result = await runAnalyzer(
      harper,
      input,
      'document',
      defaultSettings().ai,
      provider,
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(result.findings[0]).toMatchObject({
      start: 7,
      quote: 'could of',
      replacements: ['could have', "could've"],
      engine: { kind: 'deterministic', name: 'Harper 2.11.0 · offline' },
    })
    expect(invoke).toHaveBeenCalledWith('harper_review', { text: input.blocks[0].text })
    expect(provider.completeStructured).not.toHaveBeenCalled()
  })
  it('excludes code blocks and does not impose AI input budgets on grammar checks', async () => {
    const input = evalSnapshot(
      'A'.repeat(1100) + ' She could of finished.\n\nShe could of finished in code.',
    )
    input.blocks[1].type = 'codeBlock'
    vi.mocked(invoke).mockImplementation(async (_command, args) => [
      finding(String((args as { text: string }).text)),
    ])
    const result = await runAnalyzer(
      harper,
      input,
      'document',
      defaultSettings().ai,
      provider,
      new AbortController().signal,
      new AnalysisCache(),
      false,
      undefined,
      { paragraphInputChars: 1000, documentInputChars: 1000 },
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(result.findings).toHaveLength(1)
  })
  it('translates selection-relative deterministic offsets back to the full source block, including cache reuse', async () => {
    const input = evalSnapshot('The introduction ends here. She could of finished.')
    const start = input.blocks[0].text.indexOf('She')
    input.selection = { from: input.blocks[0].positions[start], to: input.blocks[0].to }
    vi.mocked(invoke).mockImplementation(async (_command, args) => [
      finding(String((args as { text: string }).text)),
    ])
    const cache = new AnalysisCache()
    const run = () =>
      runAnalyzer(
        harper,
        input,
        'selection',
        defaultSettings().ai,
        provider,
        new AbortController().signal,
        cache,
      )
    const result = await run()
    expect(result.findings[0].start).toBe(input.blocks[0].text.indexOf('could of'))
    expect((await run()).cacheHits).toBe(1)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('uses normal reviewed fixes, preserves marks and isolates Undo/Redo', async () => {
    const ed = editor('She **could of** finished the report.'),
      input = snapshot(ed, 'doc', 0)
    vi.mocked(invoke).mockResolvedValue([finding(input.blocks[0].text)])
    const result = await runAnalyzer(
      harper,
      input,
      'document',
      defaultSettings().ai,
      provider,
      new AbortController().signal,
      new AnalysisCache(),
    )
    const diagnostic = { ...result.findings[0], replacement: result.findings[0].replacements![1] }
    expect(applyFix(ed, diagnostic, 'doc', 0)).toBe(true)
    expect(ed.getMarkdown()).toContain("**could've**")
    ed.commands.undo()
    expect(ed.getMarkdown()).toContain('**could of**')
    ed.commands.redo()
    expect(ed.getMarkdown()).toContain("**could've**")
  })
  it('round-trips alternatives through request cache and saved-review metadata onto fresh editor identities', async () => {
    const settings = defaultSettings()
    settings.analyzers.harper.enabled = true
    const input = evalSnapshot('She could of finished.'),
      cache = new AnalysisCache(),
      registry = createAnalyzerRegistry(settings)
    vi.mocked(invoke).mockResolvedValue([finding(input.blocks[0].text)])
    const result = await runAnalyzer(
      harper,
      input,
      'document',
      effectiveConfig(settings, harper.id),
      provider,
      new AbortController().signal,
      cache,
    )
    const imported = new AnalysisCache()
    imported.import(cache.export())
    const fresh = { ...input, blocks: input.blocks.map((b) => ({ ...b, id: 'fresh' })) }
    expect(
      (
        await runAnalyzer(
          harper,
          fresh,
          'document',
          effectiveConfig(settings, harper.id),
          provider,
          new AbortController().signal,
          imported,
        )
      ).findings[0].replacements,
    ).toEqual(['could have', "could've"])
    const store = new SavedReviews(registry)
    expect(
      store.capture(
        input,
        hash('markdown'),
        hash('serialized'),
        'general',
        settings,
        result.findings,
        [harper.id],
      ),
    ).toBe(true)
    const saved = new SavedReviews(registry)
    saved.import(store.export())
    expect(
      saved.restore(fresh, hash('markdown'), hash('serialized'), 'general', settings)?.findings[0]
        .replacements,
    ).toEqual(['could have', "could've"])
  })
  it('rejects invalid native offsets and discards responses after cancellation', async () => {
    const input = evalSnapshot('She could of finished.')
    vi.mocked(invoke).mockResolvedValue([{ ...finding(input.blocks[0].text), offset: 0 }])
    await expect(
      runAnalyzer(
        harper,
        input,
        'document',
        defaultSettings().ai,
        provider,
        new AbortController().signal,
        new AnalysisCache(),
      ),
    ).rejects.toThrow('offset')
    const controller = new AbortController()
    vi.mocked(invoke).mockImplementation(async () => {
      controller.abort()
      return [finding(input.blocks[0].text)]
    })
    await expect(
      runAnalyzer(
        harper,
        input,
        'document',
        defaultSettings().ai,
        provider,
        controller.signal,
        new AnalysisCache(),
      ),
    ).rejects.toThrow('cancelled')
  })
})
