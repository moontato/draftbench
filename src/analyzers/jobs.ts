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

export interface QueueStats {
  resource: string
  /** Review units that had to wait for a global or backend slot. */
  waited: number
  completed: number
  totalWaitMs: number
  maxWaitMs: number
  p50WaitMs: number
  p95WaitMs: number
}
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

// A single queue owns both limits; waiting for a backend never holds a global slot.
// It scans for runnable work, so a saturated server cannot block another server.
export class AnalysisJobs {
  private active = 0
  private activeByResource = new Map<string, number>()
  private completedByResource = new Map<string, number>()
  private waiting: { resource: string; grant: () => void }[] = []
  private caps = new Map<string, number>()
  // Queue pressure is measured for the opt-in evaluation harness; it never changes scheduling.
  private waits = new Map<string, number[]>()
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
  /** The shared server identity a backend routes to (the queue-accounting key). */
  resourceOf(backendId: string): string {
    return this.backends[backendId]?.resource ?? backendId
  }
  private recordWait(resource: string, ms: number) {
    if (!(ms >= 1)) return // Sub-millisecond hand-offs are not queue pressure.
    const samples = this.waits.get(resource) ?? []
    if (samples.length < 5_000) samples.push(ms)
    this.waits.set(resource, samples)
  }
  queueStats(resource: string): QueueStats {
    const samples = this.waits.get(resource) ?? []
    return {
      resource,
      waited: samples.length,
      completed: this.completedByResource.get(resource) ?? 0,
      totalWaitMs: samples.reduce((total, ms) => total + ms, 0),
      maxWaitMs: samples.length ? Math.max(...samples) : 0,
      p50WaitMs: percentile(samples, 0.5),
      p95WaitMs: percentile(samples, 0.95),
    }
  }
  queueResources(): string[] {
    return [...new Set([...this.waits.keys(), ...this.completedByResource.keys()])]
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
    const resource = this.backends[backendId]?.resource ?? backendId,
      queued = performance.now()
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
    this.recordWait(resource, performance.now() - queued)
    try {
      if (signal.aborted) throw new Error('Analysis cancelled.')
      this.completedByResource.set(resource, (this.completedByResource.get(resource) ?? 0) + 1)
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
