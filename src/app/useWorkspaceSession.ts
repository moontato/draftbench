import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { ReviewEditHistory } from '../editor/reviewEdits'
import { useEffect, useMemo, useRef, useState } from 'react'
import { OpenAICompatibleProvider } from '../ai/providers/openai'
import type { AIProvider } from '../ai/types'
import { AnalysisCache } from '../analyzers/cache'
import { AnalysisHistory } from '../analyzers/history'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { useLocalAnalysis } from './useLocalAnalysis'
import { SavedReviews } from '../analyzers/savedReviews'
import { FeedbackSnapshots } from '../analyzers/feedbackSnapshots'
import { hash } from '../diagnostics/hash'
import { refreshDiagnostic } from '../diagnostics/mapping'
import type { Diagnostic, Snapshot } from '../diagnostics/types'
import { readMarkdown, writeMarkdown } from '../documents/markdown'
import { recoveryDecision } from '../documents/recovery'
import { snapshot } from '../editor/blocks'
import { applyFix, jumpTo } from '../editor/diagnostics'
import { analyzerEnabled, getProfiles, globallyEnabled, type ProfileId } from '../profiles/profiles'
import { reconcileReviewContexts } from '../profiles/reviewContext'
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
import { useCrashRecovery } from './useCrashRecovery'
import { useDocumentSave } from './useDocumentSave'
import { useFindingsView } from './useFindingsView'
import { useRevisionMode } from './useRevisionMode'
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
  const editorRef = useRef<Editor | null>(null),
    sessionRef = useRef(session),
    revision = useRef(0)
  // One findings view: the Analysis pane, the editor underlines and the inspector all
  // read the same state, so they can never disagree about what is visible.
  const {
    findings,
    findingsRef,
    setFindings,
    selected,
    setSelected,
    dismissed,
    setDismissed,
    filters,
    setFilters,
    visibleFindings,
  } = useFindingsView({ editorRef, analyzers })
  const inspectionRef = useRef<{ token: string; blockId: string; from: number; to: number } | null>(
    null,
  )
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
  const [entryActions, setEntryActions] = useState<FileEntry | null>(null)
  const meta = useRef<ProjectMeta>({ version: 2, documents: {} })
  const cache = useRef(new AnalysisCache()),
    savedReviews = useRef(new SavedReviews(analyzers)),
    feedbackSnapshots = useRef(new FeedbackSnapshots()),
    history = useRef(new AnalysisHistory()),
    pendingRestore = useRef<string | null>(null),
    provider = useRef<AIProvider>(new OpenAICompatibleProvider()),
    running = useRef<AbortController | null>(null)
  const closePending = useRef(false)
  // The save pipeline reports cleanliness before the recovery hook is created, so it calls
  // through this holder.
  const recoveryActions = useRef<{ clearCurrent: () => void }>({ clearCurrent: () => {} })
  const askRef = useRef(ask)
  askRef.current = ask
  const proceedRef = useRef<() => Promise<boolean>>(async () => true)
  const task = (work: () => Promise<unknown>) => {
    void work().catch((error) => showNotice(errorMessage(error), true))
  }
  savedReviews.current.setAnalyzers(analyzers)
  sessionRef.current = session
  const askName = (title: string, description: string, initial = ''): Promise<string | null> =>
    new Promise((resolve) => {
      setAskValue(initial)
      setAsk({ title, description, initial, resolve })
    })
  const refreshTree = async () => {
    const entries = await storage.list()
    setProject((old) => (old ? { ...old, entries } : null))
  }
  // Dirty state, file/save locks, the save pipeline, analysis-metadata persistence and
  // the “you have unsaved writing” leave confirmation all belong to the saved bytes.
  const {
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
    fileTask,
  } = useDocumentSave({
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
    stores: { cache, savedReviews, feedback: feedbackSnapshots, history },
    askName,
    showNotice,
    refreshTree,
    setSession,
    setFindings,
    setSelected,
    setCurrent,
    onSaved: () => recoveryActions.current.clearCurrent(),
  })
  // Crash recovery for unsaved writing: checkpoints in app storage, never in the project.
  const recovery = useCrashRecovery({
    project,
    sessionRef,
    editorRef,
    dirtyRef,
    fileLock,
    saveLock,
    showNotice,
  })
  recoveryActions.current = recovery
  proceedRef.current = confirmLeave
  useEffect(() => {
    if (!desktopAvailable) return
    let dispose: (() => void) | undefined,
      stopped = false
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        if (closePending.current) return
        if (fileLock.current || saveLock.current || askRef.current) {
          showNotice('Finish or cancel the current file operation before closing.', true)
          return
        }
        closePending.current = true
        try {
          if (await proceedRef.current()) {
            running.current?.abort()
            await persistRef.current().catch(() => {})
            await getCurrentWindow().destroy()
          }
        } catch (error) {
          showNotice(errorMessage(error), true)
        } finally {
          closePending.current = false
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
    const leaving = sessionRef.current?.path
    const wasDirty = dirtyRef.current
    if (!skipPrompt && !(await confirmLeave())) return
    // The previous draft was saved or explicitly discarded, so its snapshot is spent. A plain
    // reload of the same document is not a discard: its snapshot stays available.
    if (leaving && (leaving !== path || wasDirty)) recovery.clearFor(leaving)
    recovery.noteOpened()
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
      await storage.setMetadata('project', meta.current, project?.root)
    } catch {
      showNotice(
        'Document opened. Project metadata could not be saved; Markdown is unaffected.',
        true,
      )
    }
    // A checkpoint from before a crash is offered, never applied automatically.
    const recovered = project ? await recovery.lookupRecovery(project.root, path) : null
    if (recovered) {
      if (recoveryDecision(recovered, loaded.hash) === 'superseded')
        recovery.clearRecovery(recovered.key)
      else recovery.armRecovery(recovered)
    }
  }
  /**
   * Load a recovered snapshot into the editor as an ordinary unsaved edit. The session keeps
   * the disk hash recorded when the snapshot was captured, so a later Save conflicts rather
   * than overwriting a file that changed elsewhere in the meantime.
   */
  const restoreRecovery = () => {
    const record = recovery.pendingRecovery
    const active = sessionRef.current
    if (!record || !active || fileLock.current || saveLock.current) return
    if (record.documentPath !== active.path || record.projectRoot !== project?.root) {
      recovery.discardRecovery()
      return
    }
    const source = readMarkdown(record.text)
    if (source.unsupported.length) {
      showNotice(
        `The recovered snapshot contains unsupported Markdown (${source.unsupported.join(', ')}). Nothing was loaded and nothing was written to disk.`,
        true,
      )
      return
    }
    const next = {
      ...active,
      token: crypto.randomUUID(),
      source,
      diskHash: record.diskHash,
    }
    recovery.cancelCheckpoint()
    revision.current = 0
    editorRef.current = null
    inspectionRef.current = null
    sessionRef.current = next
    pendingRestore.current = null
    setSession(next)
    setFindings([])
    setSelected(null)
    setDismissed(new Set())
    setCurrent(null)
    currentRef.current = null
    setStatus('')
    markDirty(true)
    recovery.dismissRecovery()
    showNotice(
      'Recovered writing loaded into the editor. It is unsaved, and Save will not overwrite a file that changed elsewhere.',
    )
  }
  const openProject = async (path?: string) => {
    if (!(await confirmLeave())) return
    // Leaving the project means the previous draft was saved or explicitly discarded.
    recovery.clearCurrent()
    if (running.current) {
      running.current.abort()
      setStatus('Analysis cancelled.')
    }
    await persistAnalysis().catch(() =>
      showNotice(
        'Could not save the previous project’s analysis metadata. Markdown is unaffected.',
        true,
      ),
    )
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
    feedbackSnapshots.current.clear()
    history.current.clear()
    setHistoryOpen(false)
    pendingRestore.current = null
    setDismissed(new Set())
    meta.current = { version: 2, documents: {} }
    try {
      const raw = (await storage.metadata('project', selectedProject.root)) as ProjectMeta | null
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
      const analysis = (await storage.metadata('analysis', selectedProject.root)) as {
        version: number
        cache: unknown
        reviews?: unknown
        feedback?: unknown
        history?: unknown
      } | null
      if (analysis?.version === 1 || analysis?.version === 2) {
        const problems: string[] = []
        const imports: [unknown, (data: unknown) => void][] = [
          [analysis.cache, (data) => cache.current.import(data)],
          [analysis.history, (data) => history.current.import(data)],
          [analysis.reviews, (data) => savedReviews.current.import(data)],
          [analysis.feedback, (data) => feedbackSnapshots.current.import(data)],
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
  const reviewEditHistory = useRef(new ReviewEditHistory())
  const onReady = (editor: Editor) => {
    reviewEditHistory.current = new ReviewEditHistory()
    editorRef.current = editor
    const active = sessionRef.current
    if (!active) return
    const snap = snapshot(editor, active.id, revision.current)
    setCurrent(snap)
    currentRef.current = snap
  }
  const onChange = (editor: Editor, transaction: Transaction) => {
    const active = sessionRef.current
    if (!active) return
    const before = currentRef.current
    revision.current++
    const snap = snapshot(editor, active.id, revision.current)
    setCurrent(snap)
    currentRef.current = snap
    const inspected = inspectionRef.current
    if (inspected?.token === active.token) {
      const from = transaction.mapping.map(inspected.from, -1)
      const to = transaction.mapping.map(inspected.to, 1)
      const block = snap.blocks.find((block) => block.id === inspected.blockId)
      inspectionRef.current =
        block && from >= block.from && to <= block.to && from < to
          ? { ...inspected, from, to }
          : null
    }
    const pinned = referenceRef.current
    if (pinned?.sessionToken === active.token) mapReference(before, snap, transaction)
    markDirty(true)
    recovery.scheduleCheckpoint()
    setStatus((old) =>
      old.startsWith('Saved review') || old.startsWith('Saved feedback')
        ? 'Document changed since the saved feedback. Previous reviews remain visible.'
        : old,
    )
    setFindings((old) =>
      reconcileReviewContexts(
        reviewEditHistory.current.update(old, before, snap, transaction),
        analyzers,
        settingsRef.current,
        profile,
        snap,
      ),
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
    const serializedHash = hash(writeMarkdown(active.source, editor.getMarkdown()))
    const feedback = feedbackSnapshots.current.restore(
      input,
      active.diskHash,
      serializedHash,
      analyzers,
      settingsRef.current,
      profile,
    )
    if (feedback !== null) {
      setFindings(feedback)
      setStatus(
        `Saved feedback · ${feedback.length} findings${feedback.some((finding) => finding.stale || finding.needsRerun) ? ' · includes previous reviews' : ''}`,
      )
      return
    }
    const restored = savedReviews.current.restore(
      input,
      active.diskHash,
      hash(writeMarkdown(active.source, editor.getMarkdown())),
      profile,
      settingsRef.current,
    )
    if (!restored) {
      if (feedbackSnapshots.current.has(input.documentId)) {
        setStatus(
          'Saved feedback was not restored because the file or its saved locations no longer match.',
        )
        showNotice(
          'Saved feedback does not safely match this file and was not attached. Re-review to refresh it; no AI request was sent automatically.',
          true,
        )
      }
      return
    }
    if (feedbackSnapshots.current.has(input.documentId)) {
      showNotice(
        'Some saved feedback could not be attached safely. A compatible exact review was restored instead. Re-review to refresh the feedback; no AI request was sent automatically.',
        true,
      )
    }
    setFindings(restored.findings)
    setStatus(
      `Saved review · ${restored.scope === 'block' ? 'paragraph' : restored.scope} · ${restored.findings.length} findings · ${new Date(restored.analyzedAt).toLocaleString()}`,
    )
  }, [current?.documentId, session?.token, settingsLoaded, fileBusy])
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
    captureFeedback: (input, diskHash, serializedHash) =>
      feedbackSnapshots.current.capture(
        input,
        diskHash,
        serializedHash,
        findingsRef.current,
        settingsRef.current.analysis,
      ),
  })
  const selectFinding = (finding: Diagnostic) => {
    const editor = editorRef.current
    if (!editor || !currentRef.current) return
    const fresh = refreshDiagnostic(finding, currentRef.current)
    if (!fresh) return
    if (sessionRef.current)
      inspectionRef.current = {
        token: sessionRef.current.token,
        blockId: fresh.blockId,
        from: fresh.from,
        to: fresh.to,
      }
    setSelected(finding.id)
    setRightOpen(true)
    jumpTo(editor, fresh)
  }
  const findingClick = (id: string) => {
    const finding = findings.find((f) => f.id === id)
    if (!finding) return false
    const pin = referenceRef.current
    if (referenceOpenRef.current && pin && pin.sessionToken === sessionRef.current?.token) {
      // Editor clicks are editing actions, not permission to replace a pin.
      // Only Revise/Choose another finding or explicit Re-review changes its baseline.
      return false
    } else {
      const inspected = inspectionRef.current
      if (
        selected === id ||
        (inspected &&
          inspected.token === sessionRef.current?.token &&
          inspected.blockId === finding.blockId &&
          finding.from < inspected.to &&
          finding.to > inspected.from)
      ) {
        setSelected(id)
        setRightOpen(true)
        return false
      }
      selectFinding(finding)
    }
    return true
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
  // Revision mode: the captured passage-and-feedback reference and its lifecycle.
  const {
    referenceRef,
    referenceOpenRef,
    reference,
    canResumeRevision,
    reviseAsNew,
    referenceView,
    referenceScope,
    canReviewReference,
    mapReference,
    resumeRevision,
    beginRevision,
    closeRevision,
    chooseRevisionFinding,
    jumpRevision,
    rereviewRevision,
    acceptRevision,
  } = useRevisionMode({
    sessionRef,
    editorRef,
    meta,
    revision,
    findingsRef,
    settingsRef,
    fileLock,
    saveLock,
    current,
    findings,
    selected,
    dismissed,
    settings,
    analyzers,
    profile,
    busy,
    fileBusy,
    saving,
    enabled,
    run,
    accept,
    setSelected,
    setRightOpen,
    showNotice,
  })
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
    await recovery.renameRecovery(entry.path, answer)
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
    await storage.setMetadata('project', meta.current, project?.root)
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
    // A deleted document takes its unsaved snapshot with it.
    if (entry.folder) recovery.clearSubtree(entry.path)
    else recovery.clearFor(entry.path)
    const deletedDocument = meta.current.documents[entry.path]
    if (deletedDocument) {
      savedReviews.current.delete(deletedDocument.id)
      feedbackSnapshots.current.delete(deletedDocument.id)
      history.current.delete(deletedDocument.id)
    }
    delete meta.current.documents[entry.path]
    if (session?.path === entry.path) {
      running.current?.abort()
      running.current = null
      setBusy(false)
      setStatus('')
      setHistoryOpen(false)
      pendingRestore.current = null
      editorRef.current = null
      setSession(null)
      sessionRef.current = null
      setCurrent(null)
      currentRef.current = null
      setFindings([])
      markDirty(false)
    }
    await refreshTree()
    await storage.setMetadata('project', meta.current, project?.root)
  }
  const changeProfile = async (value: ProfileId) => {
    const previous = profile
    if (value === previous) return
    setProfile(value)
    running.current?.abort()
    // Keep findings whose reviewers still apply to this profile; flag the rest for a
    // fresh review instead of clearing the whole pane.
    const nextFindings = reconcileReviewContexts(
      findings,
      analyzers,
      settingsRef.current,
      value,
      currentRef.current,
    )
    setFindings(nextFindings)
    setStatus(
      nextFindings.some((f) => f.needsRerun)
        ? 'Profile changed. Shared reviews kept; rerun flagged reviewers for fresh context.'
        : 'Profile changed.',
    )
    if (session) {
      meta.current.documents[session.path] = { id: session.id, profile: value }
      await storage.setMetadata('project', meta.current, project?.root)
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
          .setMetadata('project', meta.current, project?.root)
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
    if (
      status.startsWith('Saved feedback') &&
      reconcileReviewContexts(
        findingsRef.current,
        nextAnalyzers,
        parsed,
        nextProfile,
        currentRef.current,
      ).some((finding) => finding.needsRerun)
    )
      setStatus(
        'Some saved feedback needs a fresh review with the current profile/reviewer settings.',
      )
    setFindings((old) =>
      reconcileReviewContexts(
        old.filter(
          (f) =>
            (!inputBudgetsChanged || f.engine.kind !== 'ai') &&
            analyzerEnabled(parsed, f.analyzerId, nextProfile) &&
            nextAnalyzers.some((a) => a.id === f.analyzerId && a.version === f.analyzerVersion) &&
            f.configurationHash === configurationHash(effectiveConfig(parsed, f.analyzerId)),
        ),
        nextAnalyzers,
        parsed,
        nextProfile,
        currentRef.current,
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
    visibleFindings,
    filters,
    setFilters,
    selected,
    dismissed,
    reference,
    referenceView,
    referenceScope,
    canReviewReference,
    beginRevision,
    canResumeRevision,
    reviseAsNew,
    resumeRevision,
    closeRevision,
    chooseRevisionFinding,
    jumpRevision,
    acceptRevision,
    rereviewRevision,
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
    pendingRecovery: recovery.pendingRecovery,
    restoreRecovery,
    discardRecovery: recovery.discardRecovery,
    dismissRecovery: recovery.dismissRecovery,
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
    feedbackSnapshots,
    task,
    fileTask,
    askName,
    loadDocument,
    removeRecentProject,
    openProject,
    save,
    saveBeforeLeave: () => save(false, true),
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
