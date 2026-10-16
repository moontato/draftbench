import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  attachLabels,
  corpusSchema,
  evalLabelsSchema,
  evalSnapshot,
  evaluateCase,
  evaluateCorpus,
  filterCorpus,
  markdownReport,
  summarize,
  type EvalCase,
} from '../eval/harness'
import { evaluationTransport, type HttpAttempt } from '../eval/transport'
import { defaultSettings, effectiveConfig, loadSettings } from '../settings/model'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { AnalysisJobs } from '../analyzers/jobs'
import { OpenAICompatibleProvider } from '../ai/providers/openai'
import { ProviderError, type AIProvider } from '../ai/types'
const test: EvalCase = {
  id: 'example',
  analyzer: 'clarity',
  profile: 'general',
  source: 'This is unclear.',
  expectedBehavior: 'Flag the unclear meaning.',
  expectedQuote: 'This is unclear.',
  expectNoFindings: false,
}
function provider(raw: unknown): AIProvider {
  return {
    testConnection: vi.fn(),
    listModels: vi.fn(),
    completeStructured: vi.fn(async () => raw),
  }
}
const issue = {
  block_id: 'eval-0',
  quote: 'This is unclear.',
  category: 'clarity',
  severity: 'suggestion',
  message: 'Unclear meaning.',
  explanation: 'The intended action is not stated.',
  replacement: 'Please approve the budget.',
  confidence: 0.8,
}
const settings = defaultSettings(),
  target = { backend: 'Default', config: effectiveConfig(settings, 'clarity') }
afterEach(() => vi.unstubAllGlobals())
describe('opt-in evaluation measurements without inference servers', () => {
  it('validates the human-editable corpus with every built-in AI reviewer and clean cases', () => {
    const cases = corpusSchema.parse(JSON.parse(readFileSync('eval/corpus.json', 'utf8')))
    expect(cases).toHaveLength(38)
    for (const analyzer of [
      'clarity',
      'ambiguous-reference',
      'redundancy',
      'structure',
      'development',
    ]) {
      expect(cases.some((c) => c.analyzer === analyzer && c.expectNoFindings)).toBe(true)
      expect(cases.some((c) => c.analyzer === analyzer && !c.expectNoFindings)).toBe(true)
    }
    expect(corpusSchema.safeParse([cases[0], cases[0]]).success).toBe(false)
    // Multi-paragraph and long-document coverage, not just single sentences.
    expect(cases.filter((c) => c.source.includes('\n\n')).length).toBeGreaterThanOrEqual(15)
    expect(Math.max(...cases.map((c) => c.source.length))).toBeGreaterThan(1_000)
    // An expected quote that is not in its own case cannot be graded.
    for (const test of cases)
      if (test.expectedQuote) expect(test.source.includes(test.expectedQuote)).toBe(true)
  })
  it('keeps the corpus, its human labels and its custom-reviewer fixture consistent', () => {
    const cases = corpusSchema.parse(JSON.parse(readFileSync('eval/corpus.json', 'utf8'))),
      labels = evalLabelsSchema.parse(JSON.parse(readFileSync('eval/labels.json', 'utf8')))
    expect(labels).toHaveLength(cases.length)
    expect(attachLabels(cases, labels).size).toBe(cases.length)
    expect(() =>
      attachLabels(cases, [{ caseId: 'not-a-case', verdict: 'expected', reviewer: 'someone' }]),
    ).toThrow('unknown case')
    // Labels are draft judgements until the author confirms them, and they are never model input.
    expect(labels.every((label) => label.reviewer.trim().length > 0)).toBe(true)
    const custom = cases.filter((c) => c.analyzer === 'eval-reviewer')
    expect(custom.length).toBeGreaterThanOrEqual(3)
    expect(custom.some((c) => c.expectNoFindings)).toBe(true)
    const { settings, warnings } = loadSettings(
      JSON.parse(readFileSync('eval/eval-settings.json', 'utf8')),
    )
    expect(warnings).toEqual([])
    const registered = createAnalyzerRegistry(settings)
    for (const test of cases) expect(registered.some((a) => a.id === test.analyzer)).toBe(true)
    expect(
      registered.some(
        (a) => a.id === 'eval-reviewer' && a.engine === 'ai' && a.origin === 'custom',
      ),
    ).toBe(true)
  })
  it('filters corpus cases by analyzer and profile without touching anything else', () => {
    const cases = corpusSchema.parse(JSON.parse(readFileSync('eval/corpus.json', 'utf8')))
    expect(filterCorpus(cases, [], [])).toHaveLength(cases.length)
    const clarity = filterCorpus(cases, ['clarity'], [])
    expect(clarity.length).toBeGreaterThan(0)
    expect(clarity.every((c) => c.analyzer === 'clarity')).toBe(true)
    const both = filterCorpus(cases, ['clarity'], ['essay'])
    expect(both.length).toBeGreaterThan(0)
    expect(both.every((c) => c.analyzer === 'clarity' && c.profile === 'essay')).toBe(true)
    expect(filterCorpus(cases, ['clarity'], ['no-such-profile'])).toEqual([])
  })
  it('records structured validity, exact quotes, mapping, findings and latency as separate metrics', async () => {
    const mock = provider({ issues: [issue] })
    const result = await evaluateCase(test, target, settings, mock, new AbortController().signal)
    expect(result.casePassed).toBe(true)
    expect(result.units[0]).toMatchObject({ structuredValid: true, validIssues: 1, exactQuotes: 1 })
    expect(result.findings).toHaveLength(1)
    expect(summarize([result])[0]).toMatchObject({
      mapped: 1,
      cases: 1,
      passed: 1,
      falsePositives: 0,
    })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(vi.mocked(mock.completeStructured).mock.calls[0][0])).not.toContain(
      test.expectedBehavior,
    )
    expect(markdownReport([result])).toContain('proxies')
  })
  it('measures clean-case false positives and successful zero findings without rewarding volume', async () => {
    const clean = { ...test, expectNoFindings: true, expectedQuote: undefined }
    const wrong = await evaluateCase(
      clean,
      target,
      settings,
      provider({ issues: [issue] }),
      new AbortController().signal,
    )
    expect(wrong.falsePositive).toBe(true)
    expect(wrong.casePassed).toBe(false)
    const correct = await evaluateCase(
      clean,
      target,
      settings,
      provider({ issues: [] }),
      new AbortController().signal,
    )
    expect(correct.casePassed).toBe(true)
    expect(correct.falsePositive).toBe(false)
    expect(summarize([wrong, correct])[0].falsePositives).toBe(1)
  })
  it('distinguishes malformed output from schema-valid but unmappable or non-unique quotes', async () => {
    const malformed = await evaluateCase(
      test,
      target,
      settings,
      provider({ issues: [{ ...issue, confidence: 2 }] }),
      new AbortController().signal,
    )
    expect(malformed.units[0]).toMatchObject({
      structuredValid: false,
      malformed: true,
      validIssues: 0,
    })
    const unmappable = await evaluateCase(
      test,
      target,
      settings,
      provider({ issues: [{ ...issue, quote: 'invented' }] }),
      new AbortController().signal,
    )
    expect(unmappable.units[0].structuredValid).toBe(true)
    expect(unmappable.units[0].exactQuotes).toBe(0)
    expect(unmappable.findings).toHaveLength(0)
    expect(unmappable.missedExpectedIssue).toBe(true)
    expect(summarize([unmappable])[0]).toMatchObject({ validIssues: 1, mapped: 0 })
    const ambiguous = await evaluateCase(
      { ...test, source: 'This is unclear. This is unclear.' },
      target,
      settings,
      provider({ issues: [issue] }),
      new AbortController().signal,
    )
    expect(ambiguous.units[0].exactQuotes).toBe(0)
    expect(ambiguous.findings).toHaveLength(0)
  })
  it('reports network failures separately rather than pretending they are malformed model output', async () => {
    const mock = provider(null)
    vi.mocked(mock.completeStructured).mockRejectedValue(
      new ProviderError('network', 'Unavailable endpoint.'),
    )
    const result = await evaluateCase(test, target, settings, mock, new AbortController().signal)
    expect(result.casePassed).toBe(false)
    expect(result.units[0].malformed).toBe(false)
    expect(result.warnings).toContain('Unavailable endpoint.')
  })
  it('uses production schema fallback and isolates HTTP credentials without storing request headers', async () => {
    const attempts: HttpAttempt[] = []
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"issues":[]}' }, finish_reason: 'stop' }],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const native = new OpenAICompatibleProvider(
      evaluationTransport({ 'backend:gpu': 'private-key' }, attempts),
    )
    await native.completeStructured(
      { system: 'Review.', user: 'Source.', schema: {} },
      { ...target.config, serverUrl: 'http://localhost:8080/v1', credentialRef: 'backend:gpu' },
      new AbortController().signal,
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:8080/v1/chat/completions')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer private-key')
    expect(JSON.stringify(attempts)).not.toContain('private-key')
    expect(attempts[1].latencyMs).toBeGreaterThanOrEqual(0)
    expect(evalSnapshot('# Heading\n\nA paragraph.').blocks[0]).toMatchObject({
      type: 'heading',
      text: 'Heading',
      headingLevel: 1,
    })
  })
  it('repeats cases per target and separates stable verdicts from flaky ones', async () => {
    let call = 0
    const alternating: AIProvider = {
      testConnection: vi.fn(),
      listModels: vi.fn(),
      completeStructured: vi.fn(async () => {
        call++
        // One repeat reports the expected issue, the next reports nothing.
        return call % 2 ? { issues: [issue] } : { issues: [] }
      }),
    }
    const run = await evaluateCorpus(
      [test],
      [target],
      settings,
      alternating,
      new AbortController().signal,
      {
        repeats: 2,
      },
    )
    expect(run.results).toHaveLength(2)
    expect(run.results.map((r) => r.repeat).sort()).toEqual([0, 1])
    const summary = summarize(run.results, run.jobs)[0]
    expect(summary.cases).toBe(1)
    expect(summary.runs).toBe(2)
    expect(summary.repeats).toBe(2)
    expect(summary.passed).toBe(1)
    expect(summary.flakyCases).toBe(1)
    expect(summary.stableCases).toBe(0)
    expect(markdownReport(run.results, run.jobs)).toContain('flaky')
    await expect(
      evaluateCorpus([test], [target], settings, alternating, new AbortController().signal, {
        repeats: 9,
      }),
    ).rejects.toThrow('1–5')
  })
  it('labels annotate the report without ever reaching the model', async () => {
    const label = {
      caseId: test.id,
      verdict: 'too-strict' as const,
      note: 'The expectation asks for too much.',
      reviewer: 'author',
    }
    const mock = provider({ issues: [issue] })
    const run = await evaluateCorpus(
      [test],
      [target],
      settings,
      mock,
      new AbortController().signal,
      {
        labels: attachLabels([test], [label]),
      },
    )
    expect(run.results[0].humanLabel).toMatchObject({ verdict: 'too-strict', reviewer: 'author' })
    expect(JSON.stringify(run.results)).toContain('too-strict')
    const requests = vi
      .mocked(mock.completeStructured)
      .mock.calls.map((call) => JSON.stringify(call[0]))
    expect(requests).toHaveLength(1)
    for (const request of requests) {
      expect(request).not.toContain('too-strict')
      expect(request).not.toContain('The expectation asks for too much')
      expect(request).not.toContain(test.expectedBehavior)
    }
  })
  it('measures queue pressure separately from model latency without changing scheduling', async () => {
    const jobs = new AnalysisJobs(1, { default: { resource: 'http://127.0.0.1:8080', limit: 1 } }),
      signal = new AbortController().signal
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const first = jobs.run(signal, () => gate, 'default')
    const queued = [
      jobs.run(signal, async () => 1, 'default'),
      jobs.run(signal, async () => 2, 'default'),
    ]
    await new Promise((resolve) => setTimeout(resolve, 25))
    release()
    expect(await Promise.all([first, ...queued])).toEqual([undefined, 1, 2])
    const stats = jobs.queueStats(jobs.resourceOf('default'))
    expect(stats.resource).toBe('http://127.0.0.1:8080')
    expect(stats.completed).toBe(3)
    expect(stats.waited).toBeGreaterThanOrEqual(1)
    expect(stats.p50WaitMs).toBeGreaterThanOrEqual(1)
    expect(stats.maxWaitMs).toBeGreaterThanOrEqual(stats.p50WaitMs)
    expect(jobs.queueStats('http://never-used').waited).toBe(0)
    expect(jobs.queueStats('http://never-used').completed).toBe(0)
  })
})
