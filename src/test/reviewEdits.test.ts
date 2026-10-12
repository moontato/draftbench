import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockIdentity, ensureBlockIds, snapshot } from '../editor/blocks'
import { applyFix } from '../editor/diagnostics'
import { ReviewEditHistory } from '../editor/reviewEdits'
import { refreshDiagnostic, resolveIssue } from '../diagnostics/mapping'
import type { Diagnostic } from '../diagnostics/types'

let editor: Editor
afterEach(() => editor?.destroy())
function review() {
  editor = new Editor({
    extensions: [StarterKit, Markdown, BlockIdentity],
    content: 'Bad one. Bad two. Bad three.\n\nBad four.',
    contentType: 'markdown',
  })
  ensureBlockIds(editor)
  let current = snapshot(editor, 'doc', 0)
  let findings = ['Bad one.', 'Bad two.', 'Bad three.', 'Bad four.'].map((quote) => {
    const block = current.blocks.find((b) => b.text.includes(quote))!
    return resolveIssue(
      {
        block_id: block.id,
        quote,
        replacement: quote.replace('Bad', 'Much better'),
        category: 'clarity',
        severity: 'suggestion',
        message: quote,
        explanation: quote,
      },
      current,
      'clarity',
      '1',
      { kind: 'ai', name: 'Test' },
      'config',
      {
        ...Object.fromEntries(current.blocks.map((b) => [b.id, b.hash])),
        $document: current.hash,
      },
    )!
  })
  const history = new ReviewEditHistory()
  editor.on('update', ({ transaction }) => {
    const next = snapshot(editor, 'doc', current.revision + 1)
    findings = history.update(findings, current, next, transaction)
    current = next
  })
  return {
    findings: () => findings,
    apply: (finding: Diagnostic) => applyFix(editor, finding, 'doc', current.revision),
    current: () => current,
  }
}
it('keeps three remaining document-wide findings and allows applying all four sequentially', () => {
  const state = review()
  const ids = state.findings().map((f) => f.id)
  for (let remaining = 3; remaining >= 0; remaining--) {
    expect(state.apply(state.findings()[0])).toBe(true)
    expect(state.findings()).toHaveLength(remaining)
    expect(state.findings().map((f) => f.id)).toEqual(ids.slice(4 - remaining))
    for (const finding of state.findings()) {
      expect(finding.contextChanged).toBe(true)
      expect(refreshDiagnostic(finding, state.current())).not.toBeNull()
    }
  }
  expect(editor.getText()).not.toContain('Bad')
})
it('preserves duplicate quotes at their mapped positions, not the first text match', () => {
  const state = review()
  const original = state.findings()[1]
  expect(state.apply({ ...state.findings()[0], replacement: 'Bad two.' })).toBe(true)
  const remaining = state.findings().find((f) => f.id === original.id)!
  expect(remaining.start).toBe('Bad two. '.length)
  expect(state.apply(remaining)).toBe(true)
  expect(editor.getText()).toContain('Bad two. Much better two.')
})
it('removes overlapping suggestions instead of rebasing them onto replacement text', () => {
  const state = review()
  const first = state.findings()[0]
  state.findings().push({ ...first, id: 'overlap' })
  expect(state.apply(first)).toBe(true)
  expect(state.findings().some((f) => f.id === 'overlap')).toBe(false)
})
it('restores an applied suggestion on Undo and removes it again on Redo', () => {
  const state = review()
  const original = state.findings()[1]
  expect(state.apply(original)).toBe(true)
  expect(state.findings()).toHaveLength(3)
  expect(editor.commands.undo()).toBe(true)
  expect(state.findings()).toHaveLength(4)
  const restored = state.findings().find((f) => f.id === original.id)!
  expect(restored.quote).toBe(original.quote)
  expect(restored.contextChanged).toBeUndefined()
  expect(refreshDiagnostic(restored, state.current())).not.toBeNull()
  expect(editor.commands.redo()).toBe(true)
  expect(state.findings()).toHaveLength(3)
  expect(state.findings().some((f) => f.id === original.id)).toBe(false)
  expect(editor.commands.undo()).toBe(true)
  expect(state.apply(state.findings().find((f) => f.id === original.id)!)).toBe(true)
  expect(state.findings()).toHaveLength(3)
})
it('restores each review state through multiple sequential undos and redos', () => {
  const state = review()
  const ids = state.findings().map((f) => f.id)
  for (let i = 0; i < 4; i++) expect(state.apply(state.findings()[0])).toBe(true)
  for (let i = 3; i >= 0; i--) {
    expect(editor.commands.undo()).toBe(true)
    expect(
      state
        .findings()
        .map((f) => f.id)
        .sort(),
    ).toEqual(ids.slice(i).sort())
  }
  for (let i = 1; i <= 4; i++) {
    expect(editor.commands.redo()).toBe(true)
    expect(
      state
        .findings()
        .map((f) => f.id)
        .sort(),
    ).toEqual(ids.slice(i).sort())
  }
})
it('does not restore applied suggestions just because manual typing recreates the old text', () => {
  const state = review()
  const original = state.findings()[0]
  expect(state.apply(original)).toBe(true)
  const block = state.current().blocks[0]
  editor.commands.insertContentAt(
    { from: block.from, to: block.from + 'Much better one.'.length },
    original.quote,
  )
  expect(state.findings().some((f) => f.id === original.id)).toBe(false)
})
it('still rejects stale fixes after an ordinary manual edit', () => {
  const state = review()
  const stale = state.findings()[0]
  editor.commands.insertContentAt(stale.from, 'Changed ')
  expect(state.findings()).toHaveLength(0)
  expect(state.apply(stale)).toBe(false)
})
