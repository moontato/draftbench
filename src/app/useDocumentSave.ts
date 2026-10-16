import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { Editor } from '@tiptap/core'
import type { AnalysisCache } from '../analyzers/cache'
import type { AnalysisHistory } from '../analyzers/history'
import type { FeedbackSnapshots } from '../analyzers/feedbackSnapshots'
import type { SavedReviews } from '../analyzers/savedReviews'
import { hash } from '../diagnostics/hash'
import type { Diagnostic, Snapshot } from '../diagnostics/types'
import { readMarkdown, writeMarkdown } from '../documents/markdown'
import { snapshot } from '../editor/blocks'
import type { ProfileId } from '../profiles/profiles'
import { errorMessage, storage, type Project } from '../storage/desktop'
import type { Settings } from '../settings/model'
import type { Holder } from './useFindingsView'
import type { ProjectMeta, Session } from './workspaceTypes'

export interface SaveStores {
  cache: Holder<AnalysisCache>
  savedReviews: Holder<SavedReviews>
  feedback: Holder<FeedbackSnapshots>
  history: Holder<AnalysisHistory>
}
export interface SaveDeps {
  project: Project | null
  /** Dismissals are analysis metadata, so they schedule a sidecar write too. */
  dismissed: Set<string>
  sessionRef: Holder<Session | null>
  editorRef: Holder<Editor | null>
  currentRef: Holder<Snapshot | null>
  revision: Holder<number>
  findingsRef: Holder<Diagnostic[]>
  settingsRef: Holder<Settings>
  meta: Holder<ProjectMeta>
  profile: ProfileId
  stores: SaveStores
  askName: (title: string, description: string, initial?: string) => Promise<string | null>
  showNotice: (message: string, error?: boolean) => void
  refreshTree: () => Promise<void>
  setSession: (session: Session | null) => void
  setFindings: Dispatch<SetStateAction<Diagnostic[]>>
  setSelected: (id: string | null) => void
  setCurrent: (snapshot: Snapshot | null) => void
  /** Called when the document's bytes are on disk and nothing is unsaved anymore. */
  onSaved: () => void
}
/**
 * Everything that touches the author's Markdown bytes and the analysis sidecars that
 * belong to those bytes: dirty state, file/save locks, the save pipeline, the debounced
 * analysis-metadata write, and the "you have unsaved writing" leave confirmation.
 *
 * Saving is the only place that decides what is safe to write to disk. Keeping it here,
 * rather than spread across the session controller, is what makes recovery work possible.
 */
export function useDocumentSave(deps: SaveDeps) {
  const {
    project,
    dismissed,
    sessionRef,
    editorRef,
    currentRef,
    revision,
    findingsRef,
    settingsRef,
    meta,
    profile,
    stores,
    askName,
    showNotice,
    refreshTree,
    setSession,
    setFindings,
    setSelected,
    setCurrent,
    onSaved,
  } = deps
  const [dirty, setDirty] = useState(false),
    dirtyRef = useRef(false),
    [saving, setSaving] = useState(false),
    [fileBusy, setFileBusy] = useState(false)
  const fileLock = useRef(false),
    saveLock = useRef(false),
    leavePending = useRef<Promise<boolean> | null>(null),
    [unsaved, setUnsaved] = useState<((proceed: boolean) => void) | null>(null),
    saveRef = useRef<() => Promise<boolean>>(async () => false),
    persistRef = useRef<() => Promise<void>>(async () => {})
  const markDirty = (value: boolean) => {
    dirtyRef.current = value
    setDirty(value)
  }
  /** Clean means the crash-recovery snapshot for this document is no longer needed. */
  const markClean = () => {
    markDirty(false)
    onSaved()
  }
  /** Never discard unsaved writing silently: the author chooses Save or Discard first. */
  const confirmLeave = async () => {
    if (!dirtyRef.current) return true
    if (leavePending.current) return leavePending.current
    leavePending.current = new Promise<boolean>((resolve) => setUnsaved(() => resolve)).finally(
      () => {
        leavePending.current = null
      },
    )
    return leavePending.current
  }
  const persistAnalysis = async () => {
    if (project)
      await storage.setMetadata(
        'analysis',
        {
          version: 2,
          cache: stores.cache.current.export(),
          reviews: stores.savedReviews.current.export(),
          feedback: stores.feedback.current.export(),
          history: stores.history.current.export(),
        },
        project.root,
      )
  }
  persistRef.current = persistAnalysis
  useEffect(() => {
    if (!project || fileBusy) return
    const timer = setTimeout(() => {
      void persistRef
        .current()
        .catch(() =>
          showNotice('Could not persist analysis metadata. Markdown is unaffected.', true),
        )
    }, 300)
    return () => clearTimeout(timer)
  }, [dismissed, project?.root, fileBusy, showNotice])
  const save = async (copy = false, beforeLeave = false): Promise<boolean> => {
    const active = sessionRef.current,
      editor = editorRef.current
    if (saveLock.current) return false
    if (fileLock.current && !beforeLeave) {
      showNotice('Finish or cancel the current file operation before saving.', true)
      return false
    }
    if (!active || !editor) return true
    if (active.source.unsupported.length && !copy) {
      showNotice('This document is read-only. Save a converted copy to retain the original.', true)
      return false
    }
    saveLock.current = true
    setSaving(true)
    try {
      let path = active.path
      if (copy) {
        const answer = await askName(
          'Save a copy',
          'A relative .md path inside the open project. The original stays untouched.',
          active.path.replace(/\.md$/i, '-copy.md'),
        )
        if (!answer?.trim()) return false
        path = answer.trim()
        if (!/\.md$/i.test(path)) path += '.md'
      }
      const beforeRevision = revision.current
      const savedInput = snapshot(editor, active.id, beforeRevision)
      const savedFindings = [...findingsRef.current]
      const content = writeMarkdown(active.source, editor.getMarkdown())
      const diskHash = await storage.save(path, content, copy ? null : active.diskHash)
      const unchanged = beforeRevision === revision.current
      const feedbackSaved =
        copy ||
        sessionRef.current?.token !== active.token ||
        stores.feedback.current.capture(
          savedInput,
          diskHash,
          hash(content),
          unchanged ? findingsRef.current : savedFindings,
          settingsRef.current.analysis,
        )
      const next = {
        ...active,
        path,
        diskHash,
        original: content,
        source: copy ? { ...active.source, unsupported: [] } : active.source,
      }
      if (sessionRef.current?.token === active.token && !copy) {
        sessionRef.current = next
        setSession(next)
        if (beforeRevision === revision.current) {
          markClean()
          stores.savedReviews.current.confirmSave(
            snapshot(editor, active.id, revision.current),
            hash(content),
            active.diskHash,
            diskHash,
          )
        }
      }
      if (copy && beforeRevision === revision.current) markClean()
      if (copy && beforeRevision === revision.current) {
        const id = crypto.randomUUID()
        const copied = { ...next, id, token: crypto.randomUUID(), source: readMarkdown(content) }
        sessionRef.current = copied
        setSession(copied)
        revision.current = 0
        setFindings([])
        setSelected(null)
        setCurrent(null)
        currentRef.current = null
        meta.current.documents[path] = { id, profile }
        await refreshTree()
      }
      try {
        await storage.setMetadata('project', meta.current, project?.root)
        await persistAnalysis()
        if (!feedbackSaved) {
          showNotice(
            'Markdown saved, but the visible feedback could not be saved for reopening. Your draft is safe.',
            true,
          )
          return unchanged
        }
      } catch {
        showNotice('Markdown saved. Analysis metadata could not be saved.', true)
        return !dirtyRef.current
      }
      showNotice(
        unchanged
          ? 'Saved to your Markdown file.'
          : 'Saved. New edits made during the save are still unsaved.',
      )
      return unchanged
    } catch (error) {
      showNotice(errorMessage(error), true)
      return false
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  saveRef.current = () => save()
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveRef.current()
      }
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  }, [])
  return {
    dirty,
    dirtyRef,
    saving,
    fileBusy,
    fileLock,
    saveLock,
    unsaved,
    setUnsaved,
    saveRef,
    persistRef,
    markDirty,
    confirmLeave,
    persistAnalysis,
    save,
    /** A file operation that must not overlap a save or another file operation. */
    fileTask: (work: () => Promise<unknown>) => {
      if (fileLock.current || saveLock.current) return
      fileLock.current = true
      setFileBusy(true)
      void work()
        .catch((error) => showNotice(errorMessage(error), true))
        .finally(() => {
          fileLock.current = false
          setFileBusy(false)
        })
    },
  }
}
