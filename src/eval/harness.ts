import { z } from 'zod'
import type { AIProvider, StructuredRequest } from '../ai/types'
import { ProviderError } from '../ai/types'
import type { EffectiveConfig, Settings } from '../settings/model'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { runAnalyzer } from '../analyzers/runner'
import { AnalysisCache } from '../analyzers/cache'
import { AnalysisJobs, mapConcurrent, type QueueStats } from '../analyzers/jobs'
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
/** Human review of what a case should mean. Never sent to a model. */
export const evalLabelSchema = z.object({
  caseId: z.string().min(1).max(100),
  verdict: z.enum(['expected', 'too-strict', 'too-lenient', 'unclear']),
  note: z.string().min(1).max(1000).optional(),
  reviewer: z.string().min(1).max(100),
})
export const evalLabelsSchema = z
  .array(evalLabelSchema)
  .max(1000)
  .refine(
    (labels) => new Set(labels.map((l) => l.caseId)).size === labels.length,
    'Duplicate label case IDs.',
  )
export type EvalLabel = z.infer<typeof evalLabelSchema>
export function filterCorpus(
  cases: EvalCase[],
  analyzers: string[],
  profiles: string[],
): EvalCase[] {
  const analyzerIds = new Set(analyzers),
    profileIds = new Set(profiles)
  return cases.filter(
    (test) =>
      (!analyzerIds.size || analyzerIds.has(test.analyzer)) &&
      (!profileIds.size || profileIds.has(test.profile)),
  )
}
export function attachLabels(cases: EvalCase[], labels: EvalLabel[]): Map<string, EvalLabel> {
  const known = new Set(cases.map((c) => c.id)),
    attached = new Map<string, EvalLabel>()
  for (const label of labels) {
    if (!known.has(label.caseId))
      throw new Error(`Evaluation label refers to an unknown case: ${label.caseId}`)
    attached.set(label.caseId, label)
  }
  return attached
}
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
  /** 0-based repeat index when a case is run more than once. */
  repeat: number
  /** Review units this run was allowed to have in flight. */
  parallelJobs: number
  humanLabel?: EvalLabel
  latencyMs: number
  findings: Diagnostic[]
  warnings: string[]
  units: UnitTrace[]
  casePassed: boolean
  falsePositive: boolean
  missedExpectedIssue: boolean
  expectedQuoteFound?: boolean
}
export interface EvalRunOptions {
  jobs?: AnalysisJobs
  repeat?: number
  label?: EvalLabel
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
  options: EvalRunOptions = {},
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
      test.profile,
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
    repeat: options.repeat ?? 0,
    parallelJobs: settings.analysis.parallelJobs,
    humanLabel: options.label,
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
export interface EvalRun {
  results: CaseResult[]
  jobs: AnalysisJobs
  queue: QueueStats[]
}
export async function evaluateCorpus(
  cases: EvalCase[],
  targets: EvalTarget[],
  settings: Settings,
  provider: AIProvider,
  signal: AbortSignal,
  options: { repeats?: number; labels?: Map<string, EvalLabel> } = {},
): Promise<EvalRun> {
  const repeats = options.repeats ?? 1
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5)
    throw new Error('Repeats must be an integer from 1–5.')
  const resources: Record<string, { resource: string; limit: number }> = {}
  for (const target of targets) {
    const id = target.config.backendId ?? target.backend
    resources[id] = {
      resource: target.config.serverUrl.replace(/\/v1$/, ''),
      limit: settings.backends.find((b) => b.id === id)?.parallelJobs ?? 2,
    }
  }
  const jobs = new AnalysisJobs(settings.analysis.parallelJobs, resources)
  const work = targets.flatMap((target) =>
    cases.flatMap((test) =>
      Array.from({ length: repeats }, (_, repeat) => ({ target, test, repeat })),
    ),
  )
  // All cases can queue fairly; the shared scheduler bounds actual HTTP review units.
  const results = await mapConcurrent(work, Math.min(32, work.length), ({ target, test, repeat }) =>
    evaluateCase(test, target, settings, provider, signal, jobs, {
      repeat,
      label: options.labels?.get(test.id),
    }),
  )
  return {
    results,
    jobs,
    queue: jobs.queueResources().map((resource) => jobs.queueStats(resource)),
  }
}
export interface TargetSummary {
  target: string
  cases: number
  runs: number
  repeats: number
  passed: number
  stableCases: number
  flakyCases: number
  labeledCases: number
  units: number
  structuredValid: number
  malformed: number
  validIssues: number
  mapped: number
  exactQuotes: number
  findings: number
  falsePositives: number
  missedExpectedIssues: number
  avgUnitLatencyMs: number
  p50UnitLatencyMs: number
  p95UnitLatencyMs: number
  maxUnitLatencyMs: number
  totalCaseLatencyMs: number
  queueWaited: number
  queueCompleted: number
  queueP50WaitMs: number
  queueMaxWaitMs: number
}
export function summarize(results: CaseResult[], jobs?: AnalysisJobs): TargetSummary[] {
  const groups = new Map<string, CaseResult[]>()
  for (const result of results) {
    const key = `${result.backend} (${result.backendId ?? result.server}) · ${result.model} · ${result.parallelJobs} job${result.parallelJobs === 1 ? '' : 's'}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  return [...groups].map(([target, cases]) => {
    const units = cases.flatMap((c) => c.units),
      latencies = units.map((u) => u.latencyMs),
      validIssues = units.reduce((n, u) => n + u.validIssues, 0),
      mapped = cases.reduce((n, c) => n + c.findings.length, 0)
    const verdicts = new Map<string, Set<boolean>>()
    for (const result of cases)
      verdicts.set(result.id, (verdicts.get(result.id) ?? new Set()).add(result.casePassed))
    const queue = jobs?.queueStats(jobs.resourceOf(cases[0]?.backendId ?? cases[0]?.backend ?? ''))
    return {
      target,
      cases: verdicts.size,
      runs: cases.length,
      repeats: Math.max(1, new Set(cases.map((c) => c.repeat)).size),
      passed: cases.filter((c) => c.casePassed).length,
      stableCases: [...verdicts.values()].filter((v) => v.size === 1).length,
      flakyCases: [...verdicts.values()].filter((v) => v.size > 1).length,
      labeledCases: new Set(cases.filter((c) => c.humanLabel).map((c) => c.id)).size,
      units: units.length,
      structuredValid: units.filter((u) => u.structuredValid).length,
      malformed: units.filter((u) => u.malformed).length,
      validIssues,
      mapped,
      exactQuotes: units.reduce((n, u) => n + u.exactQuotes, 0),
      findings: mapped,
      falsePositives: cases.filter((c) => c.falsePositive).length,
      missedExpectedIssues: cases.filter((c) => c.missedExpectedIssue).length,
      avgUnitLatencyMs: latencies.length
        ? latencies.reduce((n, u) => n + u, 0) / latencies.length
        : 0,
      p50UnitLatencyMs: percentile(latencies, 0.5),
      p95UnitLatencyMs: percentile(latencies, 0.95),
      maxUnitLatencyMs: latencies.length ? Math.max(...latencies) : 0,
      totalCaseLatencyMs: cases.reduce((n, c) => n + c.latencyMs, 0),
      queueWaited: queue?.waited ?? 0,
      queueCompleted: queue?.completed ?? 0,
      queueP50WaitMs: queue?.p50WaitMs ?? 0,
      queueMaxWaitMs: queue?.maxWaitMs ?? 0,
    }
  })
}
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}
export function markdownReport(results: CaseResult[], jobs?: AnalysisJobs): string {
  const percent = (n: number, total: number) =>
    total ? `${((n * 100) / total).toFixed(1)}%` : 'N/A'
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`
  const safe = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')
  const repeats = new Set(results.map((r) => r.repeat)).size
  return (
    '# Draftbench analyzer evaluation\n\nCases passed are **proxies**, not a semantic quality score. Expected-behavior descriptions require human review. Inspect individual findings and raw outputs in the JSON report. Clean-case false positives matter. This harness uses plain paragraphs/ATX headings, not full editor Markdown fidelity.\n\n' +
    `Each case ran ${repeats} time${repeats === 1 ? '' : 's'} per target. A **stable** case gave the same verdict on every repeat; a **flaky** case did not, so its latency and verdict are not a single-run claim.\n\n` +
    '| Backend/model | Structured valid | Malformed | Mapping | Exact quote | Runs passed | Stable / flaky cases | Clean false positives | Missed expected | Median / p95 / slowest review unit | Queue wait (median / worst) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
    summarize(results, jobs)
      .map(
        (s) =>
          `| ${safe(s.target)} | ${percent(s.structuredValid, s.units)} | ${percent(s.malformed, s.units)} | ${percent(s.mapped, s.validIssues)} | ${percent(s.exactQuotes, s.validIssues)} | ${s.passed}/${s.runs} | ${s.stableCases}/${s.cases} stable, ${s.flakyCases} flaky | ${s.falsePositives} | ${s.missedExpectedIssues} | ${seconds(s.p50UnitLatencyMs)} / ${seconds(s.p95UnitLatencyMs)} / ${seconds(s.maxUnitLatencyMs)} | ${s.queueWaited ? `${seconds(s.queueP50WaitMs)} / ${seconds(s.queueMaxWaitMs)} (${s.queueWaited}/${s.queueCompleted} waited)` : 'none'} |`,
      )
      .join('\n') +
    '\n\nProtocol failures, network failures and unmappable quotes are not evidence of semantic quality. Queue wait is scheduler pressure, not model latency: it measures how long a review unit waited for a global/backend slot before the request began. Per-HTTP-attempt latency (including format fallbacks), total wall time, source prompts and responses are stored separately in JSON. No expected answers are sent to the model.\n'
  )
}
