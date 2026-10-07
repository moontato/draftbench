import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { applyFix } from '../editor/diagnostics'
import { hash, canonical } from '../diagnostics/hash'
import { resolveIssue, refreshDiagnostic } from '../diagnostics/mapping'
import { readMarkdown, writeMarkdown } from '../documents/markdown'
import { SavedReviews } from '../analyzers/savedReviews'
import { analyzers, ambiguousReference } from '../analyzers/registry'
import { engineMetadata } from '../analyzers/runner'
import { defaultSettings, effectiveConfig, configurationHash } from '../settings/model'

const editors: Editor[] = []
const settings = defaultSettings()
const raw = '# Heading\n\nThis is unclear.\n\nA separate paragraph.\n'
function editor(markdown = raw) {
  const e = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Markdown, BlockIdentity],
    content: markdown,
    contentType: 'markdown',
  })
  ensureBlockIds(e)
  editors.push(e)
  return e
}
function serialization(e: Editor, markdown = raw) {
  return hash(writeMarkdown(readMarkdown(markdown), e.getMarkdown()))
}
function prepare(markdown = raw, analyzerId = 'clarity') {
  const e = editor(markdown),
    input = snapshot(e, 'doc', 0)
  const analyzer = analyzers.find((a) => a.id === analyzerId)!
  const block = input.blocks.find((b) => b.text.includes('This is unclear.'))!
  const dependencies: Record<string, string> = { [block.id]: block.hash }
  if (analyzerId === 'ambiguous-reference') {
    const neighbors = input.blocks.filter((b) => Math.abs(b.order - block.order) === 1)
    neighbors.forEach((b) => (dependencies[b.id] = b.hash))
    dependencies[`$neighbors:${block.id}`] = hash(
      JSON.stringify(neighbors.map((b) => [b.id, b.hash])),
    )
  }
  const finding = resolveIssue(
    {
      block_id: block.id,
      quote: 'This is unclear.',
      category: 'clarity',
      severity: 'warning',
      message: 'Name the proposal.',
      explanation: 'The referent is unclear.',
      replacement: 'The proposal is unclear.',
    },
    input,
    analyzerId,
    analyzer.version,
    engineMetadata(analyzer, settings.ai),
    configurationHash(effectiveConfig(settings, analyzerId)),
    dependencies,
  )!
  const store = new SavedReviews(analyzers)
  expect(
    store.capture(
      input,
      hash(markdown),
      serialization(e, markdown),
      'general',
      settings,
      [finding],
      [analyzerId],
    ),
  ).toBe(true)
  return { e, input, finding, store }
}
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
})

describe('saved review restoration', () => {
  it('round-trips persisted issues onto fresh session IDs and keeps reviewed fixes undoable', () => {
    const { store, input, finding } = prepare()
    const encoded = JSON.stringify(store.export())
    expect(encoded).not.toContain('"from":')
    expect(encoded).not.toContain('"to":')
    expect(encoded).not.toContain(finding.blockId)
    const reopened = editor(),
      current = snapshot(reopened, 'doc', 0)
    expect(current.blocks[1].id).not.toBe(input.blocks[1].id)
    const imported = new SavedReviews(analyzers)
    imported.import(JSON.parse(encoded))
    const restored = imported.restore(
      current,
      hash(raw),
      serialization(reopened),
      'general',
      settings,
    )!
    expect(restored.findings).toHaveLength(1)
    expect(restored.findings[0].blockId).toBe(current.blocks[1].id)
    expect(applyFix(reopened, restored.findings[0], 'doc', 0)).toBe(true)
    expect(reopened.getText()).toContain('The proposal is unclear.')
    reopened.commands.undo()
    expect(reopened.getText()).toContain('This is unclear.')
  })
  it('rejects a different document identity, raw file, block structure, or serialization', () => {
    const { store, input, e } = prepare()
    expect(
      store.restore(
        { ...input, documentId: 'copy' },
        hash(raw),
        serialization(e),
        'general',
        settings,
      ),
    ).toBeNull()
    expect(store.restore(input, hash(raw + '\n'), serialization(e), 'general', settings)).toBeNull()
    expect(store.restore(input, hash(raw), hash('changed markup'), 'general', settings)).toBeNull()
    const changed = snapshot(editor(raw + '\nAn unrelated external edit.\n'), 'doc', 0)
    expect(store.restore(changed, hash(raw), serialization(e), 'general', settings)).toBeNull()
  })
  it('requires unchanged analyzer version, enablement, profile, and effective AI configuration', () => {
    const { store, input, e } = prepare()
    for (const change of [
      { model: 'other' },
      { serverUrl: 'http://localhost:9999' },
      { timeoutMs: 600000 },
      { maxTokens: 4096 },
      { temperature: 0.5 },
      { credentialGeneration: 1 },
    ]) {
      expect(
        store.restore(input, hash(raw), serialization(e), 'general', {
          ...settings,
          ai: { ...settings.ai, ...change },
        }),
      ).toBeNull()
    }
    expect(store.restore(input, hash(raw), serialization(e), 'technical', settings)).toBeNull()
    expect(
      store.restore(input, hash(raw), serialization(e), 'general', {
        ...settings,
        analyzers: { ...settings.analyzers, clarity: { enabled: false, model: '' } },
      }),
    ).toBeNull()
    const upgraded = new SavedReviews(
      analyzers.map((a) => (a.id === 'clarity' ? { ...a, version: 'next' } : a)),
    )
    upgraded.import(store.export())
    expect(upgraded.restore(input, hash(raw), serialization(e), 'general', settings)).toBeNull()
    expect(
      store.restore(input, hash(raw), serialization(e), 'general', {
        ...settings,
        editor: { ...settings.editor, fontSize: 20 },
      }),
    ).not.toBeNull()
  })
  it('restores neighboring dependency fingerprints against the new session', () => {
    const { store } = prepare(raw, ambiguousReference.id)
    const e = editor(),
      current = snapshot(e, 'doc', 0)
    const finding = store.restore(current, hash(raw), serialization(e), 'general', settings)!
      .findings[0]
    expect(refreshDiagnostic(finding, current)).not.toBeNull()
    e.commands.insertContentAt(current.blocks[2].from, 'Changed ')
    expect(refreshDiagnostic(finding, snapshot(e, 'doc', 1))).toBeNull()
  })
  it('retains successful zero-finding reviews and refuses stale captured diagnostics', () => {
    const { store, input, e, finding } = prepare()
    expect(
      store.capture(input, hash(raw), serialization(e), 'general', settings, [], ['clarity']),
    ).toBe(true)
    expect(
      store.restore(input, hash(raw), serialization(e), 'general', settings)?.findings,
    ).toEqual([])
    e.commands.insertContentAt(input.blocks[1].from, 'Changed ')
    expect(
      store.capture(
        snapshot(e, 'doc', 1),
        hash(raw),
        serialization(e),
        'general',
        settings,
        [finding],
        ['clarity'],
      ),
    ).toBe(false)
  })
  it('handles an exact saved selection even when the quote repeats elsewhere in the same block', () => {
    const text = 'This is unclear. Again: This is unclear.',
      e = editor(text),
      input = snapshot(e, 'doc', 0),
      block = input.blocks[0]
    const start = block.text.lastIndexOf('This is unclear.')
    input.selection = { from: block.positions[start], to: block.positions[start + 16] }
    const analyzer = analyzers.find((a) => a.id === 'clarity')!
    const finding = resolveIssue(
      {
        block_id: block.id,
        quote: 'This is unclear.',
        category: 'clarity',
        severity: 'warning',
        message: 'Unclear.',
        explanation: 'Name it.',
      },
      input,
      analyzer.id,
      analyzer.version,
      engineMetadata(analyzer, settings.ai),
      hash(canonical(settings.ai)),
      { [block.id]: block.hash },
    )!
    const store = new SavedReviews(analyzers)
    expect(
      store.capture(
        input,
        hash(text),
        serialization(e, text),
        'general',
        settings,
        [finding],
        ['clarity'],
      ),
    ).toBe(true)
    const currentEditor = editor(text),
      current = snapshot(currentEditor, 'doc', 0)
    const restored = store.restore(
      current,
      hash(text),
      serialization(currentEditor, text),
      'general',
      settings,
    )!
    expect(restored.findings[0].start).toBe(start)
  })
  it('rebinds a normalized save only if the analyzed editor content is unchanged', () => {
    const markdown = 'Heading\n=======\n\nThis is unclear.\n',
      { store, e, input } = prepare(markdown)
    const serialized = serialization(e, markdown)
    expect(serialized).not.toBe(hash(markdown))
    store.confirmSave(input, serialized, hash(markdown), serialized)
    expect(store.restore(input, serialized, serialized, 'general', settings)).not.toBeNull()
    const { store: untouched } = prepare(markdown)
    untouched.confirmSave(input, hash('changed editor'), hash(markdown), hash('changed editor'))
    expect(
      untouched.restore(input, hash('changed editor'), hash('changed editor'), 'general', settings),
    ).toBeNull()
  })
  it('clears/deletes reviews and rejects corrupt metadata instead of guessing', () => {
    const { store, input, e } = prepare()
    expect(() => store.import({ version: 999, reviews: [] })).toThrow('corrupt')
    store.delete('doc')
    expect(store.restore(input, hash(raw), serialization(e), 'general', settings)).toBeNull()
    const other = prepare().store
    other.clear()
    expect((other.export() as { reviews: unknown[] }).reviews).toHaveLength(0)
  })
})
