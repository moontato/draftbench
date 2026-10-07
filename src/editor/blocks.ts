import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'
import { hash } from '../diagnostics/hash'
import type { Block, Snapshot } from '../diagnostics/types'

// Session-stable identities. Markdown stays clean; loading content starts a new session.
// IDs survive text edits/moves; affected findings are invalidated by content hashes.
export const BlockIdentity = Extension.create({
  name: 'blockIdentity',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'codeBlock'],
        attributes: { blockId: { default: null, rendered: false } },
      },
    ]
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockIdentity'),
        appendTransaction(transactions, old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const claims = new Map<string, number[]>()
          state.doc.descendants((node, pos) => {
            if (node.isTextblock && node.attrs.blockId) {
              const id = node.attrs.blockId as string
              claims.set(id, [...(claims.get(id) ?? []), pos])
              return false
            }
          })
          const originals = new Map<string, number>()
          old.doc.descendants((node, pos) => {
            if (node.isTextblock && node.attrs.blockId) {
              originals.set(
                node.attrs.blockId as string,
                transactions.reduce(
                  (mapped, transaction) => transaction.mapping.map(mapped, 1),
                  pos,
                ),
              )
              return false
            }
          })
          const seen = new Set<string>()
          const tr = state.tr
          state.doc.descendants((node, pos) => {
            if (!node.isTextblock) return
            const id = node.attrs.blockId as string | null
            const positions = id ? claims.get(id)! : []
            const original = id ? originals.get(id) : undefined
            // Preserve the mapped existing node, not an earlier pasted clone. When
            // no original can be identified among duplicates, invalidate all claims.
            const keep =
              positions.length > 1
                ? original !== undefined && positions.includes(original)
                  ? original
                  : undefined
                : pos
            if (!id || seen.has(id) || keep !== pos) {
              const next = crypto.randomUUID()
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: next })
              seen.add(next)
            } else seen.add(id)
            return false
          })
          return tr.docChanged ? tr.setMeta('addToHistory', false) : null
        },
      }),
    ]
  },
})

export function ensureBlockIds(editor: Editor): void {
  const tr = editor.state.tr
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && !node.attrs.blockId)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: crypto.randomUUID() })
  })
  if (tr.docChanged) editor.view.dispatch(tr.setMeta('addToHistory', false))
}

export function extractBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    let text = ''
    const positions: number[] = []
    let finalPosition = pos + 1
    node.descendants((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText) {
        const value = child.text ?? ''
        for (let i = 0; i < value.length; i++) positions.push(start + i)
        text += value
        finalPosition = start + value.length
      } else if (child.type.name === 'hardBreak') {
        positions.push(start)
        text += '\n'
        finalPosition = start + 1
      }
    })
    positions.push(finalPosition)
    const resolved = doc.resolve(pos)
    const ancestors = Array.from(
      { length: resolved.depth },
      (_, index) => resolved.node(index + 1).type.name,
    )
    const headingLevel = node.type.name === 'heading' ? Number(node.attrs.level) : undefined
    blocks.push({
      id: node.attrs.blockId as string,
      type: node.type.name,
      text,
      hash: hash(JSON.stringify([node.type.name, headingLevel, ancestors, text])),
      headingLevel,
      ancestors,
      from: pos + 1,
      to: pos + node.nodeSize - 1,
      positions,
      order: blocks.length,
    })
    return false
  })
  return blocks
}
export function snapshot(editor: Editor, documentId: string, revision: number): Snapshot {
  const blocks = extractBlocks(editor.state.doc)
  const { from, to, empty } = editor.state.selection
  return {
    documentId,
    revision,
    blocks,
    hash: hash(JSON.stringify(blocks.map((b) => [b.type, b.hash]))),
    selection: empty ? undefined : { from, to },
    caret: from,
  }
}
