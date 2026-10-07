import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { refreshDiagnostic } from '../diagnostics/mapping'
import { snapshot } from './blocks'
import type { Diagnostic } from '../diagnostics/types'
const key = new PluginKey<DecorationSet>('writingDiagnostics')
export const DiagnosticDecorations = Extension.create<{ onSelect: (id: string) => void }>({
  name: 'writingDiagnostics',
  addOptions() {
    return { onSelect: () => {} }
  },
  addProseMirrorPlugins() {
    const onSelect = this.options.onSelect
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const findings = tr.getMeta(key) as Diagnostic[] | undefined
            if (findings)
              return DecorationSet.create(
                tr.doc,
                findings.map((f) =>
                  Decoration.inline(f.from, f.to, {
                    class: `diagnostic diagnostic-${f.severity}`,
                    'data-finding': f.id,
                    title: f.message,
                  }),
                ),
              )
            // Remove on edits immediately; the app revalidates and reinstates untouched findings.
            return tr.docChanged ? DecorationSet.empty : old.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations: (state) => key.getState(state),
          handleClick(_view, _pos, event) {
            const element = (event.target as HTMLElement)?.closest('[data-finding]')
            const id = element?.getAttribute('data-finding')
            if (id) {
              onSelect(id)
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})
export function decorate(editor: Editor, findings: Diagnostic[]) {
  editor.view.dispatch(editor.state.tr.setMeta(key, findings).setMeta('addToHistory', false))
}
export function jumpTo(editor: Editor, finding: Diagnostic) {
  editor
    .chain()
    .focus()
    .setTextSelection({ from: finding.from, to: finding.to })
    .scrollIntoView()
    .run()
}
export function applyFix(
  editor: Editor,
  finding: Diagnostic,
  documentId: string,
  revision: number,
): boolean {
  if (finding.replacement === undefined || !editor.isEditable) return false
  const fresh = refreshDiagnostic(finding, snapshot(editor, documentId, revision))
  if (!fresh) return false
  const tr = editor.state.tr
  const replacement = finding.replacement.replace(/\r\n?/g, '\n')
  if (replacement.length) {
    const resolved = editor.state.doc.resolve(fresh.from)
    const marks = resolved.marks()
    const nodes: PMNode[] = []
    replacement.split('\n').forEach((line, index) => {
      if (index && editor.schema.nodes.hardBreak)
        nodes.push(editor.schema.nodes.hardBreak.create(null, null, marks))
      if (line) nodes.push(editor.schema.text(line, marks))
    })
    const fragment = Fragment.fromArray(nodes)
    tr.replaceWith(
      fresh.from,
      fresh.to,
      resolved.parent.type.validContent(fragment)
        ? fragment
        : editor.schema.text(replacement, marks),
    )
  } else tr.delete(fresh.from, fresh.to)
  editor.view.dispatch(closeHistory(tr).scrollIntoView())
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false))
  editor.commands.focus()
  return true
}
