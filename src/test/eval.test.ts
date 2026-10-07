import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  corpusSchema,
  evalSnapshot,
  evaluateCase,
  markdownReport,
  summarize,
  type EvalCase,
} from '../eval/harness'
import { evaluationTransport, type HttpAttempt } from '../eval/transport'
import { defaultSettings, effectiveConfig } from '../settings/model'
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
    expect(cases).toHaveLength(12)
    for (const analyzer of ['clarity', 'ambiguous-reference', 'redundancy', 'structure']) {
      expect(cases.some((c) => c.analyzer === analyzer && c.expectNoFindings)).toBe(true)
      expect(cases.some((c) => c.analyzer === analyzer && !c.expectNoFindings)).toBe(true)
    }
    expect(corpusSchema.safeParse([cases[0], cases[0]]).success).toBe(false)
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
})
