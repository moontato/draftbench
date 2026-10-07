import type { Analyzer } from './types'
import { effectiveConfig, normalizeBackendUrl, type Settings } from '../settings/model'
import { normalizeServer } from '../ai/providers/openai'

// Only reviewers selected for this run matter; local rules have no model.
export function analysisParallelism(analyzers: Analyzer[], settings: Settings): number {
  const ai = analyzers.filter((a) => a.engine === 'ai')
  if (!ai.length) return 1
  if (settings.backends.length > 1 || !settings.analysis.legacySingleModel)
    return settings.analysis.parallelJobs
  try {
    const identities = ai.map((a) => {
      const config = effectiveConfig(settings, a.id)
      return JSON.stringify([normalizeServer(config.serverUrl), config.model])
    })
    return new Set(identities).size === 1 ? settings.analysis.parallelJobs : 1
  } catch {
    return 1 // Invalid configuration is reported by the reviewer, not the scheduler.
  }
}

// Preserve input order, stop assigning work on failure, and drain in-flight work
// before rejecting. No request may outlive the run's completion/history boundary.
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++
        try {
          results[index] = await action(items[index])
        } catch (error) {
          failed = true
          failure ??= error
        }
      }
    }),
  )
  if (failed) throw failure
  return results
}

// A single queue owns both limits; waiting for a backend never holds a global slot.
// It scans for runnable work, so a saturated server cannot block another server.
export class AnalysisJobs {
  private active = 0
  private activeByResource = new Map<string, number>()
  private waiting: { resource: string; grant: () => void }[] = []
  private caps = new Map<string, number>()
  constructor(
    readonly limit: number,
    private backends: Record<string, { resource: string; limit: number }> = {},
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid analysis job limit.')
    for (const { resource, limit: cap } of Object.values(backends)) {
      if (!Number.isInteger(cap) || cap < 1) throw new Error('Invalid backend job limit.')
      this.caps.set(resource, Math.min(this.caps.get(resource) ?? cap, cap))
    }
  }
  backendLimit(id: string): number {
    return Math.min(this.limit, this.caps.get(this.backends[id]?.resource ?? id) ?? this.limit)
  }
  private pump() {
    while (this.active < this.limit) {
      const index = this.waiting.findIndex(
        ({ resource }) =>
          (this.activeByResource.get(resource) ?? 0) < (this.caps.get(resource) ?? this.limit),
      )
      if (index < 0) return
      this.waiting.splice(index, 1)[0].grant()
    }
  }
  async run<T>(signal: AbortSignal, action: () => Promise<T>, backendId = ''): Promise<T> {
    if (signal.aborted) throw new Error('Analysis cancelled.')
    const resource = this.backends[backendId]?.resource ?? backendId
    await new Promise<void>((resolve, reject) => {
      const entry = {
        resource,
        grant: () => {
          signal.removeEventListener('abort', cancel)
          this.active++
          this.activeByResource.set(resource, (this.activeByResource.get(resource) ?? 0) + 1)
          resolve()
        },
      }
      const cancel = () => {
        this.waiting = this.waiting.filter((queued) => queued !== entry)
        reject(new Error('Analysis cancelled.'))
        this.pump()
      }
      this.waiting.push(entry)
      signal.addEventListener('abort', cancel, { once: true })
      this.pump()
    })
    try {
      if (signal.aborted) throw new Error('Analysis cancelled.')
      return await action()
    } finally {
      this.active--
      this.activeByResource.set(resource, (this.activeByResource.get(resource) ?? 1) - 1)
      this.pump()
    }
  }
}
export function createAnalysisJobs(analyzers: Analyzer[], settings: Settings): AnalysisJobs {
  const limit = analysisParallelism(analyzers, settings)
  const legacy = settings.backends.length === 1 && settings.analysis.legacySingleModel
  const backends: Record<string, { resource: string; limit: number }> = {}
  for (const backend of settings.backends) {
    try {
      const url = backend.id === 'default' ? settings.ai.serverUrl : backend.serverUrl
      backends[backend.id] = {
        resource: normalizeBackendUrl(url).replace(/\/v1$/, ''),
        limit: legacy ? limit : backend.parallelJobs,
      }
    } catch {
      /* Reviewer reports invalid configuration without stopping other servers. */
    }
  }
  return new AnalysisJobs(limit, backends)
}
