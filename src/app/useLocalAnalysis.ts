import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { Snapshot, Diagnostic } from '../diagnostics/types'
import type { Analyzer } from '../analyzers/types'
import type { AIProvider } from '../ai/types'
import type { Settings } from '../settings/model'
import { effectiveConfig } from '../settings/model'
import { analyzerEnabled } from '../profiles/profiles'
import { runAnalyzer } from '../analyzers/runner'
import { refreshDiagnostic } from '../diagnostics/mapping'
import type { AnalysisCache } from '../analyzers/cache'
import { errorMessage } from '../storage/desktop'
export interface LocalAnalysisContext {
  current: Snapshot | null
  currentRef: RefObject<Snapshot | null>
  settings: Settings
  profile: string
  analyzers: Analyzer[]
  cache: RefObject<AnalysisCache>
  provider: RefObject<AIProvider>
  setFindings: Dispatch<SetStateAction<Diagnostic[]>>
  showNotice: (message: string, error?: boolean) => void
}
export function useLocalAnalysis({
  current,
  currentRef,
  settings,
  profile,
  analyzers,
  cache,
  provider,
  setFindings,
  showNotice,
}: LocalAnalysisContext) {
  const enabled = (id: string) => analyzerEnabled(settings, id, profile)
  // Invalidate publication as soon as new props render, even before effect cleanup.
  const activation = useRef({ current, settings, profile, analyzers })
  if (
    activation.current.current !== current ||
    activation.current.settings !== settings ||
    activation.current.profile !== profile ||
    activation.current.analyzers !== analyzers
  )
    activation.current = { current, settings, profile, analyzers }
  // Automatic local rule checks only; never semantic AI calls.
  useEffect(() => {
    const generation = activation.current
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
      const isCurrent = () => {
        const live = currentRef.current
        return (
          !controller.signal.aborted &&
          activation.current === generation &&
          !!live &&
          live.documentId === input.documentId &&
          live.hash === input.hash
        )
      }
      void (async () => {
        for (const analyzer of localAnalyzers.filter(
          (a) => enabled(a.id) && (a.id !== 'harper' || settings.analysis.autoHarper),
        )) {
          if (!isCurrent()) return
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
            if (!isCurrent()) return
            if (result.warnings.length) showNotice(result.warnings.slice(0, 3).join(' '), true)
            setFindings((old) => [
              ...old.filter((f) => f.analyzerId !== analyzer.id),
              ...result.findings.flatMap((f) => {
                const next = refreshDiagnostic(f, currentRef.current!)
                return next ? [next] : []
              }),
            ])
          } catch (error) {
            if (isCurrent()) showNotice(`${analyzer.name}: ${errorMessage(error)}`, true)
          }
        }
      })()
    }, 350)
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
    // Profile and settings are dependencies because they control rule activation.
  }, [current, settings, profile, analyzers])
}
