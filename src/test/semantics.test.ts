import { describe, expect, it, vi } from 'vitest'
import { ambiguousReference, redundancy, structure, analyzers } from '../analyzers/registry'
import { clarity, validateResult } from '../analyzers/llm/semantic'
import { planScope, runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { hash } from '../diagnostics/hash'
import { refreshDiagnostic } from '../diagnostics/mapping'
import type { Block, Snapshot } from '../diagnostics/types'
import type { AIProvider } from '../ai/types'
import { defaultSettings } from '../settings/model'
function snapshot(texts: string[]): Snapshot {
  let position = 1
  const blocks: Block[] = texts.map((text, order) => {
    const from = position
    position += text.length + 2
    return {
      id: `b${order}`,
      type: 'paragraph',
      text,
      hash: hash(text),
      from,
      to: from + text.length,
      positions: Array.from({ length: text.length + 1 }, (_, index) => from + index),
      order,
    }
  })
  return { documentId: 'doc', revision: 0, hash: hash(texts.join('\n\n')), blocks }
}
function provider(): AIProvider {
  return {
    testConnection: vi.fn(),
    listModels: vi.fn(),
    completeStructured: vi.fn(async (request) => {
      const target = JSON.parse(request.user).targets[0]
      return {
        issues: [
          {
            block_id: target.block_id,
            quote: target.text,
            category: 'review',
            severity: 'suggestion',
            message: 'Review this relationship.',
            explanation: 'The relationship between ideas could be made explicit.',
            replacement: null,
            confidence: 0.8,
          },
        ],
      }
    }),
  }
}
const config = defaultSettings().ai

describe('semantic analyzer family and scope', () => {
  it('registers four AI reviewers and one deterministic reviewer with one interface', async () => {
    expect(analyzers.filter((a) => a.engine === 'ai')).toHaveLength(4)
    const input = snapshot(['First point.', 'This is unclear.', 'A concluding point.'])
    for (const analyzer of [clarity, ambiguousReference, redundancy, structure]) {
      const result = await runAnalyzer(
        analyzer,
        input,
        'document',
        config,
        provider(),
        new AbortController().signal,
        new AnalysisCache(),
      )
      expect(result.findings.length).toBeGreaterThan(0)
      expect(
        result.findings.every((f) => f.analyzerId === analyzer.id && f.engine.kind === 'ai'),
      ).toBe(true)
    }
  })
  it('includes bounded neighboring context for reference checks, not the entire document', () => {
    const input = snapshot(['One.', 'Two.', 'Three.', 'Four.', 'Five.'])
    input.caret = input.blocks[2].from
    const units = planScope(ambiguousReference, input, 'block')
    expect(units).toHaveLength(1)
    expect(units[0].targets.map((b) => b.text)).toEqual(['Three.'])
    expect(units[0].context.map((b) => b.text)).toEqual(['Two.', 'Four.'])
    expect(planScope(clarity, input, 'block')[0].context).toHaveLength(0)
  })
  it('rejects selection scope for document-only reviewers, without contacting a model', async () => {
    const input = snapshot(['One.', 'Two.'])
    input.selection = { from: 1, to: 3 }
    const mock = provider()
    for (const analyzer of [redundancy, structure])
      await expect(
        runAnalyzer(
          analyzer,
          input,
          'selection',
          config,
          mock,
          new AbortController().signal,
          new AnalysisCache(),
        ),
      ).rejects.toThrow('requires document')
    expect(mock.completeStructured).not.toHaveBeenCalled()
  })
  it('does not let an active selection accidentally constrain document review', async () => {
    const input = snapshot(['One.', 'Two.'])
    input.selection = { from: 1, to: 3 }
    expect(
      (
        await runAnalyzer(
          clarity,
          input,
          'document',
          config,
          provider(),
          new AbortController().signal,
          new AnalysisCache(),
        )
      ).findings,
    ).toHaveLength(2)
  })
  it('invalidates references when neighboring blocks move, even when text remains unchanged', async () => {
    const input = snapshot(['Antecedent.', 'They did it.', 'Afterward.'])
    input.caret = input.blocks[1].from
    const finding = (
      await runAnalyzer(
        ambiguousReference,
        input,
        'block',
        config,
        provider(),
        new AbortController().signal,
        new AnalysisCache(),
      )
    ).findings[0]
    expect(refreshDiagnostic(finding, input)).not.toBeNull()
    const moved = {
      ...input,
      blocks: [input.blocks[1], input.blocks[0], input.blocks[2]].map((block, order) => ({
        ...block,
        order,
      })),
    }
    expect(refreshDiagnostic(finding, moved)).toBeNull()
  })
  it('invalidates document-scope findings when any document dependency changes', async () => {
    const input = snapshot(['One.', 'Two.'])
    const finding = (
      await runAnalyzer(
        structure,
        input,
        'document',
        config,
        provider(),
        new AbortController().signal,
        new AnalysisCache(),
      )
    ).findings[0]
    expect(refreshDiagnostic(finding, input)).not.toBeNull()
    expect(refreshDiagnostic(finding, { ...input, hash: 'changed' })).toBeNull()
  })
  it('never silently truncates oversized inputs', async () => {
    const input = snapshot(['A'.repeat(48001)]),
      mock = provider()
    const result = await runAnalyzer(
      structure,
      input,
      'document',
      config,
      mock,
      new AbortController().signal,
      new AnalysisCache(),
    )
    expect(result.findings).toHaveLength(0)
    expect(result.warnings[0]).toContain('exceeds')
    expect(mock.completeStructured).not.toHaveBeenCalled()
  })
  it('cancels late results before inserting anything into the cache', async () => {
    const input = snapshot(['One.']),
      mock = provider(),
      controller = new AbortController(),
      cache = new AnalysisCache()
    vi.mocked(mock.completeStructured).mockImplementationOnce(async () => {
      controller.abort()
      return { issues: [] }
    })
    await expect(
      runAnalyzer(clarity, input, 'document', config, mock, controller.signal, cache),
    ).rejects.toThrow('cancelled')
    const result = await runAnalyzer(
      clarity,
      input,
      'document',
      config,
      mock,
      new AbortController().signal,
      cache,
    )
    expect(result.cacheHits).toBe(0)
  })
  it('makes no provider requests for empty documents and preserves code as non-target context', async () => {
    const server = provider()
    expect(
      (
        await runAnalyzer(
          structure,
          snapshot(['']),
          'document',
          config,
          server,
          new AbortController().signal,
          new AnalysisCache(),
        )
      ).requests,
    ).toBe(0)
    expect(server.completeStructured).not.toHaveBeenCalled()
    const input = snapshot(['Introduction.', 'return value;', 'Conclusion.'])
    input.blocks[1].type = 'codeBlock'
    input.caret = input.blocks[0].from
    const unit = planScope(structure, input, 'document')[0]
    expect(unit.targets).toHaveLength(2)
    expect(unit.context[0].type).toBe('codeBlock')
    expect(planScope(ambiguousReference, input, 'block')[0].context[0].type).toBe('codeBlock')
    const cache = new AnalysisCache(),
      before = cache.key(structure, unit, config)
    const moved = {
      ...input,
      blocks: [input.blocks[1], input.blocks[0], input.blocks[2]].map((block, order) => ({
        ...block,
        order,
      })),
    }
    expect(cache.key(structure, planScope(structure, moved, 'document')[0], config)).not.toBe(
      before,
    )
  })
  it('changes identity when context changes and rejects broken Unicode suggestions', async () => {
    const server = provider(),
      cache = new AnalysisCache()
    const old = await runAnalyzer(
      ambiguousReference,
      snapshot(['The editor spoke.', 'They were late.']),
      'document',
      config,
      server,
      new AbortController().signal,
      cache,
    )
    const next = await runAnalyzer(
      ambiguousReference,
      snapshot(['Two editors spoke.', 'They were late.']),
      'document',
      config,
      server,
      new AbortController().signal,
      cache,
    )
    expect(next.findings.find((f) => f.blockId === 'b1')!.id).not.toBe(
      old.findings.find((f) => f.blockId === 'b1')!.id,
    )
    const valid = {
      block_id: 'b0',
      quote: 'The editor spoke.',
      category: 'review',
      severity: 'suggestion',
      message: 'Review this.',
      explanation: 'A relationship.',
      replacement: null,
    }
    const parsed = validateResult({
      issues: [valid, { ...valid, replacement: '\uD83D' }, { ...valid, quote: ' ' }],
    })
    expect(parsed.issues).toHaveLength(1)
    expect(parsed.warnings).toHaveLength(2)
  })
  it('rejects corrupt cache metadata', () => {
    expect(() => new AnalysisCache().import({ version: 999, entries: [] })).toThrow('corrupt')
  })
})
