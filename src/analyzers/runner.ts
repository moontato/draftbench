import type { Analyzer, AnalysisUnit } from './types'
import type { Block, Diagnostic, EngineMetadata, Scope, Snapshot } from '../diagnostics/types'
import { canonical, hash } from '../diagnostics/hash'
import { resolveIssue } from '../diagnostics/mapping'
import { DEFAULT_INPUT_BUDGETS, type EffectiveConfig, type InputBudgets } from '../settings/model'
import type { AIProvider } from '../ai/types'
import { AnalysisCache } from './cache'
import { type AnalysisJobs, mapConcurrent } from './jobs'
export function planScope(analyzer: Analyzer, input: Snapshot, scope: Scope): AnalysisUnit[] {
  if (!analyzer.scopes.includes(scope))
    throw new Error(`${analyzer.name} requires document analysis.`)
  let targets = input.blocks.filter((b) => b.type !== 'codeBlock' && b.text.trim())
  if (scope === 'selection') {
    if (!input.selection) throw new Error('Select a passage in the editor first.')
    const selection = input.selection
    targets = targets
      .filter((b) => b.to > selection.from && b.from < selection.to)
      .map((b) => {
        const start = b.positions.findIndex((p) => p >= selection.from)
        let end = b.positions.findIndex((p) => p >= selection.to)
        if (end < 0) end = b.text.length
        const offset = Math.max(0, start)
        const text = b.text.slice(offset, end)
        return { ...b, text, hash: hash(text), positions: b.positions.slice(offset, end + 1) }
      })
      .filter((b) => b.text.trim())
  }
  if (scope === 'block') {
    const caret = input.caret ?? input.selection?.from
    if (caret === undefined) throw new Error('Place the caret in a paragraph first.')
    targets = targets.filter((b) => b.from <= caret && b.to >= caret).slice(0, 1)
  }
  if (!targets.length) return []
  if (analyzer.preferredScope === 'document')
    return [
      { targets, context: input.blocks.filter((b) => b.type === 'codeBlock'), documentScope: true },
    ]
  return targets.map((target) => {
    const neighbors: Block[] =
      analyzer.preferredScope === 'nearby'
        ? input.blocks.filter((b) => Math.abs(b.order - target.order) === 1)
        : []
    return { targets: [target], context: neighbors, documentScope: false }
  })
}
export function engineMetadata(analyzer: Analyzer, config: EffectiveConfig): EngineMetadata {
  return analyzer.engine === 'ai'
    ? { kind: 'ai', name: 'OpenAI-Compatible', server: config.serverUrl, model: config.model }
    : { kind: 'deterministic', name: 'Local rules' }
}
export interface RunResult {
  findings: Diagnostic[]
  warnings: string[]
  cacheHits: number
  requests: number
}
export async function runAnalyzer(
  analyzer: Analyzer,
  input: Snapshot,
  scope: Scope,
  config: EffectiveConfig,
  provider: AIProvider,
  signal: AbortSignal,
  cache: AnalysisCache,
  force = false,
  jobs?: AnalysisJobs,
  budgets: InputBudgets = DEFAULT_INPUT_BUDGETS,
): Promise<RunResult> {
  const configurationHash = hash(canonical(config))
  const results = await mapConcurrent(
    planScope(analyzer, input, scope),
    analyzer.engine === 'ai' ? (jobs?.limit ?? 1) : 1,
    async (unit): Promise<RunResult> => {
      const findings: Diagnostic[] = [],
        warnings: string[] = []
      let cacheHits = 0,
        requests = 0
      if (signal.aborted) throw new Error('Analysis cancelled.')
      const textLength = [...unit.targets, ...unit.context].reduce((n, b) => n + b.text.length, 0)
      const budget = unit.documentScope ? budgets.documentInputChars : budgets.paragraphInputChars
      if (analyzer.engine === 'ai' && textLength > budget) {
        warnings.push(
          `${analyzer.name}: input has ${textLength.toLocaleString('en-US')} characters and exceeds the ${budget.toLocaleString('en-US')}-character ${unit.documentScope ? 'document' : 'paragraph/context'} input budget. Increase the budget in Settings → Analysis or analyze a smaller passage. No text was truncated.`,
        )
        return { findings, warnings, cacheHits, requests }
      }
      const key = cache.key(analyzer, unit, config)
      let result = force ? undefined : cache.get(key, unit)
      if (result) cacheHits++
      else {
        const analyze = () => analyzer.analyze({ input, unit, scope, config, provider, signal })
        result = await (jobs && analyzer.engine === 'ai' ? jobs.run(signal, analyze) : analyze())
        requests++
      }
      if (signal.aborted) throw new Error('Analysis cancelled.')
      const dependencies: Record<string, string> = Object.fromEntries(
        [...unit.targets, ...unit.context].map((b) => [
          b.id,
          input.blocks.find((original) => original.id === b.id)!.hash,
        ]),
      )
      if (unit.documentScope) dependencies.$document = input.hash
      if (analyzer.preferredScope === 'nearby')
        dependencies[`$neighbors:${unit.targets[0].id}`] = hash(
          JSON.stringify(unit.context.map((b) => [b.id, b.hash])),
        )
      const validIssues = []
      for (const issue of result.issues) {
        if (!unit.targets.some((b) => b.id === issue.block_id && b.text.includes(issue.quote))) {
          warnings.push('An out-of-scope finding was discarded.')
          continue
        }
        const finding = resolveIssue(
          issue,
          scope === 'selection' ? input : { ...input, selection: undefined },
          analyzer.id,
          analyzer.version,
          engineMetadata(analyzer, config),
          configurationHash,
          dependencies,
        )
        if (finding) {
          findings.push(finding)
          validIssues.push(issue)
        } else
          warnings.push('A finding could not be mapped uniquely to the source and was discarded.')
      }
      warnings.push(...result.warnings)
      if (!result.warnings.length && validIssues.length === result.issues.length)
        cache.set(key, unit, { issues: validIssues, warnings: [] })
      return { findings, warnings, cacheHits, requests }
    },
  )
  return {
    findings: results.flatMap((result) => result.findings),
    warnings: results.flatMap((result) => result.warnings),
    cacheHits: results.reduce((total, result) => total + result.cacheHits, 0),
    requests: results.reduce((total, result) => total + result.requests, 0),
  }
}
