import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { applyFix } from '../editor/diagnostics'
import { refreshDiagnostic, resolveIssue } from '../diagnostics/mapping'
import { clarity, validateResult } from '../analyzers/llm/semantic'
import { repeatedWord } from '../analyzers/builtin/repeatedWord'
import { runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { defaultSettings, effectiveConfig } from '../settings/model'
import type { AIProvider } from '../ai/types'
import { readMarkdown, writeMarkdown } from '../documents/markdown'
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
const issue = (block_id: string, quote = 'This is unclear.'): Issue => ({
  block_id,
  quote,
  category: 'clarity',
  severity: 'warning',
  message: 'The relationship is unclear.',
  explanation: 'The reader cannot identify the relationship.',
  replacement: 'The proposal is unclear.',
  confidence: 0.8,
})
const mockProvider = (): AIProvider => ({
  testConnection: vi.fn(),
  listModels: vi.fn(),
  completeStructured: vi.fn(async (request) => {
    const input = JSON.parse(request.user)
    return {
      issues: input.targets[0].text.includes('This is unclear.')
        ? [issue(input.targets[0].block_id)]
        : [],
    }
  }),
})
const config = effectiveConfig(defaultSettings(), 'clarity')

describe('structured reviewer output', () => {
  it('accepts valid and empty results', () => {
    expect(validateResult({ issues: [issue('b')] }).issues).toHaveLength(1)
    expect(validateResult({ issues: [] }).issues).toHaveLength(0)
  })
  it('rejects invalid envelopes and drops malformed individual issues', () => {
    expect(() => validateResult({ prose: 'Bad writing.' })).toThrow()
    expect(() => validateResult({ issues: Array(13).fill(issue('b')) })).toThrow()
    const result = validateResult({
      issues: [
        { ...issue('b'), confidence: 2 },
        { ...issue('b'), severity: 'critical' },
        issue('b'),
      ],
    })
    expect(result.issues).toHaveLength(1)
    expect(result.warnings).toHaveLength(2)
  })
})
describe('block mapping and lifecycle', () => {
  it('maps quotes through marks, links, hard breaks, and UTF-16 emoji', () => {
    const e = editor('An **important** [proposal](https://example.org) 😀.\n\nSecond line.')
    const s = snapshot(e, 'doc', 0)
    const block = s.blocks[0]
    const finding = resolveIssue(
      issue(block.id, 'proposal'),
      s,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'config',
      {},
    )!
    expect(e.state.doc.textBetween(finding.from, finding.to)).toBe('proposal')
    const emoji = resolveIssue(
      issue(block.id, '😀'),
      s,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'config',
      {},
    )!
    expect(emoji.to - emoji.from).toBe(2)
    e.commands.setContent('First  \nsecond', { contentType: 'markdown' })
    ensureBlockIds(e)
    const hard = snapshot(e, 'doc', 1),
      h = hard.blocks[0]
    expect(h.text).toContain('\n')
    const f = resolveIssue(
      issue(h.id, 'second'),
      hard,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'config',
      {},
    )!
    expect(e.state.doc.textBetween(f.from, f.to)).toBe('second')
  })
  it('maps quotes in nested lists and block quotes, and invalidates changed block types', () => {
    const e = editor('# Heading\n\n- First point\n  - **Second** point\n\n> Quoted point')
    const s = snapshot(e, 'doc', 0)
    for (const quote of ['Second', 'Quoted point']) {
      const block = s.blocks.find((b) => b.text.includes(quote))!
      const finding = resolveIssue(
        issue(block.id, quote),
        s,
        'clarity',
        '1',
        { kind: 'ai', name: 'Mock' },
        'cfg',
        {},
      )!
      expect(e.state.doc.textBetween(finding.from, finding.to)).toBe(quote)
      expect(block.ancestors?.length).toBeGreaterThan(0)
    }
    const paragraphEditor = editor('This is unclear.'),
      before = snapshot(paragraphEditor, 'doc', 0)
    const finding = resolveIssue(
      issue(before.blocks[0].id),
      before,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'cfg',
      {},
    )!
    paragraphEditor.commands.setTextSelection(1)
    paragraphEditor.commands.setHeading({ level: 2 })
    expect(snapshot(paragraphEditor, 'doc', 1).blocks[0].headingLevel).toBe(2)
    expect(refreshDiagnostic(finding, snapshot(paragraphEditor, 'doc', 1))).toBeNull()
  })
  it('uses trusted editor selection bounds to disambiguate an otherwise repeated quote', () => {
    const e = editor('This is unclear. Again: This is unclear.'),
      before = snapshot(e, 'doc', 0),
      block = before.blocks[0]
    const start = block.text.lastIndexOf('This is unclear.')
    e.commands.setTextSelection({ from: block.positions[start], to: block.positions[start + 16] })
    const selected = snapshot(e, 'doc', 1)
    const finding = resolveIssue(
      issue(block.id),
      selected,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'cfg',
      {},
    )!
    expect(finding.from).toBe(block.positions[start])
    const emoji = snapshot(editor('😀'), 'doc', 0)
    expect(
      resolveIssue(
        issue(emoji.blocks[0].id, '\uD83D'),
        emoji,
        'clarity',
        '1',
        { kind: 'ai', name: 'Mock' },
        'cfg',
        {},
      ),
    ).toBeNull()
  })
  it('does not let a pasted clone steal the original block identity', () => {
    const e = editor('This is unclear.'),
      before = snapshot(e, 'doc', 0),
      original = before.blocks[0]
    const finding = resolveIssue(
      issue(original.id),
      before,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'cfg',
      {},
    )!
    e.commands.insertContentAt(0, {
      type: 'paragraph',
      attrs: { blockId: original.id },
      content: [{ type: 'text', text: original.text }],
    })
    const after = snapshot(e, 'doc', 1)
    expect(after.blocks[0].id).not.toBe(original.id)
    expect(after.blocks[1].id).toBe(original.id)
    expect(refreshDiagnostic(finding, after)?.from).toBe(after.blocks[1].from)
  })
  it('rejects absent, nonunique, and unknown-block quotes', () => {
    const s = snapshot(editor('A point. A point.'), 'doc', 0)
    for (const candidate of [
      issue('unknown', 'A point.'),
      issue(s.blocks[0].id, 'missing'),
      issue(s.blocks[0].id, 'A point.'),
    ])
      expect(
        resolveIssue(candidate, s, 'clarity', '1', { kind: 'ai', name: 'Mock' }, 'config', {}),
      ).toBeNull()
  })
  it('retains IDs through text edits, invalidates the source, and keeps unrelated findings', () => {
    const e = editor('This is unclear.\n\nAnother point.')
    const before = snapshot(e, 'doc', 0)
    const finding = resolveIssue(
      issue(before.blocks[0].id),
      before,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'config',
      { [before.blocks[0].id]: before.blocks[0].hash },
    )!
    e.commands.insertContentAt(before.blocks[1].from, 'New ')
    const unrelated = snapshot(e, 'doc', 1)
    expect(unrelated.blocks[0].id).toBe(before.blocks[0].id)
    expect(refreshDiagnostic(finding, unrelated)).not.toBeNull()
    e.commands.insertContentAt(before.blocks[0].from, 'Changed ')
    const changed = snapshot(e, 'doc', 2)
    expect(changed.blocks[0].id).toBe(before.blocks[0].id)
    expect(refreshDiagnostic(finding, changed)).toBeNull()
  })
  it('invalidates on context changes, document switches, and reloads', () => {
    const e = editor('This is unclear.\n\nOther context.')
    const before = snapshot(e, 'doc', 0)
    const finding = resolveIssue(
      issue(before.blocks[0].id),
      before,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'config',
      { [before.blocks[1].id]: before.blocks[1].hash },
    )!
    e.commands.insertContentAt(before.blocks[1].from, 'New ')
    expect(refreshDiagnostic(finding, snapshot(e, 'doc', 1))).toBeNull()
    expect(refreshDiagnostic(finding, snapshot(e, 'other-doc', 1))).toBeNull()
    expect(
      refreshDiagnostic(finding, snapshot(editor('This is unclear.\n\nOther context.'), 'doc', 0)),
    ).toBeNull()
  })
  it('assigns unique IDs to split and pasted duplicate blocks', () => {
    const e = editor('First paragraph.')
    const original = snapshot(e, 'doc', 0).blocks[0]
    e.commands.setTextSelection(original.from + 5)
    e.commands.splitBlock()
    const split = snapshot(e, 'doc', 1)
    expect(new Set(split.blocks.map((b) => b.id)).size).toBe(2)
    e.commands.insertContentAt(e.state.doc.content.size, e.getJSON().content![0])
    const pasted = snapshot(e, 'doc', 2)
    expect(new Set(pasted.blocks.map((b) => b.id)).size).toBe(pasted.blocks.length)
  })
})
describe('Clarity vertical slice', () => {
  it('write → analyze → inspect → apply → undo/redo', async () => {
    const e = editor('This is unclear.')
    const s = snapshot(e, 'doc', 0),
      provider = mockProvider()
    const result = await runAnalyzer(
      clarity,
      s,
      'document',
      config,
      provider,
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].engine.model).toBe('qwen3-8b')
    expect(result.findings[0].explanation).toContain('relationship')
    expect(e.getText()).toBe('This is unclear.') // Review never rewrites silently.
    expect(applyFix(e, result.findings[0], 'doc', 0)).toBe(true)
    expect(e.getText()).toBe('The proposal is unclear.')
    expect(e.commands.undo()).toBe(true)
    expect(e.getText()).toBe('This is unclear.')
    expect(e.commands.redo()).toBe(true)
    expect(e.getText()).toBe('The proposal is unclear.')
  })
  it('undoing a fix does not undo recent author typing', async () => {
    const e = editor('')
    e.commands.insertContent('This is unclear.')
    const result = await runAnalyzer(
      clarity,
      snapshot(e, 'doc', 1),
      'document',
      config,
      mockProvider(),
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(applyFix(e, result.findings[0], 'doc', 1)).toBe(true)
    e.commands.undo()
    expect(e.getText()).toBe('This is unclear.')
    e.commands.undo()
    expect(e.getText()).toBe('')
  })
  it('refuses to apply a stale fix or accept late results after source edits', async () => {
    const e = editor('This is unclear.')
    const s = snapshot(e, 'doc', 0)
    const result = await runAnalyzer(
      clarity,
      s,
      'document',
      config,
      mockProvider(),
      new AbortController().signal,
      new AnalysisCache(),
    )
    e.commands.insertContentAt(1, 'Now ')
    expect(refreshDiagnostic(result.findings[0], snapshot(e, 'doc', 1))).toBeNull()
    expect(applyFix(e, result.findings[0], 'doc', 1)).toBe(false)
  })
  it('applies multiline plain-text fixes as line breaks, not generated rich markup', async () => {
    const e = editor('This is unclear.'),
      s = snapshot(e, 'doc', 0)
    const finding = resolveIssue(
      {
        ...issue(s.blocks[0].id),
        replacement: 'The proposal is unclear.\nReview <this> carefully.',
      },
      s,
      'clarity',
      '1',
      { kind: 'ai', name: 'Mock' },
      'cfg',
      {},
    )!
    expect(applyFix(e, finding, 'doc', 0)).toBe(true)
    expect(snapshot(e, 'doc', 1).blocks).toHaveLength(1)
    expect(snapshot(e, 'doc', 1).blocks[0].text).toBe(
      'The proposal is unclear.\nReview <this> carefully.',
    )
    e.commands.undo()
    expect(e.getText()).toBe('This is unclear.')
  })
  it('uses paragraph-sized requests and filters selection scope', async () => {
    const e = editor('This is unclear.\n\nOther paragraph.')
    const s = snapshot(e, 'doc', 0),
      provider = mockProvider()
    await runAnalyzer(
      clarity,
      s,
      'document',
      config,
      provider,
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(provider.completeStructured).toHaveBeenCalledTimes(2)
    e.commands.setTextSelection({ from: 1, to: 5 })
    const selected = snapshot(e, 'doc', 1)
    const selectionResult = await runAnalyzer(
      clarity,
      selected,
      'selection',
      config,
      provider,
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(selectionResult.findings).toHaveLength(0)
    const latest = vi.mocked(provider.completeStructured).mock.calls.at(-1)![0]
    expect(JSON.parse(latest.user).targets[0].text).toBe('This')
  })
})
describe('cache and model inheritance', () => {
  it('inherits the default and normalizes blank overrides', () => {
    const settings = defaultSettings()
    expect(effectiveConfig(settings, 'clarity').model).toBe('qwen3-8b')
    settings.analyzers.clarity.model = '  '
    expect(effectiveConfig(settings, 'clarity').model).toBe('qwen3-8b')
    settings.analyzers.clarity.model = 'qwen3-14b'
    expect(effectiveConfig(settings, 'clarity').model).toBe('qwen3-14b')
    expect(effectiveConfig(settings, 'structure').model).toBe('qwen3-8b')
  })
  it('reuses identical and zero-finding results, invalidates on model/source changes', async () => {
    const e = editor('This is unclear.\n\nOther paragraph.'),
      provider = mockProvider(),
      cache = new AnalysisCache(),
      signal = new AbortController().signal
    const s = snapshot(e, 'doc', 0)
    await runAnalyzer(clarity, s, 'document', config, provider, signal, cache)
    const cached = await runAnalyzer(clarity, s, 'document', config, provider, signal, cache)
    expect(cached.cacheHits).toBe(2)
    expect(provider.completeStructured).toHaveBeenCalledTimes(2)
    await runAnalyzer(
      clarity,
      s,
      'document',
      { ...config, model: 'other-model' },
      provider,
      signal,
      cache,
    )
    expect(provider.completeStructured).toHaveBeenCalledTimes(4)
    e.commands.insertContentAt(s.blocks[1].from, 'Changed ')
    const after = await runAnalyzer(
      clarity,
      snapshot(e, 'doc', 1),
      'document',
      config,
      provider,
      signal,
      cache,
    )
    expect(after.cacheHits).toBe(1)
    expect(provider.completeStructured).toHaveBeenCalledTimes(5)
    const restored = new AnalysisCache()
    restored.import(cache.export())
    expect(
      (
        await runAnalyzer(
          clarity,
          snapshot(e, 'doc', 1),
          'document',
          config,
          provider,
          signal,
          restored,
        )
      ).cacheHits,
    ).toBe(2)
  })
  it('does not cache malformed or failed requests', async () => {
    const provider = mockProvider(),
      cache = new AnalysisCache(),
      s = snapshot(editor('This is unclear.'), 'doc', 0)
    vi.mocked(provider.completeStructured).mockResolvedValue({ issues: [{ invalid: true }] })
    for (let i = 0; i < 2; i++)
      await runAnalyzer(
        clarity,
        s,
        'document',
        config,
        provider,
        new AbortController().signal,
        cache,
      )
    expect(provider.completeStructured).toHaveBeenCalledTimes(2)
    vi.mocked(provider.completeStructured).mockRejectedValue(new Error('Unreachable'))
    await expect(
      runAnalyzer(clarity, s, 'document', config, provider, new AbortController().signal, cache),
    ).rejects.toThrow('Unreachable')
  })
})
describe('local rules and Markdown', () => {
  it('runs a deterministic analyzer in the same system', async () => {
    const s = snapshot(
      editor('The the proposal.\n\nShe had had enough.\n\n```\nthe the code\n```'),
      'doc',
      0,
    )
    const result = await runAnalyzer(
      repeatedWord,
      s,
      'document',
      config,
      mockProvider(),
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].engine.kind).toBe('deterministic')
  })
  it('maps repeated identical rule findings and Unicode words without LLM offsets', async () => {
    const s = snapshot(editor('the the point, and the the result.\n\nÉté été.'), 'doc', 0)
    const cache = new AnalysisCache()
    const result = await runAnalyzer(
      repeatedWord,
      s,
      'document',
      config,
      mockProvider(),
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(result.findings).toHaveLength(3)
    expect(new Set(result.findings.map((f) => f.id)).size).toBe(3)
    // Re-encode with indexed block references, preserving trusted local-rule offsets.
    const unit = { targets: s.blocks, context: [], documentScope: false }
    cache.set('0'.repeat(64), unit, {
      issues: result.findings.map((f) => ({ ...f, block_id: f.blockId, offset: f.start })),
      warnings: [],
    })
    const restored = new AnalysisCache()
    restored.import(cache.export())
    expect(restored.get('0'.repeat(64), unit)?.issues.map((i) => i.offset)).toEqual(
      result.findings.map((f) => f.start),
    )
  })
  it('round trips supported prose without leaking internal IDs', () => {
    const source =
      '# Heading\n\nA **bold**, *gentle* [link](https://example.org) with `code`.\n\n> A quotation.\n\n- First\n- Second\n\n1. One\n2. Two\n\n```ts\nconst x = 1\n```\n'
    const e = editor(source),
      serialized = e.getMarkdown(),
      reloaded = editor(serialized)
    expect(reloaded.getText()).toBe(e.getText())
    expect(serialized).not.toContain('blockId')
    expect(serialized).toContain('**bold**')
    expect(serialized).toContain('```ts')
  })
  it('preserves frontmatter/newlines and detects unsupported content', () => {
    const file = readMarkdown('---\r\ntitle: Essay\r\n---\r\n\r\nBody.\r\n')
    expect(writeMarkdown(file, 'Changed.')).toBe('---\r\ntitle: Essay\r\n---\r\nChanged.\r\n')
    for (const source of [
      '<div>HTML</div>',
      '| a | b |\n| - | - |\n| c | d |',
      '![remote](https://host/img.png)',
      '- [ ] todo',
      '[^1]: footnote',
    ])
      expect(readMarkdown(source).unsupported.length).toBeGreaterThan(0)
    expect(readMarkdown('```html\n<div>Code</div>\n```').unsupported).toHaveLength(0)
    expect(readMarkdown('```md\n[^1]: literal code\n```').unsupported).toHaveLength(0)
    expect(readMarkdown('Use `[^1]` as literal code.').unsupported).toHaveLength(0)
    expect(writeMarkdown(readMarkdown('\uFEFF---\ntitle: Essay\n---\nBody.'), 'Changed.')).toBe(
      '\uFEFF---\ntitle: Essay\n---\nChanged.\n',
    )
  })
})
