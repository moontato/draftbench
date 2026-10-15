import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { ReviewEditHistory } from '../editor/reviewEdits'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
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
import {
  captureRevisionReference,
  canResumeRevisionReference,
  mapRevisionReference,
  referenceState,
  type RevisionReference,
} from '../diagnostics/revisionReference'
import type { Diagnostic, Scope, Snapshot } from '../diagnostics/types'
import { readMarkdown, writeMarkdown } from '../documents/markdown'
import { snapshot } from '../editor/blocks'
import { applyFix, decorate, jumpTo } from '../editor/diagnostics'
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
  const [findings, setFindingsState] = useState<Diagnostic[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [dismissed, setDismissed] = useState(new Set<string>())
  const findingsRef = useRef(findings)
  // Native save/review completions can interleave before React renders. Keep the
  // authoritative feedback frame synchronous so a save cannot persist an older list.
  const setFindings = useCallback<Dispatch<SetStateAction<Diagnostic[]>>>((next) => {
    const value = typeof next === 'function' ? next(findingsRef.current) : next
    findingsRef.current = value
    setFindingsState(value)
  }, [])
  const inspectionRef = useRef<{ token: string; blockId: string; from: number; to: number } | null>(
    null,
  )
  const [pinnedReference, setPinnedReference] = useState<RevisionReference | null>(null)
  const referenceRef = useRef<RevisionReference | null>(null)
  const [referenceOpen, setReferenceOpenState] = useState(false)
  const referenceOpenRef = useRef(false)
  const referenceIntent = useRef(0)
  const setReferenceOpen = (open: boolean) => {
    referenceOpenRef.current = open
    referenceIntent.current++
    setReferenceOpenState(open)
  }
  const setReference = (value: RevisionReference | null) => {
    referenceRef.current = value
    setPinnedReference(value)
  }
  useEffect(() => {
    if (referenceRef.current && referenceRef.current.sessionToken !== session?.token) {
      setReference(null)
      setReferenceOpen(false)
    }
  }, [session?.token])
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
    feedbackSnapshots = useRef(new FeedbackSnapshots()),
    history = useRef(new AnalysisHistory()),
    pendingRestore = useRef<string | null>(null),
    provider = useRef<AIProvider>(new OpenAICompatibleProvider()),
    running = useRef<AbortController | null>(null)
  const closePending = useRef(false)
  const leavePending = useRef<Promise<boolean> | null>(null)
  const askRef = useRef(ask)
  askRef.current = ask
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
    if (leavePending.current) return leavePending.current
    leavePending.current = new Promise<boolean>((resolve) => setUnsaved(() => resolve)).finally(
      () => {
        leavePending.current = null
      },
    )
    return leavePending.current
  }
  proceedRef.current = confirmLeave
  const persistAnalysis = async () => {
    if (project)
      await storage.setMetadata(
        'analysis',
        {
          version: 2,
          cache: cache.current.export(),
          reviews: savedReviews.current.export(),
          feedback: feedbackSnapshots.current.export(),
          history: history.current.export(),
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
      await storage.setMetadata('project', meta.current, project?.root)
    } catch {
      showNotice(
        'Document opened. Project metadata could not be saved; Markdown is unaffected.',
        true,
      )
    }
  }
  const openProject = async (path?: string) => {
    if (!(await confirmLeave())) return
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
  const refreshTree = async () => {
    const entries = await storage.list()
    setProject((old) => (old ? { ...old, entries } : null))
  }
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
        feedbackSnapshots.current.capture(
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
    if (pinned?.sessionToken === active.token)
      setReference(mapRevisionReference(pinned, before, snap, transaction))
    markDirty(true)
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
  const retainedReference =
    pinnedReference?.sessionToken === session?.token ? pinnedReference : null
  const reference = referenceOpen ? retainedReference : null
  const canResumeRevision = !!retainedReference && !referenceOpen
  const selectedForRevision = findings.find((finding) => finding.id === selected)
  const reviseAsNew = !!(
    canResumeRevision &&
    retainedReference &&
    selectedForRevision &&
    !canResumeRevisionReference(retainedReference, selectedForRevision, findings)
  )
  const referenceView = reference
    ? referenceState(reference, current, findings, dismissed, analyzers, settings, profile)
    : null
  const referenceReviewer = reference
    ? analyzers.find((a) => a.id === reference.finding.analyzerId)
    : undefined
  const referenceScope: Scope | null = referenceReviewer?.scopes.includes('block')
    ? 'block'
    : referenceReviewer?.scopes.includes('document')
      ? 'document'
      : referenceReviewer?.scopes.includes('selection')
        ? 'selection'
        : null
  const canReviewReference =
    !!referenceReviewer &&
    !!referenceScope &&
    (enabled(referenceReviewer.id) ||
      (referenceReviewer.origin === 'custom' && globallyEnabled(settings, referenceReviewer.id))) &&
    (referenceScope === 'document' ||
      (referenceScope === 'block' ? !!referenceView?.reviewLocation : !!referenceView?.location)) &&
    (referenceScope !== 'selection' ||
      referenceView!.location!.to > referenceView!.location!.from) &&
    !busy &&
    !fileBusy &&
    !saving
  const showRevision = (pin: RevisionReference) => {
    const active = sessionRef.current,
      editor = editorRef.current
    if (
      !active ||
      pin.sessionToken !== active.token ||
      !editor?.isEditable ||
      fileLock.current ||
      saveLock.current
    )
      return
    setReference(pin)
    setReferenceOpen(true)
    const view = referenceState(
      pin,
      snapshot(editor, active.id, revision.current),
      findingsRef.current,
      dismissed,
      createAnalyzerRegistry(settingsRef.current),
      settingsRef.current,
      meta.current.documents[active.path]?.profile ?? profile,
    )
    if (view.location) editor.chain().focus().setTextSelection(view.location).scrollIntoView().run()
    else editor.commands.focus(undefined, { scrollIntoView: false })
    // Explicit opening changes the viewport. Never scroll automatically while editing.
    requestAnimationFrame(() => {
      if (
        !editor.isDestroyed &&
        referenceOpenRef.current &&
        referenceRef.current === pin &&
        sessionRef.current?.token === active.token &&
        view.location
      )
        editor.commands.scrollIntoView()
    })
  }
  const resumeRevision = () => {
    const pin = referenceRef.current
    if (pin) showRevision(pin)
  }
  const beginRevision = (finding: Diagnostic) => {
    const active = sessionRef.current,
      editor = editorRef.current
    if (!active || !editor?.isEditable || fileLock.current || saveLock.current) return
    const retained = referenceRef.current
    if (
      !referenceOpenRef.current &&
      retained?.sessionToken === active.token &&
      canResumeRevisionReference(retained, finding, findingsRef.current)
    ) {
      showRevision(retained)
      return
    }
    const live = findingsRef.current.find((f) => f.id === finding.id)
    if (!live) return
    const replacement =
      finding.replacement !== undefined &&
      (live.replacements?.includes(finding.replacement) || finding.replacement === live.replacement)
        ? finding.replacement
        : live.replacement
    const label = analyzers.find((a) => a.id === live.analyzerId)?.name ?? live.analyzerId
    const pin = captureRevisionReference(
      { ...live, replacement },
      snapshot(editor, active.id, revision.current),
      active.token,
      label,
    )
    if (!pin) {
      showNotice('This passage changed. Choose a current finding to revise.', true)
      return
    }
    const latest = referenceRef.current?.latestFindings
    if (
      referenceRef.current?.capturedHash === pin.capturedHash &&
      latest?.some((item) => item.id === pin.finding.id)
    )
      pin.latestFindings = latest
    showRevision(pin)
  }
  const closeRevision = () => {
    // Hide, don't discard: onChange keeps mapping this capture while it is closed.
    setReferenceOpen(false)
    editorRef.current?.commands.focus(undefined, { scrollIntoView: false })
  }
  const chooseRevisionFinding = () => {
    setReferenceOpen(false)
    setRightOpen(true)
    setSelected(null)
  }
  const currentReference = () => {
    const pin = referenceRef.current,
      active = sessionRef.current,
      editor = editorRef.current
    if (
      !referenceOpenRef.current ||
      !pin ||
      !active ||
      pin.sessionToken !== active.token ||
      !editor ||
      editor.isDestroyed
    )
      return null
    const input = snapshot(editor, active.id, revision.current)
    const activeProfile = meta.current.documents[active.path]?.profile ?? profile
    return {
      pin,
      editor,
      view: referenceState(
        pin,
        input,
        findings,
        dismissed,
        createAnalyzerRegistry(settingsRef.current),
        settingsRef.current,
        activeProfile,
      ),
    }
  }
  const jumpRevision = () => {
    const current = currentReference()
    if (current?.view.location)
      current.editor.chain().focus().setTextSelection(current.view.location).scrollIntoView().run()
    else
      showNotice(
        'The reference passage moved, split, or was removed. No other occurrence was selected.',
        true,
      )
  }
  const rereviewRevision = async () => {
    const current = currentReference()
    if (!current || !referenceScope || !canReviewReference) return
    const intent = referenceIntent.current
    if (referenceScope !== 'document') {
      const location =
        referenceScope === 'block' ? current.view.reviewLocation : current.view.location
      if (!location || (referenceScope === 'selection' && location.from === location.to)) return
      current.editor
        .chain()
        .focus()
        .setTextSelection(referenceScope === 'selection' ? location : location.from)
        .run()
    }
    const input = snapshot(current.editor, sessionRef.current!.id, revision.current)
    // Explicit re-review asks for current advice, not an old request-cache entry.
    const results = await run(referenceScope, current.pin.finding.analyzerId, true)
    const active = sessionRef.current
    const pinned = referenceRef.current
    if (
      !results ||
      !referenceOpenRef.current ||
      referenceIntent.current !== intent ||
      !active ||
      current.editor.isDestroyed ||
      active.token !== current.pin.sessionToken ||
      !pinned ||
      pinned.capturedAt !== current.pin.capturedAt ||
      pinned.finding.id !== current.pin.finding.id
    )
      return
    const after = snapshot(current.editor, active.id, revision.current)
    if (after.hash !== input.hash) return
    const relevant = results.filter(
      (finding) =>
        finding.analyzerId === current.pin.finding.analyzerId &&
        (referenceScope === 'document' || finding.blockId === current.pin.finding.blockId),
    )
    if (relevant.length) {
      const chosen =
        relevant.find((finding) => finding.id === current.pin.finding.id) ?? relevant[0]
      const fresh = captureRevisionReference(chosen, after, active.token, current.pin.reviewer)
      if (fresh) setReference({ ...fresh, latestFindings: relevant })
    } else {
      const block = after.blocks.find((block) => block.id === current.pin.finding.blockId)
      setReference({
        ...pinned,
        latestFindings: [],
        cleanReview: {
          profile,
          analyzerVersion: referenceReviewer!.version,
          configurationHash: configurationHash(
            effectiveConfig(settingsRef.current, current.pin.finding.analyzerId),
          ),
          hash: after.hash,
          text:
            referenceScope === 'document'
              ? after.blocks.map((block) => block.text).join('\n\n')
              : (block?.text ?? ''),
          at: Date.now(),
        },
      })
    }
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
  const acceptRevision = (alternative = 0) => {
    const current = currentReference()
    if (
      !current?.view.canApply ||
      !current.view.finding ||
      !current.editor.isEditable ||
      fileLock.current ||
      saveLock.current
    ) {
      showNotice(
        'This reference is no longer applicable. Re-review or choose a current finding.',
        true,
      )
      return
    }
    const original = current.pin.finding
    const variants = original.replacements?.length
      ? original.replacements
      : original.replacement !== undefined
        ? [original.replacement]
        : []
    const replacement = variants[alternative]
    if (original.action !== 'replace' || replacement === undefined) return
    accept({ ...current.view.finding, replacement })
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
