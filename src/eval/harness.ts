import { z } from 'zod'
import type { AIProvider, StructuredRequest } from '../ai/types'
import { ProviderError } from '../ai/types'
import type { EffectiveConfig, Settings } from '../settings/model'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { AnalysisJobs, mapConcurrent } from '../analyzers/jobs'
import { validateResult } from '../analyzers/llm/semantic'
import { hash } from '../diagnostics/hash'
import type { Diagnostic, Snapshot } from '../diagnostics/types'

export const evalCaseSchema = z.object({
  id: z.string().min(1).max(100),
  profile: z.string().min(1).max(100),
  source: z.string().min(1).max(1_000_000),
  analyzer: z.string().min(1).max(64),
  expectedBehavior: z.string().min(1).max(2000),
  expectedQuote: z.string().min(1).optional(),
  expectNoFindings: z.boolean().default(false),
})
export const corpusSchema = z
  .array(evalCaseSchema)
  .min(1)
  .max(1000)
  .refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, 'Duplicate case IDs.')
export type EvalCase = z.infer<typeof evalCaseSchema>
export interface EvalTarget {
  backend: string
  config: EffectiveConfig
}
export interface UnitTrace {
  latencyMs: number
  structuredValid: boolean
  malformed: boolean
  declaredIssues: number
  validIssues: number
  exactQuotes: number
  request: StructuredRequest
  raw?: unknown
  error?: string
}
export interface CaseResult {
  id: string
  analyzer: string
  profile: string
  backend: string
  backendId?: string
  model: string
  server: string
  expectedBehavior: string
  expectedQuote?: string
  expectNoFindings: boolean
  latencyMs: number
  findings: Diagnostic[]
  warnings: string[]
  units: UnitTrace[]
  casePassed: boolean
  falsePositive: boolean
  missedExpectedIssue: boolean
  expectedQuoteFound?: boolean
}
export function evalSnapshot(source: string): Snapshot {
  let position = 1
  const blocks = source
    .split(/\n\s*\n/)
    .filter((text) => text.trim())
    .map((raw, order) => {
      const heading = raw.match(/^(#{1,6})\s+(.+)$/)
      const text = heading ? heading[2] : raw
      const from = position
      position += text.length + 2
      return {
        id: `eval-${order}`,
        type: heading ? 'heading' : 'paragraph',
        text,
        hash: hash(text),
        from,
        to: from + text.length,
        positions: Array.from({ length: text.length + 1 }, (_, i) => from + i),
        order,
        ...(heading ? { headingLevel: heading[1].length } : {}),
      }
    })
  return { documentId: 'eval', revision: 0, hash: hash(source), blocks }
}
function quoteCount(text: string, quote: string): number {
  let count = 0
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) count++
  return count
}
export async function evaluateCase(
  test: EvalCase,
  target: EvalTarget,
  settings: Settings,
  provider: AIProvider,
  signal: AbortSignal,
  jobs?: AnalysisJobs,
): Promise<CaseResult> {
  const start = performance.now(),
    units: UnitTrace[] = [],
    input = evalSnapshot(test.source)
  const analyzer = createAnalyzerRegistry(settings).find((a) => a.id === test.analyzer)
  if (!analyzer || analyzer.engine !== 'ai')
    throw new Error(`Evaluation requires an AI analyzer: ${test.analyzer}`)
  const traced: AIProvider = {
    testConnection: provider.testConnection.bind(provider),
    listModels: provider.listModels.bind(provider),
    async completeStructured(request, config, signal) {
      const began = performance.now()
      const trace: UnitTrace = {
        latencyMs: 0,
        structuredValid: false,
        malformed: false,
        declaredIssues: 0,
        validIssues: 0,
        exactQuotes: 0,
        request,
      }
      units.push(trace)
      try {
        trace.raw = await provider.completeStructured(request, config, signal)
        trace.declaredIssues =
          trace.raw &&
          typeof trace.raw === 'object' &&
          Array.isArray((trace.raw as { issues?: unknown }).issues)
            ? (trace.raw as { issues: unknown[] }).issues.length
            : 0
        const validated = validateResult(trace.raw)
        trace.validIssues = validated.issues.length
        trace.structuredValid = !validated.warnings.length
        trace.malformed = !trace.structuredValid
        const targets = (
          JSON.parse(request.user) as { targets: { block_id: string; text: string }[] }
        ).targets
        trace.exactQuotes = validated.issues.filter((issue) => {
          const block = targets.find((b) => b.block_id === issue.block_id)
          return block && quoteCount(block.text, issue.quote) === 1
        }).length
        return trace.raw
      } catch (error) {
        trace.error = error instanceof Error ? error.message : 'Review failed.'
        trace.malformed = error instanceof ProviderError && error.kind === 'malformed'
        throw error
      } finally {
        trace.latencyMs = performance.now() - began
      }
    },
  }
  let findings: Diagnostic[] = [],
    warnings: string[] = []
  try {
    const scope = analyzer.preferredScope === 'selection' ? 'selection' : 'document'
    if (scope === 'selection')
      input.selection = { from: input.blocks[0].from, to: input.blocks.at(-1)!.to }
    const result = await runAnalyzer(
      analyzer,
      input,
      scope,
      target.config,
      traced,
      signal,
      new AnalysisCache(),
      true,
      jobs,
      settings.analysis,
    )
    findings = result.findings
    warnings = result.warnings
  } catch (error) {
    warnings = [error instanceof Error ? error.message : 'Review failed.']
  }
  const expectedQuoteFound =
    test.expectedQuote === undefined
      ? undefined
      : findings.some((f) => f.quote.includes(test.expectedQuote!))
  const falsePositive = test.expectNoFindings && findings.length > 0
  const missedExpectedIssue = !test.expectNoFindings && findings.length === 0
  const casePassed =
    !warnings.length &&
    units.length > 0 &&
    units.every((u) => u.structuredValid) &&
    (test.expectNoFindings
      ? findings.length === 0
      : findings.length > 0 && (expectedQuoteFound ?? true))
  return {
    id: test.id,
    analyzer: test.analyzer,
    profile: test.profile,
    backend: target.backend,
    backendId: target.config.backendId,
    model: target.config.model,
    server: target.config.serverUrl,
    expectedBehavior: test.expectedBehavior,
    expectedQuote: test.expectedQuote,
    expectNoFindings: test.expectNoFindings,
    latencyMs: performance.now() - start,
    findings,
    warnings,
    units,
    casePassed,
    falsePositive,
    missedExpectedIssue,
    expectedQuoteFound,
  }
}
export async function evaluateCorpus(
  cases: EvalCase[],
  targets: EvalTarget[],
  settings: Settings,
  provider: AIProvider,
  signal: AbortSignal,
): Promise<CaseResult[]> {
  const resources: Record<string, { resource: string; limit: number }> = {}
  for (const target of targets) {
    const id = target.config.backendId ?? target.backend
    resources[id] = {
      resource: target.config.serverUrl.replace(/\/v1$/, ''),
      limit: settings.backends.find((b) => b.id === id)?.parallelJobs ?? 2,
    }
  }
  const jobs = new AnalysisJobs(settings.analysis.parallelJobs, resources)
  const work = targets.flatMap((target) => cases.map((test) => ({ target, test })))
  // All cases can queue fairly; the shared scheduler bounds actual HTTP review units.
  return mapConcurrent(work, Math.min(32, work.length), ({ target, test }) =>
    evaluateCase(test, target, settings, provider, signal, jobs),
  )
}
export function summarize(results: CaseResult[]) {
  const groups = new Map<string, CaseResult[]>()
  for (const result of results) {
    const key = `${result.backend} (${result.backendId ?? result.server}) · ${result.model}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  return [...groups].map(([target, cases]) => {
    const units = cases.flatMap((c) => c.units),
      validIssues = units.reduce((n, u) => n + u.validIssues, 0)
    const mapped = cases.reduce((n, c) => n + c.findings.length, 0)
    return {
      target,
      cases: cases.length,
      passed: cases.filter((c) => c.casePassed).length,
      units: units.length,
      structuredValid: units.filter((u) => u.structuredValid).length,
      malformed: units.filter((u) => u.malformed).length,
      validIssues,
      mapped,
      exactQuotes: units.reduce((n, u) => n + u.exactQuotes, 0),
      findings: mapped,
      falsePositives: cases.filter((c) => c.falsePositive).length,
      missedExpectedIssues: cases.filter((c) => c.missedExpectedIssue).length,
      avgUnitLatencyMs: units.length
        ? units.reduce((n, u) => n + u.latencyMs, 0) / units.length
        : 0,
      totalCaseLatencyMs: cases.reduce((n, c) => n + c.latencyMs, 0),
    }
  })
}
export function markdownReport(results: CaseResult[]): string {
  const percent = (n: number, total: number) =>
    total ? `${((n * 100) / total).toFixed(1)}%` : 'N/A'
  const safe = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')
  return (
    '# Draftbench analyzer evaluation\n\nCases passed are **proxies**, not a semantic quality score. Expected-behavior descriptions require human review. Inspect individual findings and raw outputs in the JSON report. Clean-case false positives matter. This harness uses plain paragraphs/ATX headings, not full editor Markdown fidelity.\n\n' +
    '| Backend/model | Structured valid | Malformed | Mapping | Exact quote | Cases passed | Clean false positives | Missed expected | Avg review-unit latency |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
    summarize(results)
      .map(
        (s) =>
          `| ${safe(s.target)} | ${percent(s.structuredValid, s.units)} | ${percent(s.malformed, s.units)} | ${percent(s.mapped, s.validIssues)} | ${percent(s.exactQuotes, s.validIssues)} | ${s.passed}/${s.cases} | ${s.falsePositives} | ${s.missedExpectedIssues} | ${(s.avgUnitLatencyMs / 1000).toFixed(2)}s |`,
      )
      .join('\n') +
    '\n\nProtocol failures, network failures and unmappable quotes are not evidence of semantic quality. Per-HTTP-attempt latency (including format fallbacks), total wall time, source prompts and responses are stored separately in JSON. No expected answers are sent to the model.\n'
  )
}
