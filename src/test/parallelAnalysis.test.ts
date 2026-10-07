import { describe, expect, it, vi } from 'vitest'
import { AnalysisJobs, analysisParallelism, mapConcurrent } from '../analyzers/jobs'
import { runAnalyzer } from '../analyzers/runner'
import { analyzers } from '../analyzers/registry'
import { clarity } from '../analyzers/llm/semantic'
import { AnalysisCache } from '../analyzers/cache'
import { defaultSettings, effectiveConfig } from '../settings/model'
import { hash } from '../diagnostics/hash'
import type { Snapshot } from '../diagnostics/types'
import type { AIProvider } from '../ai/types'
import { AnalysisHistory } from '../analyzers/history'

function input(): Snapshot {
  let position = 1
  const blocks = Array.from({ length: 6 }, (_, order) => {
    const text = `Paragraph ${order}.`
    const from = position
    position += text.length + 2
    return {
      id: `b${order}`,
      type: 'paragraph',
      text,
      hash: hash(text),
      from,
      to: from + text.length,
      order,
      positions: Array.from({ length: text.length + 1 }, (_, i) => from + i),
    }
  })
  return { documentId: 'doc', revision: 0, hash: hash('document'), blocks }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function delayedProvider() {
  let active = 0,
    peak = 0
  const provider: AIProvider = {
    testConnection: vi.fn(),
    listModels: vi.fn(),
    completeStructured: vi.fn(async (request, _config, signal) => {
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer)
            reject(new Error('Cancelled'))
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel)
            resolve()
          }, 5)
          signal.addEventListener('abort', cancel, { once: true })
        })
        const block = JSON.parse(request.user).targets[0]
        return {
          issues: [
            {
              block_id: block.block_id,
              quote: block.text,
              category: 'clarity',
              severity: 'suggestion',
              message: 'Review.',
              explanation: 'Review this passage.',
              replacement: null,
              confidence: 0.8,
            },
          ],
        }
      } finally {
        active--
      }
    }),
  }
  return {
    provider,
    get active() {
      return active
    },
    get peak() {
      return peak
    },
  }
}

describe('bounded parallel analysis', () => {
  it('requires one effective model/server for the selected AI reviewers, ignoring local rules', () => {
    const settings = defaultSettings()
    settings.analysis.parallelJobs = 3
    settings.analyzers.clarity.model = ' qwen3-8b '
    settings.analyzers['repeated-word'].model = 'not-a-model'
    expect(analysisParallelism(analyzers, settings)).toBe(3)
    settings.analyzers.structure.model = 'another-model'
    expect(analysisParallelism(analyzers, settings)).toBe(1)
    expect(
      analysisParallelism(
        analyzers.filter((a) => a.id !== 'structure'),
        settings,
      ),
    ).toBe(3)
    expect(analysisParallelism([clarity], settings)).toBe(3)
    expect(
      analysisParallelism(
        analyzers.filter((a) => a.engine === 'deterministic'),
        settings,
      ),
    ).toBe(1)
    settings.ai.serverUrl = 'invalid'
    expect(analysisParallelism(analyzers, settings)).toBe(1)
  })
  it('shares a hard global cap across reviewers and paragraph units, preserving cache and force semantics', async () => {
    const settings = defaultSettings()
    settings.analysis.parallelJobs = 3
    const mock = delayedProvider(),
      cache = new AnalysisCache(),
      signal = new AbortController().signal
    const ai = analyzers.filter((a) => a.engine === 'ai')
    const batch = (force = false) => {
      const jobs = new AnalysisJobs(analysisParallelism(ai, settings))
      return mapConcurrent(ai, jobs.limit, (a) =>
        runAnalyzer(
          a,
          input(),
          'document',
          effectiveConfig(settings, a.id),
          mock.provider,
          signal,
          cache,
          force,
          jobs,
        ),
      )
    }
    const first = await batch()
    expect(mock.peak).toBe(3)
    expect(mock.active).toBe(0)
    expect(first.reduce((n, r) => n + r.requests, 0)).toBe(14)
    expect(first[0].findings.map((f) => f.blockId)).toEqual(input().blocks.map((b) => b.id))
    const calls = vi.mocked(mock.provider.completeStructured).mock.calls.length
    settings.analysis.parallelJobs = 2 // Scheduling is not part of inference/cache identity.
    const cached = await batch()
    expect(cached.reduce((n, r) => n + r.cacheHits, 0)).toBe(14)
    expect(vi.mocked(mock.provider.completeStructured).mock.calls).toHaveLength(calls)
    await batch(true)
    expect(vi.mocked(mock.provider.completeStructured).mock.calls).toHaveLength(calls * 2)
  })
  it('keeps mixed-model reviews fully sequential', async () => {
    const settings = defaultSettings()
    settings.analysis.parallelJobs = 4
    settings.analyzers.structure.model = 'different'
    const mock = delayedProvider(),
      jobs = new AnalysisJobs(analysisParallelism(analyzers, settings))
    await mapConcurrent(analyzers, jobs.limit, (a) =>
      runAnalyzer(
        a,
        input(),
        'document',
        effectiveConfig(settings, a.id),
        mock.provider,
        new AbortController().signal,
        new AnalysisCache(),
        false,
        jobs,
      ),
    )
    expect(mock.peak).toBe(1)
  })
  it('cancels queued jobs without starting them and never caches aborted responses', async () => {
    const controller = new AbortController(),
      jobs = new AnalysisJobs(2),
      cache = new AnalysisCache()
    const started = deferred(),
      finish = deferred()
    let calls = 0
    const provider: AIProvider = {
      testConnection: vi.fn(),
      listModels: vi.fn(),
      completeStructured: vi.fn(async () => {
        if (++calls === 2) started.resolve()
        await finish.promise // Even a transport ignoring cancellation cannot insert stale cache data.
        return { issues: [] }
      }),
    }
    const ai = analyzers.filter((a) => a.engine === 'ai')
    const results = Promise.allSettled(
      ai.map((a) =>
        runAnalyzer(
          a,
          input(),
          'document',
          defaultSettings().ai,
          provider,
          controller.signal,
          cache,
          false,
          jobs,
        ),
      ),
    )
    await started.promise
    controller.abort()
    finish.resolve()
    expect((await results).every((r) => r.status === 'rejected')).toBe(true)
    expect(calls).toBe(2)
    expect(cache.export()).toMatchObject({ entries: [] })
    const next = vi.fn(async () => 'next')
    expect(await jobs.run(new AbortController().signal, next)).toBe('next')
  })
  it('waits for in-flight jobs after failure and stops assigning new work', async () => {
    const first = deferred(),
      second = deferred(),
      began = deferred(),
      error = new Error('Failure')
    let calls = 0,
      settled = false
    const promise = mapConcurrent([0, 1, 2, 3], 2, async (i) => {
      if (++calls === 2) began.resolve()
      if (i === 0) {
        await first.promise
        throw error
      }
      await second.promise
      return i
    })
    const rejected = expect(promise).rejects.toBe(error)
    void promise.catch(() => {
      settled = true
    })
    await began.promise
    first.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(calls).toBe(2)
    second.resolve()
    await rejected
    expect(calls).toBe(2)
  })
  it('keeps source-order results when requests complete out of order', async () => {
    const release = [deferred(), deferred(), deferred()],
      started = deferred()
    let calls = 0
    const promise = mapConcurrent([0, 1, 2], 3, async (i) => {
      if (++calls === 3) started.resolve()
      await release[i].promise
      return i
    })
    await started.promise
    release[2].resolve()
    release[1].resolve()
    release[0].resolve()
    expect(await promise).toEqual([0, 1, 2])
  })
  it('records actual concurrency without inventing it for older history', () => {
    const settings = defaultSettings(),
      history = new AnalysisHistory()
    settings.analysis.parallelJobs = 3
    history.start('doc', hash('text'), 'document', 'general', false, analyzers, settings)
    expect(history.forDocument('doc')[0].parallelJobs).toBe(3)
    settings.analyzers.structure.model = 'different'
    history.start('doc', hash('text'), 'document', 'general', false, analyzers, settings)
    expect(history.forDocument('doc')[0].parallelJobs).toBe(1)
    const data = history.export() as { runs: { parallelJobs?: number }[] }
    for (const run of data.runs) delete run.parallelJobs
    const legacy = new AnalysisHistory()
    legacy.import(data)
    expect(legacy.forDocument('doc')[0].parallelJobs).toBeUndefined()
  })
})
