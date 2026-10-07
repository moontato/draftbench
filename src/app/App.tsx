import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  PanelLeftClose,
  PanelRightClose,
  PenLine,
  Plus,
  Save,
  Settings2,
  Sparkles,
  X,
  Maximize2,
  ArrowRight,
  Circle,
  MoreHorizontal,
} from 'lucide-react'
import {
  storage,
  desktopAvailable,
  errorMessage,
  type FileEntry,
  type Project,
} from '../storage/desktop'
import { defaultSettings, effectiveConfig, settingsSchema, type Settings } from '../settings/model'
import { SettingsDialog } from '../settings/SettingsDialog'
import { WritingEditor } from '../editor/WritingEditor'
import { snapshot } from '../editor/blocks'
import { applyFix, decorate, jumpTo } from '../editor/diagnostics'
import { readMarkdown, writeMarkdown, type MarkdownFile } from '../documents/markdown'
import { RecentProjects } from '../documents/RecentProjects'
import {
  RECENT_PROJECT_LIMIT,
  parseRecentProjects,
  type RecentProject,
} from '../storage/recentProjects'
import { ProblemsPanel } from '../diagnostics/ProblemsPanel'
import { AnalysisHistoryDialog } from '../diagnostics/AnalysisHistoryDialog'
import { refreshDiagnostic } from '../diagnostics/mapping'
import type { Diagnostic, Snapshot, Scope } from '../diagnostics/types'
import { analyzers } from '../analyzers/registry'
import { planScope, runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { SavedReviews } from '../analyzers/savedReviews'
import { AnalysisHistory } from '../analyzers/history'
import { OpenAICompatibleProvider } from '../ai/providers/openai'
import { canonical, hash } from '../diagnostics/hash'
import { profiles, type ProfileId } from '../profiles/profiles'
import { Modal } from '../ui/Modal'
import { useNotice } from '../ui/useNotice'
interface Session {
  path: string
  id: string
  token: string
  source: MarkdownFile
  diskHash: string
  original: string
}
interface ProjectMeta {
  version: 1
  documents: Record<string, { id: string; profile: ProfileId }>
}
interface Ask {
  title: string
  description: string
  initial: string
  resolve: (answer: string | null) => void
}
function FileTree({
  entries,
  selected,
  onOpen,
  onAction,
}: {
  entries: FileEntry[]
  selected?: string
  onOpen: (path: string) => void
  onAction: (entry: FileEntry) => void
}) {
  return (
    <ul className="file-tree">
      {entries.map((entry) => (
        <li key={entry.path}>
          {entry.folder ? (
            <details open>
              <summary>
                <Folder size={15} />
                <span>{entry.name}</span>
                <button
                  className="tree-action"
                  aria-label={`Actions for ${entry.name}`}
                  onClick={(e) => {
                    e.preventDefault()
                    onAction(entry)
                  }}
                >
                  <MoreHorizontal size={15} />
                </button>
              </summary>
              <FileTree
                entries={entry.children}
                selected={selected}
                onOpen={onOpen}
                onAction={onAction}
              />
            </details>
          ) : (
            <div className={`tree-row ${selected === entry.path ? 'selected' : ''}`}>
              <button onClick={() => onOpen(entry.path)}>
                <FileText size={15} />
                <span>{entry.name.replace(/\.md$/i, '')}</span>
              </button>
              <button
                className="tree-action"
                aria-label={`Actions for ${entry.name}`}
                onClick={() => onAction(entry)}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
export function App() {
  const [project, setProject] = useState<Project | null>(null),
    [session, setSession] = useState<Session | null>(null)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [recentErrors, setRecentErrors] = useState<Record<string, boolean>>({})
  const recentRevision = useRef(0)
  const [settings, setSettings] = useState(defaultSettings),
    settingsRef = useRef(settings)
  const [settingsLoaded, setSettingsLoaded] = useState(!desktopAvailable)
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
  const { notice, showNotice, dismissNotice } = useNotice()
  const [profile, setProfile] = useState<ProfileId>('general'),
    [ask, setAsk] = useState<Ask | null>(null),
    [askValue, setAskValue] = useState('')
  const [unsaved, setUnsaved] = useState<((proceed: boolean) => void) | null>(null),
    [entryActions, setEntryActions] = useState<FileEntry | null>(null)
  const editorRef = useRef<Editor | null>(null),
    sessionRef = useRef(session),
    revision = useRef(0)
  const meta = useRef<ProjectMeta>({ version: 1, documents: {} })
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
  settingsRef.current = settings
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
        version: 1,
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
    let active = true
    const startedAtRevision = recentRevision.current
    void storage
      .loadRecentProjects()
      .then((projects) => {
        if (active && recentRevision.current === startedAtRevision) setRecentProjects(projects)
      })
      .catch((error) => {
        if (active && recentRevision.current === startedAtRevision)
          showNotice(errorMessage(error), true)
      })
    return () => {
      active = false
    }
  }, [showNotice])
  useEffect(() => {
    if (!desktopAvailable) return
    void storage
      .loadSettings()
      .then((raw) => {
        if (raw) setSettings(settingsSchema.parse(raw))
      })
      .catch((error) => showNotice(errorMessage(error), true))
      .finally(() => setSettingsLoaded(true))
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
    setProfile(document.profile)
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
  const removeRecentProject = async (path: string) => {
    recentRevision.current++
    const projects = await storage.removeRecentProject(path)
    setRecentProjects(projects)
    setRecentErrors((old) => {
      const next = { ...old }
      delete next[path]
      return next
    })
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
    recentRevision.current++
    if (selectedProject.recentProjects) {
      try {
        setRecentProjects(parseRecentProjects(selectedProject.recentProjects))
      } catch (error) {
        showNotice(errorMessage(error), true)
      }
    } else {
      // Retain a session-only MRU entry if app-config persistence is unavailable.
      const opened = {
        path: selectedProject.root,
        name: selectedProject.name,
        lastOpened: Date.now(),
      }
      setRecentProjects((old) =>
        [opened, ...old.filter((p) => p.path !== opened.path)].slice(0, RECENT_PROJECT_LIMIT),
      )
    }
    setRecentErrors((old) => {
      const next = { ...old }
      delete next[selectedProject.root]
      return next
    })
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
    meta.current = { version: 1, documents: {} }
    try {
      const raw = (await storage.metadata('project')) as ProjectMeta | null
      if (raw && raw.version === 1 && raw.documents && typeof raw.documents === 'object') {
        for (const [path, doc] of Object.entries(raw.documents))
          if (
            doc &&
            /\.md$/i.test(path) &&
            typeof doc.id === 'string' &&
            Object.hasOwn(profiles, doc.profile)
          )
            meta.current.documents[path] = doc
      }
      const analysis = (await storage.metadata('analysis')) as {
        version: number
        cache: unknown
        reviews?: unknown
        history?: unknown
      } | null
      if (analysis?.version === 1) {
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
        history.current.recoverSavedReviews(savedReviews.current.summaries(), analyzers)
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
  const enabled = (id: string) =>
    (settings.analyzers[id]?.enabled ?? true) && profiles[profile].enabled.includes(id)
  // Automatic local rule checks only; never semantic AI calls.
  useEffect(() => {
    const localAnalyzers = analyzers.filter((a) => a.engine === 'deterministic')
    setFindings((old) =>
      old.filter(
        (f) => !localAnalyzers.some((a) => a.id === f.analyzerId && (!current || !enabled(a.id))),
      ),
    )
    if (!current) return
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      const input = { ...current, selection: undefined }
      void (async () => {
        for (const analyzer of localAnalyzers.filter((a) => enabled(a.id))) {
          try {
            const result = await runAnalyzer(
              analyzer,
              input,
              'document',
              effectiveConfig(settings, analyzer.id),
              provider.current,
              controller.signal,
              cache.current,
            )
            if (controller.signal.aborted || !currentRef.current) return
            setFindings((old) => [
              ...old.filter((f) => f.analyzerId !== analyzer.id),
              ...result.findings.flatMap((f) => {
                const next = refreshDiagnostic(f, currentRef.current!)
                return next ? [next] : []
              }),
            ])
          } catch (error) {
            if (!controller.signal.aborted)
              showNotice(`${analyzer.name}: ${errorMessage(error)}`, true)
          }
        }
      })()
    }, 350)
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
    // Profile and settings are dependencies because they control rule activation.
  }, [current, settings, profile])
  const run = async (scope: Scope = 'document', analyzerId?: string, force = false) => {
    const editor = editorRef.current,
      active = sessionRef.current
    if (!editor || !active || busy || !settingsLoaded) return
    const input = snapshot(editor, active.id, revision.current)
    if (scope !== 'selection') input.selection = undefined
    if (scope === 'selection' && !input.selection) {
      showNotice('Select the passage you want to analyze first.', true)
      return
    }
    const targets = analyzers.filter(
      (a) => (!analyzerId || a.id === analyzerId) && enabled(a.id) && a.scopes.includes(scope),
    )
    if (!targets.length) {
      showNotice(
        'No enabled analyzers support this scope. Check the profile and Analysis settings.',
        true,
      )
      return
    }
    const serializedHash = hash(writeMarkdown(active.source, editor.getMarkdown()))
    const markdownHash = dirtyRef.current ? serializedHash : active.diskHash
    let reviewedFindings = [...findings]
    const controller = new AbortController()
    let historyId = ''
    try {
      historyId = history.current.start(
        active.id,
        serializedHash,
        scope,
        profile,
        force,
        targets,
        settingsRef.current,
      )
    } catch (error) {
      showNotice(errorMessage(error), true)
    }
    const recordHistory = (
      reviewerId: string,
      result: Parameters<AnalysisHistory['update']>[2],
    ) => {
      history.current.update(historyId, reviewerId, result)
      setHistoryRevision((old) => old + 1)
    }
    const cancelHistory = () => {
      history.current.finish(historyId, true)
      setHistoryRevision((old) => old + 1)
      void persistRef
        .current()
        .catch(() => showNotice('Analysis history could not be saved.', true))
    }
    controller.signal.addEventListener('abort', cancelHistory, { once: true })
    setHistoryRevision((old) => old + 1)
    running.current = controller
    setBusy(true)
    setRightOpen(true)
    let count = 0,
      hits = 0,
      discarded = 0
    const errors: string[] = []
    for (const analyzer of targets) {
      if (controller.signal.aborted) break
      setStatus(`Reviewing with ${analyzer.name}…`)
      recordHistory(analyzer.id, { status: 'running' })
      const config = effectiveConfig(settingsRef.current, analyzer.id),
        configHash = hash(canonical(config))
      try {
        const result = await runAnalyzer(
          analyzer,
          input,
          scope,
          config,
          provider.current,
          controller.signal,
          cache.current,
          force,
        )
        if (
          controller.signal.aborted ||
          !currentRef.current ||
          hash(canonical(effectiveConfig(settingsRef.current, analyzer.id))) !== configHash
        ) {
          if (!controller.signal.aborted)
            recordHistory(analyzer.id, {
              status: 'stale',
              cacheHits: result.cacheHits,
              requests: result.requests,
              discarded: result.findings.length,
            })
          continue
        }
        const fresh = result.findings.flatMap((f) => {
          const refreshed = refreshDiagnostic(f, currentRef.current!)
          return refreshed ? [refreshed] : []
        })
        recordHistory(analyzer.id, {
          status: result.warnings.length
            ? 'warnings'
            : result.findings.length !== fresh.length
              ? 'stale'
              : 'completed',
          findings: fresh.length,
          cacheHits: result.cacheHits,
          requests: result.requests,
          warnings: result.warnings.length,
          discarded: result.findings.length - fresh.length,
        })
        discarded += result.findings.length - fresh.length
        count += fresh.length
        hits += result.cacheHits
        const targetIds = new Set(
          planScope(analyzer, input, scope).flatMap((unit) => unit.targets.map((b) => b.id)),
        )
        reviewedFindings = [
          ...reviewedFindings.filter(
            (f) => f.analyzerId !== analyzer.id || !targetIds.has(f.blockId),
          ),
          ...fresh,
        ]
        setFindings((old) => [
          ...old.filter((f) => f.analyzerId !== analyzer.id || !targetIds.has(f.blockId)),
          ...fresh,
        ])
        errors.push(...result.warnings)
      } catch (error) {
        if (!controller.signal.aborted) {
          recordHistory(analyzer.id, { status: 'failed' })
          errors.push(`${analyzer.name}: ${errorMessage(error)}`)
        }
      }
    }
    controller.signal.removeEventListener('abort', cancelHistory)
    history.current.finish(historyId, controller.signal.aborted)
    setHistoryRevision((old) => old + 1)
    if (running.current !== controller) return
    setBusy(false)
    running.current = null
    setStatus(
      controller.signal.aborted
        ? 'Analysis cancelled.'
        : `${count} findings · ${hits} cached reviews${discarded ? ` · ${discarded} stale results discarded` : ''}${errors.length ? ' · completed with warnings' : ''}`,
    )
    if (errors.length) showNotice(errors.join(' '), true)
    else if (!controller.signal.aborted)
      showNotice('Analysis complete. Review each suggestion before applying it.')
    if (
      !controller.signal.aborted &&
      !errors.length &&
      !discarded &&
      sessionRef.current?.token === active.token &&
      currentRef.current?.hash === input.hash &&
      serializedHash === hash(writeMarkdown(active.source, editor.getMarkdown()))
    ) {
      const valid = reviewedFindings.flatMap((f) => {
        const refreshed = refreshDiagnostic(f, currentRef.current!)
        return refreshed ? [refreshed] : []
      })
      if (
        !savedReviews.current.capture(
          currentRef.current!,
          markdownHash,
          serializedHash,
          profile,
          settingsRef.current,
          valid,
          targets.map((a) => a.id),
          scope,
        )
      )
        showNotice('Analysis complete, but a reopenable saved review could not be recorded.', true)
    }
    try {
      await persistAnalysis()
    } catch {
      showNotice('Analysis complete, but the local review/cache could not be saved.', true)
    }
  }
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
    await storage.saveSettings(parsed)
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
        profile,
        parsed,
      )
    )
      setStatus('Analysis settings changed since the saved review.')
    setFindings((old) =>
      old.filter(
        (f) =>
          (parsed.analyzers[f.analyzerId]?.enabled ?? true) &&
          f.configurationHash === hash(canonical(effectiveConfig(parsed, f.analyzerId))),
      ),
    )
    showNotice('Settings saved locally.')
  }
  const words =
    current?.blocks.reduce((n, b) => n + (b.text.trim().match(/\S+/g)?.length ?? 0), 0) ?? 0
  const title = session?.path.split('/').pop()?.replace(/\.md$/i, '')
  return (
    <div
      className="app-shell"
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('.action-menu summary'))
          document.querySelectorAll<HTMLDetailsElement>('.action-menu[open]').forEach((menu) => {
            menu.open = false
          })
      }}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <PenLine size={19} />
          </div>
          <span>Draftbench</span>
          <span className="version-tag">v0.1</span>
        </div>
        <div className="header-center">
          <span className="header-project">{project?.name ?? 'A workspace for your words'}</span>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label="Open settings"
            onClick={() => setSettingsTab('AI')}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <div
        className={`workspace ${leftOpen ? '' : 'left-hidden'} ${rightOpen ? '' : 'right-hidden'}`}
      >
        {leftOpen && (
          <aside className="documents-pane" aria-label="Project documents">
            <div className="pane-heading">
              <h2>Workspace</h2>
              <button
                className="icon-button"
                aria-label="Hide documents"
                onClick={() => setLeftOpen(false)}
              >
                <PanelLeftClose size={17} />
              </button>
            </div>
            <button
              className="open-project-button"
              disabled={!desktopAvailable}
              onClick={() => fileTask(openProject)}
            >
              <FolderOpen size={16} />
              {project ? 'Open another folder' : 'Open a folder'}
              <ChevronRight size={13} />
            </button>
            {project ? (
              <>
                <div className="project-heading">
                  <Folder size={14} />
                  <span>{project.name}</span>
                  <button
                    className="icon-button"
                    title="New document"
                    aria-label="New document"
                    onClick={() => fileTask(createDocument)}
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <div className="tree-scroll">
                  <FileTree
                    entries={project.entries}
                    selected={session?.path}
                    onOpen={(path) => fileTask(() => loadDocument(path))}
                    onAction={setEntryActions}
                  />
                  {!project.entries.length && (
                    <p className="muted small">This folder has no Markdown documents yet.</p>
                  )}
                </div>
                <div className="document-actions">
                  <button className="text-button" onClick={() => fileTask(createDocument)}>
                    <FilePlus2 size={15} />
                    New document
                  </button>
                  <button className="text-button" onClick={() => fileTask(createFolder)}>
                    <Folder size={15} />
                    New folder
                  </button>
                </div>
              </>
            ) : (
              <div className="sidebar-empty">
                <span className="eyebrow">
                  A NORMAL FOLDER.
                  <br />
                  REAL MARKDOWN FILES.
                </span>
                <p>Open your existing writing or start a new project in any folder.</p>
              </div>
            )}
            <div className="sidebar-bottom">
              <BookOpen size={15} />
              <span>Write with intention.</span>
            </div>
          </aside>
        )}
        <main className={`writing-pane ${!session ? 'welcome-pane' : ''}`}>
          <div className="document-bar">
            <div className="document-breadcrumb">
              {!leftOpen && (
                <button
                  className="icon-button"
                  aria-label="Show documents"
                  onClick={() => setLeftOpen(true)}
                >
                  <FolderOpen size={16} />
                </button>
              )}
              <FileText size={15} />
              <span>{session?.path ?? 'Your next draft'}</span>
              {dirty && <Circle size={7} fill="currentColor" />}
            </div>
            <div className="document-bar-actions">
              <button
                className="icon-button"
                aria-label="Toggle focus mode"
                title="Focus mode"
                onClick={() => {
                  const hide = leftOpen || rightOpen
                  setLeftOpen(!hide)
                  setRightOpen(!hide)
                }}
              >
                <Maximize2 size={15} />
              </button>
              <button
                className="icon-button"
                aria-label={rightOpen ? 'Hide analysis' : 'Show analysis'}
                onClick={() => setRightOpen(!rightOpen)}
              >
                <PanelRightClose size={17} />
              </button>
            </div>
          </div>
          {session ? (
            <>
              <div className="document-heading">
                <div>
                  <span className="eyebrow">
                    {profile === 'general' ? 'GENERAL PROSE' : profiles[profile].name.toUpperCase()}
                  </span>
                  <h1>{title}</h1>
                </div>
                <div className="document-heading-actions">
                  <select
                    aria-label="Writing profile"
                    value={profile}
                    onChange={(e) => task(() => changeProfile(e.target.value as ProfileId))}
                  >
                    {Object.entries(profiles).map(([id, p]) => (
                      <option key={id} value={id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="secondary-button save-button"
                    disabled={saving || !dirty || !!session.source.unsupported.length}
                    onClick={() => {
                      void save()
                    }}
                  >
                    <Save size={14} />
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <details className="action-menu">
                    <summary aria-label="Document actions">
                      <MoreHorizontal size={17} />
                    </summary>
                    <div>
                      <button
                        onClick={() => {
                          void save(true)
                        }}
                      >
                        Save a copy…
                      </button>
                      <button onClick={() => fileTask(() => loadDocument(session.path))}>
                        Reload from disk…
                      </button>
                    </div>
                  </details>
                </div>
              </div>
              {session.source.unsupported.length > 0 && (
                <div className="read-only-note">
                  Read-only: unsupported {session.source.unsupported.join(', ')}.{' '}
                  <button
                    className="text-button"
                    onClick={() => {
                      void save(true)
                    }}
                  >
                    Save a converted copy
                  </button>
                </div>
              )}
              <WritingEditor
                key={session.token}
                content={session.source.body}
                readOnly={saving || fileBusy || !!session.source.unsupported.length}
                settings={settings.editor}
                onReady={onReady}
                onChange={onChange}
                onFinding={findingClick}
                askLink={() =>
                  askName(
                    'Insert a link',
                    'Use https://, http://, or mailto:. Leave empty to remove a link.',
                    editorRef.current?.getAttributes('link').href ?? '',
                  )
                }
              />
              <div className="editor-footer">
                <span>
                  {words.toLocaleString()} words <span className="footer-separator">·</span>{' '}
                  {Math.max(1, Math.ceil(words / 220))} min read
                </span>
                <span>
                  {dirty ? 'Unsaved changes' : 'Saved locally'}{' '}
                  <span className={`save-dot ${dirty ? 'dirty' : ''}`} />
                </span>
              </div>
            </>
          ) : (
            <div className={`welcome ${!project && recentProjects.length ? 'with-recents' : ''}`}>
              <span className="eyebrow">STATIC ANALYSIS FOR WRITING</span>
              <h1>
                Make your point.
                <br />
                <em>Make it well.</em>
              </h1>
              <p>
                A quiet place to write. Thoughtful analysis to help you see what your reader might
                miss.
              </p>
              <div className="welcome-actions">
                <button
                  className="primary-button"
                  disabled={!desktopAvailable || fileBusy || saving}
                  onClick={() => fileTask(project ? createDocument : openProject)}
                >
                  <FolderOpen size={17} />
                  {project ? 'Create a document' : 'Open a writing folder'}
                  <ArrowRight size={16} />
                </button>
                <button className="text-button" onClick={() => setSettingsTab('AI')}>
                  Set up local AI <ChevronRight size={14} />
                </button>
              </div>
              {!project && desktopAvailable && (
                <RecentProjects
                  projects={recentProjects}
                  errors={recentErrors}
                  busy={fileBusy || saving}
                  onOpen={(path) => fileTask(() => openProject(path))}
                  onRemove={(path) => fileTask(() => removeRecentProject(path))}
                />
              )}
              <div className="workflow">
                <span>
                  01 <strong>Write</strong>
                </span>
                <ChevronRight size={14} />
                <span>
                  02 <strong>Analyze</strong>
                </span>
                <ChevronRight size={14} />
                <span>
                  03 <strong>Decide</strong>
                </span>
              </div>
              <div className="welcome-note">
                <PenLine size={18} />
                <p>
                  You remain the author.
                  <br />
                  <span>Suggestions are yours to accept, dismiss, or ignore.</span>
                </p>
              </div>
              {!desktopAvailable && (
                <div className="desktop-only-note">
                  This is the frontend preview. Local files and AI require the desktop app:{' '}
                  <code>npm run tauri dev</code>.
                </div>
              )}
            </div>
          )}
        </main>
        {rightOpen && (
          <ProblemsPanel
            findings={findings}
            selected={selected}
            dismissed={dismissed}
            analyzers={analyzers}
            busy={busy}
            status={status}
            hasDocument={!!session}
            canApply={!!session && !saving && !fileBusy && !session.source.unsupported.length}
            onSelect={selectFinding}
            onApply={accept}
            onDismiss={(id) => {
              setDismissed((old) => new Set([...old, id]))
              setSelected(null)
            }}
            onResetDismissed={() => setDismissed(new Set())}
            onRun={(id) => task(() => run('document', id))}
            onSettings={() => setSettingsTab('Analysis')}
            onHistory={() => setHistoryOpen(true)}
          />
        )}
      </div>
      <footer className="app-footer">
        <div>
          <span className="local-dot" />
          <span>{project ? 'Markdown project' : 'No project open'}</span>
          <span className="footer-separator">/</span>
          <span className="footer-endpoint" title={settings.ai.serverUrl}>
            {settings.ai.serverUrl}
          </span>
        </div>
        <div className="run-controls">
          {session && (
            <>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => task(() => run('selection'))}
              >
                Analyze selection
              </button>
              <details className="action-menu upward">
                <summary>
                  <span>Run analyzer</span>
                  <ChevronDown size={13} />
                </summary>
                <div>
                  <button disabled={busy} onClick={() => task(() => run('block'))}>
                    Analyze current paragraph
                  </button>
                  {analyzers.map((a) => (
                    <button
                      key={a.id}
                      disabled={busy || !enabled(a.id)}
                      onClick={() => task(() => run('document', a.id))}
                    >
                      {a.name}
                    </button>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() => task(() => run('document', undefined, true))}
                  >
                    Force rerun all
                  </button>
                </div>
              </details>
              <button
                className="primary-button"
                disabled={!!session.source.unsupported.length}
                onClick={() => (busy ? running.current?.abort() : task(() => run()))}
              >
                {busy ? <X size={14} /> : <Sparkles size={14} />}{' '}
                {busy ? 'Cancel analysis' : 'Analyze document'}
              </button>
            </>
          )}
        </div>
      </footer>
      {notice && (
        <div
          className={`notice ${notice.error ? 'notice-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          <span>{notice.message}</span>
          <button className="icon-button" aria-label="Dismiss notification" onClick={dismissNotice}>
            <X size={14} />
          </button>
        </div>
      )}
      {historyOpen && session && (
        <AnalysisHistoryDialog
          runs={history.current.forDocument(session.id)}
          documentName={session.path}
          currentHash={
            editorRef.current
              ? hash(writeMarkdown(session.source, editorRef.current.getMarkdown()))
              : undefined
          }
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {settingsTab && (
        <SettingsDialog
          settings={settings}
          initialTab={settingsTab}
          provider={provider.current}
          onSave={saveSettings}
          onWarning={(message) => showNotice(message, true)}
          onClose={() => setSettingsTab(null)}
          onCredentialChange={() => {
            running.current?.abort()
            cache.current.clear()
            savedReviews.current.clear()
            setStatus('')
            setFindings([])
            const next = {
              ...settingsRef.current,
              ai: {
                ...settingsRef.current.ai,
                credentialGeneration: settingsRef.current.ai.credentialGeneration + 1,
              },
            }
            settingsRef.current = next
            setSettings(next)
            task(() => storage.saveSettings(next))
            task(() => persistRef.current())
          }}
          onClearCache={() => {
            running.current?.abort()
            cache.current.clear()
            savedReviews.current.clear()
            history.current.clear()
            setHistoryRevision((old) => old + 1)
            setStatus('')
            setFindings([])
            setDismissed(new Set())
            task(async () => {
              await persistRef.current()
              showNotice('Analysis cache cleared.')
            })
          }}
        />
      )}
      {ask && (
        <Modal
          onEscape={() => {
            ask.resolve(null)
            setAsk(null)
          }}
        >
          <form
            className="small-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={ask.title}
            onSubmit={(e) => {
              e.preventDefault()
              ask.resolve(askValue)
              setAsk(null)
            }}
          >
            <h2>{ask.title}</h2>
            <p>{ask.description}</p>
            <input
              autoFocus
              value={askValue}
              onChange={(e) => setAskValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  ask.resolve(null)
                  setAsk(null)
                }
              }}
            />
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  ask.resolve(null)
                  setAsk(null)
                }}
              >
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Continue
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {unsaved && (
        <Modal
          onEscape={() => {
            unsaved(false)
            setUnsaved(null)
          }}
        >
          <div
            className="small-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved changes"
          >
            <h2>Keep your changes?</h2>
            <p>
              This draft has unsaved changes. Save them before continuing, or discard them
              explicitly.
            </p>
            <footer>
              <button
                className="secondary-button"
                onClick={() => {
                  unsaved(false)
                  setUnsaved(null)
                }}
              >
                Cancel
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  unsaved(true)
                  setUnsaved(null)
                }}
              >
                Discard
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  const resolve = unsaved
                  setUnsaved(null)
                  void saveRef.current().then(resolve)
                }}
              >
                Save
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {entryActions && (
        <Modal onEscape={() => setEntryActions(null)}>
          <div className="small-dialog" role="dialog" aria-modal="true" aria-label="File actions">
            <h2>{entryActions.name}</h2>
            <p>{entryActions.path}</p>
            <footer>
              <button className="secondary-button" onClick={() => setEntryActions(null)}>
                Cancel
              </button>
              <button
                className="secondary-button"
                onClick={() => fileTask(() => renameEntry(entryActions))}
              >
                Rename
              </button>
              <button
                className="danger-button"
                onClick={() => fileTask(() => deleteEntry(entryActions))}
              >
                Delete
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  )
}
