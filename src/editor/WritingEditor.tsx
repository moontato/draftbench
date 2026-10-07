import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Code,
  Link as LinkIcon,
  Undo2,
  Redo2,
  SquareCode,
} from 'lucide-react'
import { BlockIdentity, ensureBlockIds } from './blocks'
import { DiagnosticDecorations } from './diagnostics'
import type { Settings } from '../settings/model'
interface Props {
  content: string
  readOnly: boolean
  settings: Settings['editor']
  onReady: (editor: Editor) => void
  onChange: (editor: Editor) => void
  onFinding: (id: string) => void
  askLink: () => Promise<string | null>
}
export function WritingEditor({
  content,
  readOnly,
  settings,
  onReady,
  onChange,
  onFinding,
  askLink,
}: Props) {
  const callbacks = useRef({ onReady, onChange, onFinding })
  callbacks.current = { onReady, onChange, onFinding }
  const initialized = useRef(false)
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          link: { openOnClick: false, autolink: false, protocols: ['http', 'https', 'mailto'] },
        }),
        Markdown,
        BlockIdentity,
        DiagnosticDecorations.configure({ onSelect: (id) => callbacks.current.onFinding(id) }),
      ],
      content,
      contentType: 'markdown',
      editable: !readOnly,
      shouldRerenderOnTransaction: true,
      editorProps: {
        attributes: {
          class: 'prose',
          'aria-label': 'Document writing editor',
          spellcheck: String(settings.spellcheck),
        },
      },
      onCreate: ({ editor }) => {
        ensureBlockIds(editor)
        initialized.current = true
        callbacks.current.onReady(editor)
      },
      onUpdate: ({ editor, transaction }) => {
        if (initialized.current && transaction.docChanged) callbacks.current.onChange(editor)
      },
    },
    [],
  )
  useEffect(() => {
    editor?.setEditable(!readOnly)
    editor?.setOptions({
      editorProps: {
        attributes: {
          class: 'prose',
          'aria-label': 'Document writing editor',
          spellcheck: String(settings.spellcheck),
        },
      },
    })
  }, [editor, readOnly, settings.spellcheck])
  const link = async () => {
    if (!editor) return
    const value = await askLink()
    if (value === null) return
    if (!value.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    if (!/^(https?:\/\/|mailto:)/i.test(value)) return
    editor.chain().focus().extendMarkRange('link').setLink({ href: value }).run()
  }
  if (!editor) return null
  const btn = (label: string, icon: React.ReactNode, action: () => void, active = false) => (
    <button
      type="button"
      className={`icon-button ${active ? 'active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={readOnly}
      onClick={action}
    >
      {icon}
    </button>
  )
  return (
    <>
      <div className="format-toolbar">
        <select
          aria-label="Paragraph style"
          disabled={readOnly}
          value={
            editor.isActive('heading', { level: 1 })
              ? '1'
              : editor.isActive('heading', { level: 2 })
                ? '2'
                : editor.isActive('heading', { level: 3 })
                  ? '3'
                  : 'p'
          }
          onChange={(event) =>
            event.target.value === 'p'
              ? editor.chain().focus().setParagraph().run()
              : editor
                  .chain()
                  .focus()
                  .toggleHeading({ level: Number(event.target.value) as 1 | 2 | 3 })
                  .run()
          }
        >
          <option value="p">Paragraph</option>
          <option value="1">Heading 1</option>
          <option value="2">Heading 2</option>
          <option value="3">Heading 3</option>
        </select>
        <span className="toolbar-divider" />
        {btn(
          'Bold',
          <Bold size={16} />,
          () => {
            editor.chain().focus().toggleBold().run()
          },
          editor.isActive('bold'),
        )}
        {btn(
          'Italic',
          <Italic size={16} />,
          () => {
            editor.chain().focus().toggleItalic().run()
          },
          editor.isActive('italic'),
        )}
        {btn(
          'Link',
          <LinkIcon size={16} />,
          () => {
            void link()
          },
          editor.isActive('link'),
        )}
        <span className="toolbar-divider" />
        {btn(
          'Bullet list',
          <List size={17} />,
          () => {
            editor.chain().focus().toggleBulletList().run()
          },
          editor.isActive('bulletList'),
        )}
        {btn(
          'Numbered list',
          <ListOrdered size={17} />,
          () => {
            editor.chain().focus().toggleOrderedList().run()
          },
          editor.isActive('orderedList'),
        )}
        {btn(
          'Block quote',
          <Quote size={16} />,
          () => {
            editor.chain().focus().toggleBlockquote().run()
          },
          editor.isActive('blockquote'),
        )}
        {btn(
          'Inline code',
          <Code size={16} />,
          () => {
            editor.chain().focus().toggleCode().run()
          },
          editor.isActive('code'),
        )}
        {btn(
          'Code block',
          <SquareCode size={16} />,
          () => {
            editor.chain().focus().toggleCodeBlock().run()
          },
          editor.isActive('codeBlock'),
        )}
        <span className="toolbar-spacer" />
        {btn('Undo', <Undo2 size={16} />, () => {
          editor.chain().focus().undo().run()
        })}
        {btn('Redo', <Redo2 size={16} />, () => {
          editor.chain().focus().redo().run()
        })}
      </div>
      <div
        className="editor-scroll"
        style={{ '--prose-size': `${settings.fontSize}px` } as React.CSSProperties}
      >
        <EditorContent editor={editor} />
      </div>
    </>
  )
}
