import { describe, expect, it, vi } from 'vitest'
import { AnalysisJobs, analysisParallelism, createAnalysisJobs } from '../analyzers/jobs'
import { analyzers } from '../analyzers/registry'
import { defaultSettings, effectiveConfig, legacyBackend } from '../settings/model'
import { OpenAICompatibleProvider, type NativeRequest } from '../ai/providers/openai'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function latch() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe('global and per-server scheduler', () => {
  it('bounds the global total and each backend while different servers overlap', async () => {
    const jobs = new AnalysisJobs(3, {
      local: { resource: 'local', limit: 2 },
      gpu: { resource: 'gpu', limit: 2 },
    })
    let active = 0,
      peak = 0,
      overlapped = false
    const backendActive: Record<string, number> = { local: 0, gpu: 0 },
      peaks = { ...backendActive }
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const backend = i < 6 ? 'local' : 'gpu'
        return jobs.run(
          new AbortController().signal,
          async () => {
            active++
            backendActive[backend]++
            peak = Math.max(peak, active)
            peaks[backend] = Math.max(peaks[backend], backendActive[backend])
            overlapped ||= backendActive.local > 0 && backendActive.gpu > 0
            await delay(5)
            active--
            backendActive[backend]--
          },
          backend,
        )
      }),
    )
    expect(peak).toBe(3)
    expect(peaks).toEqual({ local: 2, gpu: 2 })
    expect(overlapped).toBe(true)
    expect(active).toBe(0)
  })
  it('does not hold a global slot or block another server behind a saturated backend', async () => {
    const jobs = new AnalysisJobs(2, {
      local: { resource: 'local', limit: 1 },
      gpu: { resource: 'gpu', limit: 1 },
    })
    const release = latch(),
      started: string[] = []
    const first = jobs.run(
      new AbortController().signal,
      async () => {
        started.push('local-1')
        await release.promise
      },
      'local',
    )
    const second = jobs.run(
      new AbortController().signal,
      async () => {
        started.push('local-2')
      },
      'local',
    )
    await jobs.run(
      new AbortController().signal,
      async () => {
        started.push('gpu')
      },
      'gpu',
    )
    expect(started).toEqual(['local-1', 'gpu'])
    release.resolve()
    await Promise.all([first, second])
    expect(started.at(-1)).toBe('local-2')
  })
  it('removes cancelled waiters on either limit and propagates abort to active work', async () => {
    const jobs = new AnalysisJobs(2, { local: { resource: 'local', limit: 1 } }),
      controller = new AbortController(),
      release = latch()
    let started = 0
    const requests = Array.from({ length: 4 }, () =>
      jobs.run(
        controller.signal,
        async () => {
          started++
          await release.promise
          if (controller.signal.aborted) throw new Error('cancelled')
        },
        'local',
      ),
    )
    const drained = Promise.allSettled(requests)
    await delay(0)
    expect(started).toBe(1)
    controller.abort()
    release.resolve()
    expect((await drained).every((result) => result.status === 'rejected')).toBe(true)
    expect(started).toBe(1)
    await expect(
      jobs.run(new AbortController().signal, async () => 'fresh', 'local'),
    ).resolves.toBe('fresh')
  })
  it('releases both limits after failure and does not poison other backend jobs', async () => {
    const jobs = new AnalysisJobs(2, {
      local: { resource: 'local', limit: 1 },
      gpu: { resource: 'gpu', limit: 1 },
    })
    const results = await Promise.allSettled([
      jobs.run(
        new AbortController().signal,
        async () => {
          throw new Error('reviewer failed')
        },
        'local',
      ),
      jobs.run(new AbortController().signal, async () => 'GPU succeeded', 'gpu'),
      jobs.run(new AbortController().signal, async () => 'Local next succeeded', 'local'),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
  })
  it('coalesces aliases for one normalized endpoint and applies the stricter cap', () => {
    const settings = defaultSettings()
    settings.analysis.parallelJobs = 4
    settings.backends.push({
      ...legacyBackend(),
      id: 'alias',
      name: 'Alias',
      serverUrl: 'HTTP://LOCALHOST:8080/v1/',
      parallelJobs: 1,
      credentialRef: 'backend:alias',
    })
    const jobs = createAnalysisJobs(analyzers, settings)
    expect(jobs.backendLimit('default')).toBe(1)
    expect(jobs.backendLimit('alias')).toBe(1)
  })
  it('retains legacy concurrency semantics while named backends support different models concurrently', () => {
    const settings = defaultSettings()
    settings.analysis.parallelJobs = 4
    settings.analyzers.structure.model = 'another-model'
    expect(analysisParallelism(analyzers, settings)).toBe(1)
    settings.backends.push({
      ...legacyBackend(),
      id: 'gpu',
      name: 'GPU',
      serverUrl: 'http://100.80.40.20:8080',
      credentialRef: 'backend:gpu',
    })
    expect(analysisParallelism(analyzers, settings)).toBe(4)
    const jobs = createAnalysisJobs(analyzers, settings)
    expect(jobs.backendLimit('default')).toBe(2)
    expect(jobs.backendLimit('gpu')).toBe(2)
    settings.backends.pop()
    settings.analysis.legacySingleModel = false
    expect(createAnalysisJobs(analyzers, settings).backendLimit('default')).toBe(2)
  })
  it('preserves the old configured cap rather than silently reducing a migrated single-model run', () => {
    const settings = defaultSettings()
    settings.analysis.parallelJobs = 3
    expect(createAnalysisJobs(analyzers, settings).backendLimit('default')).toBe(3)
  })
  it('rejects invalid limits before starting work', () => {
    expect(() => new AnalysisJobs(0)).toThrow()
    expect(() => new AnalysisJobs(4, { local: { resource: 'local', limit: 0 } })).toThrow()
  })
})
describe('native provider credential routing', () => {
  it('routes model discovery, connection tests and reviews to the selected credential slot', async () => {
    const calls: NativeRequest[] = [],
      settings = defaultSettings()
    settings.backends.push({
      ...legacyBackend(),
      id: 'gpu',
      name: 'GPU',
      serverUrl: 'http://gpu.tailnet.ts.net:8080',
      model: 'remote-model',
      credentialRef: 'backend:gpu',
    })
    settings.analyzers.clarity.backend = 'gpu'
    const provider = new OpenAICompatibleProvider(async (request) => {
      calls.push(request)
      return request.route === 'models'
        ? { data: [{ id: 'remote-model' }] }
        : {
            choices: [
              {
                message: {
                  content:
                    request.body && JSON.stringify(request.body).includes('Reply with OK')
                      ? 'OK'
                      : '{"issues":[]}',
                },
                finish_reason: 'stop',
              },
            ],
          }
    })
    const config = effectiveConfig(settings, 'clarity')
    await provider.testConnection(config)
    await provider.completeStructured(
      { system: 'review', user: 'source', schema: {} },
      config,
      new AbortController().signal,
    )
    expect(calls).toHaveLength(3)
    expect(calls.every((request) => request.credentialRef === 'backend:gpu')).toBe(true)
    expect(calls.every((request) => request.serverUrl === 'http://gpu.tailnet.ts.net:8080')).toBe(
      true,
    )
    expect(JSON.stringify(calls)).not.toContain('openai-compatible')
    expect(vi.isMockFunction(provider)).toBe(false)
  })
})
