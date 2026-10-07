import { describe, expect, it, vi } from 'vitest'
import {
  defaultSettings,
  settingsSchema,
  loadSettings,
  effectiveConfig,
  configurationHash,
  backendConfig,
  legacyBackend,
  normalizeBackendUrl,
} from '../settings/model'
import { customAnalyzerSchema } from '../settings/definitions'
import { createAnalyzerRegistry, analyzers } from '../analyzers/registry'
import { getProfiles, analyzerEnabled } from '../profiles/profiles'
import { AnalysisCache } from '../analyzers/cache'
import { SavedReviews } from '../analyzers/savedReviews'
import { AnalysisHistory } from '../analyzers/history'
import { planScope, runAnalyzer } from '../analyzers/runner'
import { canonical, hash } from '../diagnostics/hash'
import { evalSnapshot } from '../eval/harness'
import type { AIProvider } from '../ai/types'
import { updateBackend } from '../settings/backendEditing'

const definition = {
  id: 'buried-request',
  name: 'Buried Request',
  description: 'Find buried email requests.',
  scope: 'document' as const,
  instructions:
    'Flag emails where the main request is difficult to identify. Only flag meaningful reader difficulty.',
  enabled: true,
  severity: 'suggestion' as const,
}
function setup() {
  const settings = defaultSettings()
  settings.customAnalyzers = [{ ...definition }]
  settings.customProfiles = [
    {
      id: 'work-email',
      name: 'Work Email',
      description: 'My email checks',
      enabled: ['harper', 'clarity', 'buried-request', 'ambiguous-reference'],
    },
  ]
  const registry = createAnalyzerRegistry(settings)
  return { settings, registry, reviewer: registry.find((a) => a.id === definition.id)! }
}
function mock(issues: unknown[] = []): AIProvider {
  return {
    testConnection: vi.fn(),
    listModels: vi.fn(),
    completeStructured: vi.fn(async () => ({ issues })),
  }
}
function issue(input = evalSnapshot('This is unclear.')) {
  return {
    block_id: input.blocks[0].id,
    quote: 'This is unclear.',
    category: 'buried-request',
    severity: 'suggestion',
    message: 'The action is buried.',
    explanation: 'A busy reader cannot find the request.',
    replacement: 'Please approve the budget.',
    confidence: 0.8,
  }
}
describe('v0.2 settings migration and named backends', () => {
  it('migrates representative v0.1.5 settings without changing inference/cache identity or budgets', () => {
    const ai = {
      serverUrl: 'http://100.80.40.20:8080',
      model: 'my-served-model',
      timeoutMs: 900000,
      maxTokens: 8192,
      temperature: 0.3,
      credentialGeneration: 7,
    }
    const raw = {
      version: 1,
      ai,
      analysis: { parallelJobs: 3, paragraphInputChars: 64000, documentInputChars: 120000 },
      analyzers: {
        clarity: { enabled: true, model: 'small-reviewer' },
        structure: { enabled: false, model: '' },
      },
      editor: { fontSize: 21, spellcheck: false },
      general: { defaultProfile: 'email' },
    }
    const { settings, warnings, migrated } = loadSettings(raw)
    expect(migrated).toBe(true)
    expect(warnings).toEqual([])
    expect(settings.version).toBe(2)
    expect(settings.backends[0]).toMatchObject({
      ...ai,
      id: 'default',
      name: 'Default',
      credentialRef: 'openai-compatible',
    })
    expect(settings.ai).toEqual(ai)
    expect(settings.analyzers.harper.enabled).toBe(false)
    expect(settings.analysis).toMatchObject(raw.analysis)
    expect(settings.editor).toEqual(raw.editor)
    expect(settings.general.defaultProfile).toBe('email')
    expect(configurationHash(effectiveConfig(settings, 'clarity'))).toBe(
      hash(canonical({ ...ai, model: 'small-reviewer' })),
    )
    const input = evalSnapshot('A clear paragraph.'),
      cache = new AnalysisCache()
    expect(
      cache.key(
        analyzers.find((a) => a.id === 'clarity')!,
        planScope(analyzers[1], input, 'document')[0],
        { ...ai, model: 'small-reviewer' },
      ),
    ).toBe(
      cache.key(
        analyzers[1],
        planScope(analyzers[1], input, 'document')[0],
        effectiveConfig(settings, 'clarity'),
      ),
    )
  })
  it('resolves a named default, backend override and model override without duplicating URLs', () => {
    let { settings } = setup()
    settings.backends.push({
      ...legacyBackend(),
      id: 'gpu',
      name: 'GPU Box',
      serverUrl: 'http://100.80.40.20:8080/v1/',
      model: 'larger-model',
      credentialRef: 'backend:gpu',
      timeoutMs: 300000,
    })
    settings.defaultBackend = 'gpu'
    expect(effectiveConfig(settings, 'clarity')).toMatchObject({
      serverUrl: 'http://100.80.40.20:8080/v1',
      model: 'larger-model',
      backendName: 'GPU Box',
      credentialRef: 'backend:gpu',
    })
    settings.analyzers.clarity = { enabled: true, model: 'override', backend: 'default' }
    expect(effectiveConfig(settings, 'clarity')).toMatchObject({
      model: 'override',
      serverUrl: settings.ai.serverUrl,
      credentialRef: 'openai-compatible',
    })
    settings = updateBackend(settings, 'default', {
      model: 'updated-default',
      serverUrl: 'http://localhost:9090',
    })
    expect(settings.ai.model).toBe('updated-default')
    expect(effectiveConfig(settings, 'clarity').model).toBe('override')
    expect(backendConfig(settings, 'default').serverUrl).toBe('http://localhost:9090')
    expect(() => backendConfig(settings, 'missing')).toThrow('missing')
  })
  it('normalizes localhost, LAN, Tailscale and prefixed /v1 URLs; rejects credential-bearing URLs', () => {
    expect(normalizeBackendUrl(' HTTP://LOCALHOST:8080/v1/// ')).toBe('http://localhost:8080/v1')
    expect(normalizeBackendUrl('http://gpu.tailnet.ts.net:8080')).toBe(
      'http://gpu.tailnet.ts.net:8080',
    )
    for (const value of [
      'file:///secret',
      'http://user:pass@host',
      'https://host?token=secret',
      'https://host/#secret',
    ])
      expect(() => normalizeBackendUrl(value)).toThrow()
  })
  it('rejects duplicate/reserved IDs and foreign credential references on save', () => {
    const { settings } = setup()
    expect(settingsSchema.safeParse(settings).success).toBe(true)
    expect(
      settingsSchema.safeParse({
        ...settings,
        backends: [...settings.backends, settings.backends[0]],
      }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({
        ...settings,
        customAnalyzers: [...settings.customAnalyzers, { ...definition, id: 'clarity' }],
      }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({
        ...settings,
        customProfiles: [
          ...settings.customProfiles,
          { ...settings.customProfiles[0], id: 'email' },
        ],
      }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({
        ...settings,
        backends: [{ ...settings.backends[0], credentialRef: 'backend:someone-else' }],
      }).success,
    ).toBe(false)
    expect(customAnalyzerSchema.safeParse({ ...definition, id: 'constructor' }).success).toBe(false)
  })
  it('isolates corrupt definitions, profiles and per-analyzer options while retaining valid entries', () => {
    const { settings } = setup()
    const raw = {
      ...settings,
      customAnalyzers: [
        definition,
        { ...definition, id: 'bad-scope', scope: 'javascript' },
        definition,
        { ...definition, id: 'empty-prompt', instructions: '' },
      ],
      customProfiles: [settings.customProfiles[0], { id: 'broken', name: '' }],
      analyzers: {
        ...settings.analyzers,
        'buried-request': { enabled: true, model: 99 },
        clarity: { enabled: true, backend: 'missing', model: '' },
      },
    }
    const loaded = loadSettings(raw)
    expect(loaded.settings.customAnalyzers.map((a) => a.id)).toEqual(['buried-request'])
    expect(loaded.settings.customProfiles.map((p) => p.id)).toEqual(['work-email'])
    expect(loaded.settings.analyzers.clarity.enabled).toBe(false)
    expect(loaded.settings.analyzers['buried-request'].enabled).toBe(false)
    expect(loaded.warnings.length).toBeGreaterThan(3)
    expect(settings.customAnalyzers).toHaveLength(1) // Import never mutates caller data.
  })
  it('retains built-in profiles and transparently selects custom membership with global disablement', () => {
    const { settings } = setup()
    expect(Object.keys(getProfiles(settings))).toEqual([
      'general',
      'technical',
      'essay',
      'email',
      'work-email',
    ])
    expect(analyzerEnabled(settings, 'buried-request', 'work-email')).toBe(true)
    expect(analyzerEnabled(settings, 'buried-request', 'general')).toBe(false)
    expect(analyzerEnabled(settings, 'harper', 'work-email')).toBe(false)
    settings.analyzers.harper.enabled = true
    expect(analyzerEnabled(settings, 'harper', 'work-email')).toBe(true)
    settings.customAnalyzers[0].enabled = false
    expect(analyzerEnabled(settings, 'buried-request', 'work-email')).toBe(false)
  })
})
it('keeps explicit no-key identity separate from the compatible legacy credential slot', () => {
  const config = defaultSettings().ai
  expect(configurationHash({ ...config, credentialRef: 'openai-compatible' })).toBe(
    configurationHash(config),
  )
  expect(configurationHash({ ...config, credentialRef: '' })).not.toBe(configurationHash(config))
})
it('warns about null/array analyzer options so a damaged legacy original is not auto-overwritten', () => {
  for (const analyzers of [null, []]) {
    const loaded = loadSettings({ version: 1, ai: { model: 'preserved' }, analyzers })
    expect(loaded.settings.ai.model).toBe('preserved')
    expect(loaded.migrated).toBe(true)
    expect(loaded.warnings).toContain('Corrupt analyzer options isolated.')
  }
})
describe('configuration-driven reviewers use the production pipeline', () => {
  it('composes task instructions with schema/policy, maps findings, caches and restores onto fresh block IDs', async () => {
    const { settings, reviewer, registry } = setup(),
      input = evalSnapshot('This is unclear.'),
      provider = mock([issue(input)]),
      cache = new AnalysisCache()
    const result = await runAnalyzer(
      reviewer,
      input,
      'document',
      effectiveConfig(settings, reviewer.id),
      provider,
      new AbortController().signal,
      cache,
    )
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      analyzerId: 'buried-request',
      replacement: 'Please approve the budget.',
      engine: { kind: 'ai', backend: 'Default' },
    })
    const request = vi.mocked(provider.completeStructured).mock.calls[0][0]
    expect(request.system).toContain(definition.instructions)
    expect(request.system).toContain('not a generator')
    expect(request.system).toContain('exact source text')
    expect(request.system).toContain('Default severity is suggestion')
    expect(request.schema).toHaveProperty('properties.issues')
    expect(
      (
        await runAnalyzer(
          reviewer,
          input,
          'document',
          effectiveConfig(settings, reviewer.id),
          provider,
          new AbortController().signal,
          cache,
        )
      ).cacheHits,
    ).toBe(1)
    const store = new SavedReviews(registry)
    expect(
      store.capture(
        input,
        hash('markdown'),
        hash('serialized'),
        'work-email',
        settings,
        result.findings,
        [reviewer.id],
      ),
    ).toBe(true)
    const imported = new SavedReviews(registry)
    imported.import(store.export())
    const fresh = { ...input, blocks: input.blocks.map((b) => ({ ...b, id: 'fresh-id' })) }
    expect(
      imported.restore(fresh, hash('markdown'), hash('serialized'), 'work-email', settings)
        ?.findings[0].blockId,
    ).toBe('fresh-id')
    settings.customProfiles[0].enabled.push('structure')
    expect(
      imported.restore(fresh, hash('markdown'), hash('serialized'), 'work-email', settings),
    ).toBeNull()
  })
  it('supports paragraph, nearby, document and selection-only plans without exposing implementation internals', () => {
    const { settings } = setup(),
      input = evalSnapshot('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.')
    for (const scope of ['paragraph', 'nearby', 'document', 'selection'] as const) {
      settings.customAnalyzers[0].scope = scope
      const reviewer = createAnalyzerRegistry(settings).at(-1)!
      if (scope === 'selection') {
        input.selection = { from: input.blocks[0].from + 6, to: input.blocks[1].to }
        expect(() => planScope(reviewer, input, 'document')).toThrow()
        const units = planScope(reviewer, input, 'selection')
        expect(units).toHaveLength(1)
        expect(units[0].targets).toHaveLength(2)
        expect(units[0].targets[0].text).toBe('paragraph.')
      } else {
        const units = planScope(reviewer, input, 'document')
        expect(units).toHaveLength(scope === 'document' ? 1 : 3)
        expect(units[0].context.length).toBe(scope === 'nearby' ? 1 : 0)
      }
    }
  })
  it('validates confidence/quotes/replacements; malformed or unmappable results never enter cache', async () => {
    const { settings, reviewer } = setup(),
      input = evalSnapshot('This is unclear.'),
      cache = new AnalysisCache()
    for (const invalid of [
      { ...issue(input), confidence: 2 },
      { ...issue(input), quote: 'invented text' },
      { ...issue(input), replacement: '\ud800' },
    ]) {
      const result = await runAnalyzer(
        reviewer,
        input,
        'document',
        effectiveConfig(settings, reviewer.id),
        mock([invalid]),
        new AbortController().signal,
        cache,
      )
      expect(result.findings).toHaveLength(0)
      expect(result.warnings).not.toHaveLength(0)
    }
    expect((cache.export() as { entries: unknown[] }).entries).toEqual([])
  })
  it('versions instruction edits and accepts successful zero-finding reviews', async () => {
    const { settings, reviewer, registry } = setup(),
      input = evalSnapshot('A clear email.'),
      cache = new AnalysisCache(),
      provider = mock()
    const result = await runAnalyzer(
      reviewer,
      input,
      'document',
      effectiveConfig(settings, reviewer.id),
      provider,
      new AbortController().signal,
      cache,
    )
    const store = new SavedReviews(registry)
    expect(
      store.capture(
        input,
        hash('markdown'),
        hash('serialized'),
        'work-email',
        settings,
        result.findings,
        [reviewer.id],
      ),
    ).toBe(true)
    settings.customAnalyzers[0].instructions += ' Also check the closing request.'
    const next = createAnalyzerRegistry(settings)
    store.setAnalyzers(next)
    expect(next.at(-1)!.version).not.toBe(reviewer.version)
    expect(
      store.restore(input, hash('markdown'), hash('serialized'), 'work-email', settings),
    ).toBeNull()
    expect(
      (
        await runAnalyzer(
          next.at(-1)!,
          input,
          'document',
          effectiveConfig(settings, reviewer.id),
          provider,
          new AbortController().signal,
          cache,
        )
      ).requests,
    ).toBe(1)
    settings.customAnalyzers = []
    store.setAnalyzers(createAnalyzerRegistry(settings))
    expect(
      store.restore(input, hash('markdown'), hash('serialized'), 'work-email', settings),
    ).toBeNull()
  })
  it('round-trips custom profile history and backend provenance without losing old metadata', () => {
    const { settings, registry } = setup(),
      history = new AnalysisHistory()
    const id = history.start(
      'doc',
      hash('source'),
      'document',
      'work-email',
      false,
      registry.filter((a) => a.id === definition.id),
      settings,
    )
    history.update(id, definition.id, { status: 'completed', findings: 0 })
    history.finish(id)
    const imported = new AnalysisHistory()
    imported.import(history.export())
    expect(imported.forDocument('doc')[0]).toMatchObject({
      profile: 'work-email',
      profileName: 'Work Email',
      reviewers: [{ backend: 'Default', model: 'qwen3-8b' }],
    })
    const legacy = { ...(history.export() as { version: number; runs: unknown[] }), version: 1 }
    expect(() => imported.import(legacy)).not.toThrow()
  })
})
