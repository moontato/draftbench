import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Editor } from '@tiptap/core'
import type { Session } from './workspaceTypes'
import type { Analyzer } from '../analyzers/types'
import type { Diagnostic, Snapshot, Scope } from '../diagnostics/types'
import type { Settings } from '../settings/model'
import type { AIProvider } from '../ai/types'
import type { ProfileId } from '../profiles/profiles'
import { effectiveConfig, configurationHash } from '../settings/model'
import { snapshot } from '../editor/blocks'
import { writeMarkdown } from '../documents/markdown'
import { hash } from '../diagnostics/hash'
import { refreshDiagnostic } from '../diagnostics/mapping'
import { planScope, runAnalyzer } from '../analyzers/runner'
import { createAnalysisJobs, mapConcurrent } from '../analyzers/jobs'
import { AnalysisCache } from '../analyzers/cache'
import { SavedReviews } from '../analyzers/savedReviews'
import { AnalysisHistory } from '../analyzers/history'
import { errorMessage } from '../storage/desktop'
type Setter<T> = Dispatch<SetStateAction<T>>
export interface ReviewRunContext {
  editorRef: RefObject<Editor | null>
  sessionRef: RefObject<Session | null>
  currentRef: RefObject<Snapshot | null>
  settingsRef: RefObject<Settings>
  running: RefObject<AbortController | null>
  revision: RefObject<number>
  dirtyRef: RefObject<boolean>
  cache: RefObject<AnalysisCache>
  savedReviews: RefObject<SavedReviews>
  history: RefObject<AnalysisHistory>
  provider: RefObject<AIProvider>
  persistRef: RefObject<() => Promise<void>>
  persistAnalysis: () => Promise<void>
  busy: boolean
  settingsLoaded: boolean
  profile: ProfileId
  findings: Diagnostic[]
  analyzers: Analyzer[]
  enabled: (id: string) => boolean
  showNotice: (message: string, error?: boolean) => void
  setHistoryRevision: Setter<number>
  setBusy: Setter<boolean>
  setRightOpen: Setter<boolean>
  setStatus: Setter<string>
  setFindings: Setter<Diagnostic[]>
}
// Rendering-independent run lifecycle. All reviewers use the common runner.
export function createReviewRun(context: ReviewRunContext) {
  const {
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
  } = context
  return async (scope: Scope = 'document', analyzerId?: string, force = false) => {
    const editor = editorRef.current,
      active = sessionRef.current
    if (!editor || !active || busy || running.current || !settingsLoaded) return
    const input = snapshot(editor, active.id, revision.current)
    if (scope !== 'selection') input.selection = undefined
    if (scope === 'selection' && !input.selection) {
      showNotice('Select the passage you want to analyze first.', true)
      return
    }
    const targets = analyzers.filter(
      (a) =>
        (!analyzerId || a.id === analyzerId) &&
        (enabled(a.id) ||
          (a.origin === 'custom' &&
            analyzerId === a.id &&
            (settingsRef.current.analyzers[a.id]?.enabled ?? true) &&
            (settingsRef.current.customAnalyzers.find((entry) => entry.id === a.id)?.enabled ??
              false))) &&
        a.scopes.includes(scope),
    )
    if (!targets.length) {
      showNotice(
        'No enabled analyzers support this scope. Check the profile and Analysis settings.',
        true,
      )
      return
    }
    const runSettings = settingsRef.current
    const jobs = createAnalysisJobs(targets, runSettings)
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
        runSettings,
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
    const activeReviewers = new Map<string, string>()
    const updateProgress = () => {
      if (controller.signal.aborted || running.current !== controller) return
      setStatus(
        jobs.limit === 1
          ? `Reviewing with ${activeReviewers.values().next().value ?? 'reviewers'}…`
          : `Reviewing · ${activeReviewers.size} active reviewers · up to ${jobs.limit} parallel AI jobs…`,
      )
    }
    const reviewerSlots =
      runSettings.backends.length > 1 || !runSettings.analysis.legacySingleModel
        ? targets.length
        : jobs.limit
    await mapConcurrent(targets, reviewerSlots, async (analyzer) => {
      if (controller.signal.aborted) return
      activeReviewers.set(analyzer.id, analyzer.name)
      updateProgress()
      recordHistory(analyzer.id, { status: 'running' })
      try {
        const config = effectiveConfig(runSettings, analyzer.id),
          configHash = configurationHash(config)
        const result = await runAnalyzer(
          analyzer,
          input,
          scope,
          config,
          provider.current,
          controller.signal,
          cache.current,
          force,
          jobs,
          runSettings.analysis,
        )
        if (
          controller.signal.aborted ||
          !currentRef.current ||
          configurationHash(effectiveConfig(settingsRef.current, analyzer.id)) !== configHash
        ) {
          if (!controller.signal.aborted)
            recordHistory(analyzer.id, {
              status: 'stale',
              cacheHits: result.cacheHits,
              requests: result.requests,
              discarded: result.findings.length,
            })
          return
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
      } finally {
        activeReviewers.delete(analyzer.id)
        updateProgress()
      }
    })
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
}
