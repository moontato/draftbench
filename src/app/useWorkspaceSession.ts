import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Editor } from '@tiptap/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { OpenAICompatibleProvider } from '../ai/providers/openai'
import { AnalysisCache } from '../analyzers/cache'
import { AnalysisHistory } from '../analyzers/history'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { useLocalAnalysis } from './useLocalAnalysis'
import { SavedReviews } from '../analyzers/savedReviews'
import { hash } from '../diagnostics/hash'
import { refreshDiagnostic } from '../diagnostics/mapping'
import type { Diagnostic, Snapshot } from '../diagnostics/types'
import { readMarkdown, writeMarkdown } from '../documents/markdown'
import { snapshot } from '../editor/blocks'
import { applyFix, decorate, jumpTo } from '../editor/diagnostics'
import { analyzerEnabled, getProfiles, globallyEnabled, type ProfileId } from '../profiles/profiles'
import {
  effectiveConfig,
  configurationHash,
  sameInputBudgets,
  settingsSchema,
  type Settings,
} from '../settings/model'
import {
  desktopAvailable,
  errorMessage,
  storage,
  type FileEntry,
  type Project,
} from '../storage/desktop'
import { useRecentProjects } from './useRecentProjects'
import { useNotice } from '../ui/useNotice'
import { useSettingsState } from './useSettingsState'
import { createReviewRun } from './reviewRun'
import type { Ask, ProjectMeta, Session } from './workspaceTypes'
export function useWorkspaceSession() {
  const { notice, showNotice, dismissNotice } = useNotice()
  const { settings, settingsRef, setSettings, settingsLoaded, settingsReady } =
    useSettingsState(showNotice)
  const [project, setProject] = useState<Project | null>(null),
    [session, setSession] = useState<Session | null>(null)
  const analyzers = useMemo(() => createAnalyzerRegistry(settings), [settings])
  const profiles = getProfiles(settings)
  const [current, setCurrent] = useState<Snapshot | null>(null),
    currentRef = useRef<Snapshot | null>(null)
  const [dirty, setDirty] = useState(false),
    dirtyRef = useRef(false),
    [saving, setSaving] = useState(false)
  const fileLock = useRef(false),
    saveLock = useRef(false),
    [fileBusy, setFileBusy] = useState(false)
  const [findings, setFindings] = useState<Diagnostic[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [dismissed, setDismissed] = useState(new Set<string>())
  const [leftOpen, setLeftOpen] = useState(true),
    [rightOpen, setRightOpen] = useState(true),
    [settingsTab, setSettingsTab] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [, setHistoryRevision] = useState(0)
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState('')
  const { recentProjects, recentErrors, setRecentErrors, removeRecentProject, rememberProject } =
    useRecentProjects(showNotice)
  const [profile, setProfile] = useState<ProfileId>('general'),
    [ask, setAsk] = useState<Ask | null>(null),
    [askValue, setAskValue] = useState('')
  const [unsaved, setUnsaved] = useState<((proceed: boolean) => void) | null>(null),
    [entryActions, setEntryActions] = useState<FileEntry | null>(null)
  const editorRef = useRef<Editor | null>(null),
    sessionRef = useRef(session),
    revision = useRef(0)
  const meta = useRef<ProjectMeta>({ version: 2, documents: {} })
  const cache = useRef(new AnalysisCache()),
    savedReviews = useRef(new SavedReviews(analyzers)),
    history = useRef(new AnalysisHistory()),
    pendingRestore = useRef<string | null>(null),
    provider = useRef(new OpenAICompatibleProvider()),
    running = useRef<AbortController | null>(null)
  const saveRef = useRef<() => Promise<boolean>>(async () => false),
    proceedRef = useRef<() => Promise<boolean>>(async () => true)
  const persistRef = useRef<() => Promise<void>>(async () => {})
  const task = (work: () => Promise<unknown>) => {
    void work().catch((error) => showNotice(errorMessage(error), true))
  }
  const fileTask = (work: () => Promise<unknown>) => {
    if (fileLock.current || saveLock.current) return
    fileLock.current = true
    setFileBusy(true)
    void work()
      .catch((error) => showNotice(errorMessage(error), true))
      .finally(() => {
        fileLock.current = false
        setFileBusy(false)
      })
  }
  const markDirty = (value: boolean) => {
    dirtyRef.current = value
    setDirty(value)
  }
  savedReviews.current.setAnalyzers(analyzers)
  sessionRef.current = session
  const askName = (title: string, description: string, initial = ''): Promise<string | null> =>
    new Promise((resolve) => {
      setAskValue(initial)
      setAsk({ title, description, initial, resolve })
    })
  const confirmLeave = async () => {
    if (!dirtyRef.current) return true
    return new Promise<boolean>((resolve) => setUnsaved(() => resolve))
  }
  proceedRef.current = confirmLeave
  const persistAnalysis = async () => {
    if (project)
      await storage.setMetadata('analysis', {
        version: 2,
        cache: cache.current.export(),
        reviews: savedReviews.current.export(),
        history: history.current.export(),
      })
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
  useEffect(() => {
    if (!desktopAvailable) return
    let dispose: (() => void) | undefined,
      stopped = false
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        if (await proceedRef.current()) {
          running.current?.abort()
          await persistRef.current().catch(() => {})
          await getCurrentWindow().destroy()
        }
      })
      .then((unlisten) => {
        if (stopped) unlisten()
        else dispose = unlisten
      })
    return () => {
      stopped = true
      dispose?.()
    }
  }, [showNotice])
  const loadDocument = async (path: string, skipPrompt = false) => {
    if (!skipPrompt && !(await confirmLeave())) return
    await settingsReady.current
    const loaded = await storage.read(path)
    running.current?.abort()
    running.current = null
    setBusy(false)
    setStatus('')
    setHistoryOpen(false)
    revision.current = 0
    editorRef.current = null
    let document = meta.current.documents[path]
    if (!document) {
      document = { id: crypto.randomUUID(), profile: settingsRef.current.general.defaultProfile }
      meta.current.documents[path] = document
    }
    const source = readMarkdown(loaded.content)
    const next = {
      path,
      id: document.id,
      token: crypto.randomUUID(),
      source,
      diskHash: loaded.hash,
      original: loaded.content,
    }
    sessionRef.current = next
    pendingRestore.current = next.token
    setSession(next)
    const loadedProfile = Object.hasOwn(getProfiles(settingsRef.current), document.profile)
      ? document.profile
      : 'general'
    setProfile(loadedProfile)
    if (loadedProfile !== document.profile) {
      document.profile = loadedProfile
      showNotice(
        'This document’s profile is unavailable. General prose selected; document identity is preserved.',
        true,
      )
    }
    markDirty(false)
    setFindings([])
    setSelected(null)
    setDismissed(new Set())
    setCurrent(null)
    currentRef.current = null
    if (source.unsupported.length)
      showNotice(
        `Read-only: unsupported Markdown (${source.unsupported.join(', ')}). The original file will not be rewritten.`,
        true,
      )
    else dismissNotice()
    try {
      await storage.setMetadata('project', meta.current)
    } catch {
      showNotice(
        'Document opened. Project metadata could not be saved; Markdown is unaffected.',
        true,
      )
    }
  }
  const openProject = async (path?: string) => {
    if (!(await confirmLeave())) return
    running.current?.abort()
    running.current = null
    setBusy(false)
    let selectedProject: Project | null
    try {
      selectedProject = path ? await storage.openProject(path) : await storage.pickProject()
    } catch (error) {
      if (path) {
        setRecentErrors((old) => ({ ...old, [path]: true }))
        throw new Error(
          'Could not open this recent folder. It may have moved, been removed, or become inaccessible. Locate it with Open a writing folder, or remove its recent entry.',
        )
      }
      throw error
    }
    if (!selectedProject) return
    rememberProject(selectedProject)
    await settingsReady.current
    savedReviews.current.setAnalyzers(createAnalyzerRegistry(settingsRef.current))
    setProject(selectedProject)
    setSession(null)
    sessionRef.current = null
    editorRef.current = null
    setCurrent(null)
    currentRef.current = null
    setFindings([])
    setSelected(null)
    markDirty(false)
    setStatus('')
    cache.current.clear()
    savedReviews.current.clear()
    history.current.clear()
    setHistoryOpen(false)
    pendingRestore.current = null
    setDismissed(new Set())
    meta.current = { version: 2, documents: {} }
    try {
      const raw = (await storage.metadata('project')) as ProjectMeta | null
      if (
        raw &&
        (raw.version === 1 || raw.version === 2) &&
        raw.documents &&
        typeof raw.documents === 'object'
      ) {
        for (const [path, doc] of Object.entries(raw.documents))
          if (
            doc &&
            /\.md$/i.test(path) &&
            typeof doc.id === 'string' &&
            typeof doc.profile === 'string' &&
            doc.profile.length > 0 &&
            doc.profile.length <= 64
          )
            meta.current.documents[path] = doc
      }
      const analysis = (await storage.metadata('analysis')) as {
        version: number
        cache: unknown
        reviews?: unknown
        history?: unknown
      } | null
      if (analysis?.version === 1 || analysis?.version === 2) {
        const problems: string[] = []
        const imports: [unknown, (data: unknown) => void][] = [
          [analysis.cache, (data) => cache.current.import(data)],
          [analysis.history, (data) => history.current.import(data)],
          [analysis.reviews, (data) => savedReviews.current.import(data)],
        ]
        // A missing/corrupt cache must not block a valid review or history log.
        for (const [data, apply] of imports) {
          if (data == null) continue
          try {
            apply(data)
          } catch (error) {
            problems.push(errorMessage(error))
          }
        }
        history.current.recoverSavedReviews(
          savedReviews.current.summaries(),
          createAnalyzerRegistry(settingsRef.current),
        )
        setHistoryRevision((old) => old + 1)
        if (problems.length) showNotice(problems.join(' '), true)
      }
    } catch (error) {
      showNotice(errorMessage(error), true)
    }
    if (selectedProject.recentWarning) showNotice(selectedProject.recentWarning, true)
  }
  const refreshTree = async () => {
    const entries = await storage.list()
    setProject((old) => (old ? { ...old, entries } : null))
  }
  const save = async (copy = false): Promise<boolean> => {
    const active = sessionRef.current,
      editor = editorRef.current
    if (saveLock.current) return false
    if (!active || !editor) return true
    if (active.source.unsupported.length && !copy) {
      showNotice('This document is read-only. Save a converted copy to retain the original.', true)
      return false
    }
    let path = active.path
    if (copy) {
      const answer = await askName(
        'Save a copy',
        'A relative .md path inside the open project. The original stays untouched.',
        active.path.replace(/\.md$/i, '-copy.md'),
      )
      if (!answer) return false
      path = answer.trim()
      if (!/\.md$/i.test(path)) path += '.md'
    }
    const beforeRevision = revision.current
    const content = writeMarkdown(active.source, editor.getMarkdown())
    saveLock.current = true
    setSaving(true)
    try {
      const diskHash = await storage.save(path, content, copy ? null : active.diskHash)
      const unchanged = beforeRevision === revision.current
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
          markDirty(false)
          savedReviews.current.confirmSave(
            snapshot(editor, active.id, revision.current),
            hash(content),
            active.diskHash,
            diskHash,
          )
        }
      }
      if (copy && beforeRevision === revision.current) markDirty(false)
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
        await storage.setMetadata('project', meta.current)
        await persistAnalysis()
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
  const onReady = (editor: Editor) => {
    editorRef.current = editor
    const active = sessionRef.current
    if (!active) return
    const snap = snapshot(editor, active.id, revision.current)
    setCurrent(snap)
    currentRef.current = snap
  }
  const onChange = (editor: Editor) => {
    const active = sessionRef.current
    if (!active) return
    revision.current++
    const snap = snapshot(editor, active.id, revision.current)
    setCurrent(snap)
    currentRef.current = snap
    markDirty(true)
    setStatus((old) =>
      old.startsWith('Saved review') ? 'Document changed since the saved review.' : old,
    )
    setFindings((old) =>
      old.flatMap((f) => {
        const next = refreshDiagnostic(f, snap)
        return next ? [next] : []
      }),
    )
  }
  useEffect(() => {
    const active = sessionRef.current,
      editor = editorRef.current,
      input = currentRef.current
    if (
      !active ||
      !editor ||
      !input ||
      !settingsLoaded ||
      fileBusy ||
      pendingRestore.current !== active.token
    )
      return
    pendingRestore.current = null
    if (dirtyRef.current || active.source.unsupported.length) return
    const restored = savedReviews.current.restore(
      input,
      active.diskHash,
      hash(writeMarkdown(active.source, editor.getMarkdown())),
      profile,
      settingsRef.current,
    )
    if (!restored) return
    setFindings(restored.findings)
    setStatus(
      `Saved review · ${restored.scope === 'block' ? 'paragraph' : restored.scope} · ${restored.findings.length} findings · ${new Date(restored.analyzedAt).toLocaleString()}`,
    )
  }, [current?.documentId, session?.token, settingsLoaded, fileBusy])
  useEffect(() => {
    const editor = editorRef.current
    if (editor && !editor.isDestroyed)
      decorate(
        editor,
        findings.filter((f) => !dismissed.has(f.id)),
      )
    if (selected && !findings.some((f) => f.id === selected)) setSelected(null)
  }, [findings, dismissed, selected])
  const enabled = (id: string) => analyzerEnabled(settings, id, profile)
  useLocalAnalysis({
    current,
    currentRef,
    settings,
    profile,
    analyzers,
    cache,
    provider,
    setFindings,
    showNotice,
  })
  const run = createReviewRun({
    editorRef,
    sessionRef,
    busy,
    running,
    settingsLoaded,
    revision,
    showNotice,
    analyzers,
    enabled,
    settingsRef,
    findings,
    history,
    profile,
    setHistoryRevision,
    persistRef,
    setBusy,
    setRightOpen,
    setStatus,
    currentRef,
    provider,
    cache,
    setFindings,
    savedReviews,
    dirtyRef,
    persistAnalysis,
  })
  const selectFinding = (finding: Diagnostic) => {
    const editor = editorRef.current
    if (!editor || !currentRef.current) return
    const fresh = refreshDiagnostic(finding, currentRef.current)
    if (!fresh) return
    setSelected(finding.id)
    setRightOpen(true)
    jumpTo(editor, fresh)
  }
  const findingClick = (id: string) => {
    const finding = findings.find((f) => f.id === id)
    if (finding) selectFinding(finding)
  }
  const accept = (finding: Diagnostic) => {
    if (!editorRef.current || !session) return
    if (!applyFix(editorRef.current, finding, session.id, revision.current)) {
      showNotice('This passage changed; rerun analysis before applying a fix.', true)
      return
    }
    setSelected(null)
    showNotice('Suggestion applied. Undo is available in the editor.')
  }
  const createDocument = async () => {
    if (!(await confirmLeave())) return
    let path = await askName(
      'New document',
      'A relative .md path in this project. For example: essay.md',
      'untitled.md',
    )
    if (!path?.trim()) return
    path = path.trim()
    if (!/\.md$/i.test(path)) path += '.md'
    await storage.save(path, '', null)
    await refreshTree()
    await loadDocument(path, true)
  }
  const createFolder = async () => {
    const name = await askName('New folder', 'Create a folder in this project.', 'drafts')
    if (name?.trim()) {
      await storage.createFolder(name.trim())
      await refreshTree()
    }
  }
  const renameEntry = async (entry: FileEntry) => {
    setEntryActions(null)
    const answer = await askName(
      'Rename',
      'Enter the new relative path. Documents keep the .md extension.',
      entry.path,
    )
    if (!answer || answer === entry.path) return
    await storage.rename(entry.path, answer)
    const nextDocs: ProjectMeta['documents'] = {}
    for (const [path, doc] of Object.entries(meta.current.documents))
      nextDocs[
        path === entry.path
          ? answer
          : path.startsWith(entry.path + '/')
            ? answer + path.slice(entry.path.length)
            : path
      ] = doc
    meta.current.documents = nextDocs
    if (session && (session.path === entry.path || session.path.startsWith(entry.path + '/'))) {
      const next = { ...session, path: answer + session.path.slice(entry.path.length) }
      sessionRef.current = next
      setSession(next)
    }
    await refreshTree()
    await storage.setMetadata('project', meta.current)
  }
  const deleteEntry = async (entry: FileEntry) => {
    setEntryActions(null)
    if (!(await confirmLeave())) return
    if (
      !(await storage.confirm(
        `Permanently delete “${entry.name}”? ${entry.folder ? 'Only empty folders can be deleted.' : 'This cannot be undone.'}`,
      ))
    )
      return
    await storage.delete(entry.path)
    const deletedDocument = meta.current.documents[entry.path]
    if (deletedDocument) {
      savedReviews.current.delete(deletedDocument.id)
      history.current.delete(deletedDocument.id)
    }
    delete meta.current.documents[entry.path]
    if (session?.path === entry.path) {
      editorRef.current = null
      setSession(null)
      sessionRef.current = null
      setCurrent(null)
      currentRef.current = null
      setFindings([])
      markDirty(false)
    }
    await refreshTree()
    await storage.setMetadata('project', meta.current)
  }
  const changeProfile = async (value: ProfileId) => {
    setProfile(value)
    setStatus('')
    running.current?.abort()
    setFindings([])
    if (session) {
      meta.current.documents[session.path] = { id: session.id, profile: value }
      await storage.setMetadata('project', meta.current)
    }
  }
  const saveSettings = async (next: Settings) => {
    const parsed = settingsSchema.parse(next)
    const inputBudgetsChanged = !sameInputBudgets(settingsRef.current.analysis, parsed.analysis)
    await storage.saveSettings(parsed)
    const nextProfiles = getProfiles(parsed)
    const nextAnalyzers = createAnalyzerRegistry(parsed)
    const nextProfile = nextProfiles[profile] ? profile : 'general'
    if (nextProfile !== profile) {
      setProfile(nextProfile)
      if (sessionRef.current) {
        meta.current.documents[sessionRef.current.path].profile = nextProfile
        await storage
          .setMetadata('project', meta.current)
          .catch(() =>
            showNotice(
              'Settings saved, but the document profile metadata could not be saved.',
              true,
            ),
          )
      }
    }
    settingsRef.current = parsed
    setSettings(parsed)
    running.current?.abort()
    if (
      status.startsWith('Saved review') &&
      sessionRef.current &&
      currentRef.current &&
      editorRef.current &&
      !savedReviews.current.restore(
        currentRef.current,
        sessionRef.current.diskHash,
        hash(writeMarkdown(sessionRef.current.source, editorRef.current.getMarkdown())),
        nextProfile,
        parsed,
      )
    )
      setStatus('Analysis settings changed since the saved review.')
    setFindings((old) =>
      old.filter(
        (f) =>
          (!inputBudgetsChanged || f.engine.kind !== 'ai') &&
          (parsed.analyzers[f.analyzerId]?.enabled ?? true) &&
          nextAnalyzers.some((a) => a.id === f.analyzerId && a.version === f.analyzerVersion) &&
          f.configurationHash === configurationHash(effectiveConfig(parsed, f.analyzerId)),
      ),
    )
    showNotice('Settings saved locally.')
  }
  const words =
    current?.blocks.reduce((n, b) => n + (b.text.trim().match(/\S+/g)?.length ?? 0), 0) ?? 0
  const title = session?.path.split('/').pop()?.replace(/\.md$/i, '')
  return {
    project,
    analyzers,
    profiles,
    globallyEnabled: (id: string) => globallyEnabled(settings, id),
    session,
    recentProjects,
    recentErrors,
    settings,
    settingsLoaded,
    current,
    dirty,
    saving,
    fileBusy,
    findings,
    selected,
    dismissed,
    leftOpen,
    rightOpen,
    settingsTab,
    historyOpen,
    busy,
    status,
    notice,
    profile,
    ask,
    askValue,
    unsaved,
    entryActions,
    editorRef,
    revision,
    history,
    provider,
    running,
    saveRef,
    persistRef,
    settingsRef,
    cache,
    savedReviews,
    task,
    fileTask,
    askName,
    loadDocument,
    removeRecentProject,
    openProject,
    save,
    onReady,
    onChange,
    enabled,
    run,
    selectFinding,
    findingClick,
    accept,
    createDocument,
    createFolder,
    renameEntry,
    deleteEntry,
    changeProfile,
    saveSettings,
    words,
    title,
    showNotice,
    dismissNotice,
    setLeftOpen,
    setRightOpen,
    setSettingsTab,
    setHistoryOpen,
    setDismissed,
    setSelected,
    setStatus,
    setFindings,
    setSettings,
    setAsk,
    setAskValue,
    setUnsaved,
    setEntryActions,
    setHistoryRevision,
  }
}
