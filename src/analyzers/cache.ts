import { z } from 'zod'
import { canonical, hash } from '../diagnostics/hash'
import { inferenceConfig, type EffectiveConfig } from '../settings/model'
import type { Issue } from '../diagnostics/types'
import type { AnalysisUnit, Analyzer, AnalyzerResult } from './types'
import { validateResult } from './llm/semantic'
interface Cached {
  issues: Issue[]
  warnings: string[]
  used: number
}
export class AnalysisCache {
  private entries = new Map<string, Cached>()
  key(analyzer: Analyzer, unit: AnalysisUnit, config: EffectiveConfig): string {
    return hash(
      canonical({
        analyzer: analyzer.id,
        version: analyzer.version,
        config: inferenceConfig(config),
        targets: unit.targets.map((b) => [
          b.type,
          b.headingLevel ?? null,
          b.ancestors ?? [],
          b.text,
          unit.documentScope ? b.order : 0,
        ]),
        context: unit.context.map((b) => [
          b.type,
          b.headingLevel ?? null,
          b.ancestors ?? [],
          b.text,
          unit.documentScope ? b.order : b.order - unit.targets[0].order,
        ]),
        scope: unit.documentScope,
      }),
    )
  }
  get(key: string, unit: AnalysisUnit): AnalyzerResult | undefined {
    const cached = this.entries.get(key)
    if (!cached) return
    cached.used = Date.now()
    // Cache uses target indices, not live block IDs/ranges. Only identical input hashes hit.
    return {
      issues: cached.issues.map((i) => ({
        ...i,
        block_id: unit.targets[Number(i.block_id)]?.id ?? '',
      })),
      warnings: [...cached.warnings],
    }
  }
  set(key: string, unit: AnalysisUnit, result: AnalyzerResult) {
    if (result.warnings.length || result.issues.length > 12) return // Don't persist failed/partial reviews or oversized rule result sets.
    this.entries.set(key, {
      issues: result.issues
        .map((i) => ({
          block_id: String(unit.targets.findIndex((b) => b.id === i.block_id)),
          quote: i.quote,
          category: i.category,
          severity: i.severity,
          message: i.message,
          explanation: i.explanation,
          replacement: i.replacement,
          replacements: i.replacements,
          confidence: i.confidence,
          offset: i.offset,
        }))
        .filter((i) => i.block_id !== '-1'),
      warnings: [],
      used: Date.now(),
    })
    this.prune()
  }
  private prune() {
    while (
      this.entries.size > 300 ||
      new TextEncoder().encode(JSON.stringify([...this.entries])).byteLength > 2_000_000
    ) {
      const oldest = [...this.entries].sort(([, a], [, b]) => a.used - b.used)[0]?.[0]
      if (oldest) this.entries.delete(oldest)
    }
  }
  clear() {
    this.entries.clear()
  }
  export(): unknown {
    return { version: 1, entries: [...this.entries].slice(-300) }
  }
  import(raw: unknown) {
    const parsed = z
      .object({
        version: z.literal(1),
        entries: z
          .array(
            z.tuple([
              z.string().length(64),
              z.object({
                issues: z.array(z.unknown()).max(12),
                warnings: z.array(z.string()),
                used: z.number(),
              }),
            ]),
          )
          .max(300),
      })
      .safeParse(raw)
    if (!parsed.success)
      throw new Error('Analysis cache is incompatible or corrupt; a fresh cache will be used.')
    for (const [key, entry] of parsed.data.entries) {
      const result = validateResult(entry)
      if (!result.warnings.length) this.entries.set(key, { ...result, used: entry.used })
    }
    this.prune()
  }
}
