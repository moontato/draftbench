import { describe, expect, it } from 'vitest'
import { AI_LIMITS, defaultSettings, loadSettings, settingsSchema } from '../settings/model'

describe('custom reviewer ID migration', () => {
  it('preserves a legacy development reviewer, routing, and profile membership without collisions', () => {
    const raw = defaultSettings()
    const definition = {
      id: 'development',
      name: 'My development task',
      description: '',
      instructions: 'Check my terminology rules.',
      scope: 'document' as const,
      severity: 'warning' as const,
      enabled: true,
    }
    raw.customAnalyzers = [
      definition,
      { ...definition, id: 'custom-development-1', name: 'Existing' },
    ]
    raw.customProfiles = [
      {
        id: 'my-prose',
        name: 'My prose',
        description: '',
        enabled: ['development', 'custom-development-1', 'clarity'],
      },
    ]
    raw.analyzers.development = { enabled: false, model: 'custom-model', backend: 'default' }
    const loaded = loadSettings(raw)
    const renamed = loaded.settings.customAnalyzers[0]
    expect(renamed).toEqual({ ...definition, id: 'custom-development-2' })
    expect(loaded.settings.analyzers[renamed.id]).toEqual(raw.analyzers.development)
    expect(loaded.settings.analyzers.development).toEqual({ enabled: true, model: '' })
    expect(loaded.settings.customProfiles[0].enabled).toEqual([
      'custom-development-2',
      'custom-development-1',
      'clarity',
    ])
    expect(loaded.warnings.join(' ')).toContain(
      'Instructions, routing, and profile membership retained',
    )
    expect(raw.customAnalyzers[0].id).toBe('development')
    const reloaded = loadSettings(loaded.settings)
    expect(reloaded.settings).toEqual(loaded.settings)
    expect(reloaded.warnings).toEqual([])
  })
  it('does not reinterpret a malformed reserved custom reviewer as a valid migration', () => {
    const loaded = loadSettings({
      ...defaultSettings(),
      customAnalyzers: [{ id: 'development', instructions: '' }],
    })
    expect(loaded.settings.customAnalyzers).toEqual([])
    expect(loaded.warnings.join(' ')).toContain('invalid or duplicate')
  })
})

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
