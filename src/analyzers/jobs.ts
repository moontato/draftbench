import type { Analyzer } from './types'
import { effectiveConfig, type Settings } from '../settings/model'
import { normalizeServer } from '../ai/providers/openai'

// Only reviewers selected for this run matter; local rules have no model.
export function analysisParallelism(analyzers: Analyzer[], settings: Settings): number {
  const ai = analyzers.filter((a) => a.engine === 'ai')
  if (!ai.length) return 1
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

// Shared across reviewers AND their paragraph jobs: never limit-squared requests.
export class AnalysisJobs {
  private active = 0
  private waiting: (() => void)[] = []
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid analysis job limit.')
  }
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('Analysis cancelled.')
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        this.waiting = this.waiting.filter((entry) => entry !== grant)
        reject(new Error('Analysis cancelled.'))
      }
      const grant = () => {
        signal.removeEventListener('abort', cancel)
        this.active++
        resolve()
      }
      if (this.active < this.limit) grant()
      else {
        this.waiting.push(grant)
        signal.addEventListener('abort', cancel, { once: true })
      }
    })
    try {
      if (signal.aborted) throw new Error('Analysis cancelled.')
      return await action()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}
