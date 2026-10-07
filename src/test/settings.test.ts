import { describe, expect, it } from 'vitest'
import { AI_LIMITS, defaultSettings, settingsSchema } from '../settings/model'

describe('AI settings limits', () => {
  it('defaults old settings to sequential jobs and validates the concurrency cap', () => {
    expect(settingsSchema.parse({ version: 1 }).analysis.parallelJobs).toBe(1)
    expect(settingsSchema.parse({ analysis: { parallelJobs: 8 } }).analysis.parallelJobs).toBe(8)
    for (const parallelJobs of [0, 9, 1.5, '2', NaN])
      expect(settingsSchema.safeParse({ analysis: { parallelJobs } }).success).toBe(false)
  })
  it('returns independent default settings objects', () => {
    const first = defaultSettings()
    first.analysis.parallelJobs = 3
    first.analyzers.structure.model = 'custom'
    first.ai.model = 'custom'
    const second = defaultSettings()
    expect(second.analysis.parallelJobs).toBe(1)
    expect(second.analyzers.structure.model).toBe('')
    expect(second.ai.model).toBe('qwen3-8b')
  })
  it('allows a thirty-minute timeout and 32768 output tokens without changing defaults', () => {
    const defaults = defaultSettings()
    expect(defaults.ai.timeoutMs).toBe(120000)
    expect(defaults.ai.maxTokens).toBe(2048)
    const saved = settingsSchema.parse({
      ...defaults,
      ai: { ...defaults.ai, timeoutMs: 1_800_000, maxTokens: 32768 },
    })
    expect(saved.ai.timeoutMs).toBe(AI_LIMITS.timeoutMs)
    expect(saved.ai.maxTokens).toBe(AI_LIMITS.maxTokens)
  })
  it('rejects values above either cap', () => {
    const defaults = defaultSettings()
    expect(
      settingsSchema.safeParse({ ...defaults, ai: { ...defaults.ai, timeoutMs: 1_800_001 } })
        .success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({ ...defaults, ai: { ...defaults.ai, maxTokens: 32769 } }).success,
    ).toBe(false)
  })
})
