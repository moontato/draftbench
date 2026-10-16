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
import { refreshDiagnostic } from '../diagnostics/mapping'
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
describe('Harper and inline code', () => {
  /** Harper only ever sees masked prose, so a fixture must be built from what it received. */
  function lintMaskedText() {
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const masked = String((args as { text: string }).text)
      return masked.includes('could of') ? [finding(masked)] : []
    })
  }
  function run(input: ReturnType<typeof snapshot>, cache = new AnalysisCache()) {
    const settings = defaultSettings()
    settings.analyzers.harper.enabled = true
    return runAnalyzer(
      harper,
      input,
      'document',
      effectiveConfig(settings, harper.id),
      provider,
      new AbortController().signal,
      cache,
    )
  }
  it('masks inline code at identical length so prose keeps its real offsets', async () => {
    const ed = editor('Use `could of` inside code and she could of finished.'),
      input = snapshot(ed, 'doc', 0),
      original = input.blocks[0].text
    expect(input.blocks[0].codeRanges).toEqual([{ start: 4, end: 12 }])
    expect(input.blocks[0].formatHash).toHaveLength(64)
    lintMaskedText()
    const result = await run(input)
    const [, masked] = vi.mocked(invoke).mock.calls[0]
    expect(String((masked as { text: string }).text)).toBe(
      original.slice(0, 4) + ' '.repeat(8) + original.slice(12),
    )
    expect(String((masked as { text: string }).text).match(/could of/g)).toHaveLength(1)
    expect(result.findings).toHaveLength(1)
    const diagnostic = result.findings[0]
    expect(diagnostic.quote).toBe('could of')
    // The only remaining occurrence is the prose one, at its original index.
    expect(diagnostic.start).toBe(original.indexOf('could of', 13))
    expect(diagnostic.from).toBe(input.blocks[0].positions[diagnostic.start])
    expect(ed.state.doc.textBetween(diagnostic.from, diagnostic.to)).toBe('could of')
    expect(diagnostic.formatHash).toBe(input.blocks[0].formatHash)
    expect(result.warnings).toEqual([])
  })
  it('discards a diagnostic widened into inline code instead of reattaching it to prose', async () => {
    const ed = editor('Use `code`  and she could of finished.'),
      input = snapshot(ed, 'doc', 0),
      original = input.blocks[0].text
    expect(input.blocks[0].codeRanges).toEqual([{ start: 4, end: 8 }])
    // The adapter widens a whitespace lint one character left, here into masked code text.
    const gap = original.indexOf('  ')
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const masked = String((args as { text: string }).text)
      return [
        {
          offset: gap - 1,
          quote: masked.slice(gap - 1, gap + 2),
          category: 'harper-whitespace',
          severity: 'info',
          message: 'Unnecessary whitespace.',
          explanation: 'Use one space between words.',
          replacement: ' ',
          replacements: [' '],
          confidence: 1,
        },
      ]
    })
    const result = await run(input)
    expect(result.findings).toEqual([])
    expect(result.warnings).toEqual(['Harper skipped 1 diagnostic inside inline code.'])
  })
  it('expires Harper feedback and cache identity on a formatting-only edit without changing block hashes', async () => {
    const plain = snapshot(editor('She could of finished the report.'), 'doc', 0),
      coded = snapshot(editor('She `could of` finished the report.'), 'doc', 0)
    // The global block-hash format is untouched: identical plain text still hashes identically.
    expect(coded.blocks[0].text).toBe(plain.blocks[0].text)
    expect(coded.blocks[0].hash).toBe(plain.blocks[0].hash)
    expect(coded.blocks[0].formatHash).not.toBe(plain.blocks[0].formatHash)
    lintMaskedText()
    const cache = new AnalysisCache()
    const reviewed = await run(plain, cache)
    expect(reviewed.findings[0].formatHash).toBe('')
    expect(refreshDiagnostic(reviewed.findings[0], coded)).toBeNull()
    // The reformat must not reuse the earlier Harper result, and the masked paragraph is clean.
    const again = await run(coded, cache)
    expect(again.cacheHits).toBe(0)
    expect(again.findings).toEqual([])
    const settings = defaultSettings()
    settings.analyzers.harper.enabled = true
    const registry = createAnalyzerRegistry(settings),
      store = new SavedReviews(registry)
    expect(
      store.capture(
        plain,
        hash('markdown'),
        hash('serialized'),
        'general',
        settings,
        reviewed.findings,
        [harper.id],
      ),
    ).toBe(true)
    const saved = new SavedReviews(registry)
    saved.import(store.export())
    expect(
      saved.restore(plain, hash('markdown'), hash('serialized'), 'general', settings),
    ).not.toBeNull()
    // A saved review must not survive the reformat it was never reviewed against.
    expect(
      saved.restore(coded, hash('markdown'), hash('serialized'), 'general', settings),
    ).toBeNull()
  })
})
