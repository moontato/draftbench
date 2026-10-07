import { z } from 'zod'
import { canonical, hash } from '../diagnostics/hash'
import { refreshDiagnostic, resolveIssue } from '../diagnostics/mapping'
import type { Diagnostic, Issue, Scope, Snapshot } from '../diagnostics/types'
import { profiles, type ProfileId } from '../profiles/profiles'
import {
  DEFAULT_INPUT_BUDGETS,
  effectiveConfig,
  inputBudgetsSchema,
  sameInputBudgets,
  type InputBudgets,
  type Settings,
} from '../settings/model'
import { validateResult } from './llm/semantic'
import { engineMetadata } from './runner'
import type { Analyzer } from './types'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const sourceSchema = z.object({
  id: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  configurationHash: digest,
})
const findingSchema = z.object({
  analyzerId: z.string().min(1).max(100),
  blockIndex: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(), // Application-validated block offset, never a model offset.
  issue: z.unknown(),
  dependencies: z
    .array(z.object({ blockIndex: z.number().int().nonnegative(), hash: digest }))
    .max(5000),
  documentScope: z.boolean(),
  nearby: z.boolean(),
})
const reviewSchema = z.object({
  documentId: z.string().min(1).max(100),
  documentHash: digest,
  markdownHash: digest,
  serializedHash: digest,
  profile: z.enum(['general', 'technical', 'essay', 'email']),
  scope: z.enum(['selection', 'block', 'document']),
  analyzedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  inputBudgets: inputBudgetsSchema.optional(),
  sources: z.array(sourceSchema).min(1).max(50),
  findings: z.array(findingSchema).max(1000),
})
type SavedFinding = Omit<z.infer<typeof findingSchema>, 'issue'> & { issue: Issue }
type SavedReview = Omit<z.infer<typeof reviewSchema>, 'findings'> & { findings: SavedFinding[] }
export interface SavedReviewSummary {
  inputBudgets?: InputBudgets
  documentId: string
  serializedHash: string
  analyzedAt: number
  profile: ProfileId
  scope: Scope
  sources: { id: string; version: string; configurationHash: string; findings: number }[]
}
export interface RestoredReview {
  findings: Diagnostic[]
  analyzedAt: number
  analyzerCount: number
  scope: Scope
}

// Separate from the request cache: records which successful review to show on reopen.
// No ProseMirror ranges or session block IDs are persisted. Exact document matching only.
export class SavedReviews {
  private entries = new Map<string, SavedReview>()
  constructor(private analyzers: Analyzer[]) {}

  capture(
    input: Snapshot,
    markdownHash: string,
    serializedHash: string,
    profile: ProfileId,
    settings: Settings,
    findings: Diagnostic[],
    reviewedIds: string[],
    scope: Scope = 'document',
  ): boolean {
    const ids = [...new Set([...reviewedIds, ...findings.map((f) => f.analyzerId)])]
    const sources: SavedReview['sources'] = []
    for (const id of ids) {
      const analyzer = this.analyzers.find((a) => a.id === id)
      if (!analyzer || !this.enabled(id, profile, settings)) return false
      sources.push({
        id,
        version: analyzer.version,
        configurationHash: hash(canonical(effectiveConfig(settings, id))),
      })
    }
    if (!sources.length || findings.length > 1000) return false
    const saved: SavedFinding[] = []
    for (const finding of findings) {
      const source = sources.find((s) => s.id === finding.analyzerId)!
      const fresh = refreshDiagnostic(finding, input)
      if (
        !fresh ||
        finding.analyzerVersion !== source.version ||
        finding.configurationHash !== source.configurationHash
      )
        return false
      const dependencies: SavedFinding['dependencies'] = []
      for (const [id, fingerprint] of Object.entries(finding.dependencies)) {
        if (id.startsWith('$')) {
          if (id !== '$document' && id !== `$neighbors:${finding.blockId}`) return false
          continue
        }
        const blockIndex = input.blocks.findIndex((b) => b.id === id)
        if (blockIndex < 0) return false
        dependencies.push({ blockIndex, hash: fingerprint })
      }
      const blockIndex = input.blocks.findIndex((b) => b.id === finding.blockId)
      const issue: Issue = {
        block_id: String(blockIndex),
        quote: finding.quote,
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
        explanation: finding.explanation,
        replacement: finding.replacement,
        confidence: finding.confidence,
      }
      const validated = validateResult({ issues: [issue] })
      if (validated.warnings.length) return false
      saved.push({
        analyzerId: finding.analyzerId,
        blockIndex,
        start: finding.start,
        issue: validated.issues[0],
        dependencies,
        documentScope: !!finding.dependencies.$document,
        nearby: !!finding.dependencies[`$neighbors:${finding.blockId}`],
      })
    }
    const record: SavedReview = {
      documentId: input.documentId,
      documentHash: input.hash,
      markdownHash,
      serializedHash,
      profile,
      scope,
      analyzedAt: Date.now(),
      inputBudgets: inputBudgetsSchema.parse(settings.analysis),
      sources,
      findings: saved,
    }
    this.entries.set(input.documentId, record)
    this.prune()
    return this.entries.get(input.documentId) === record
  }

  restore(
    input: Snapshot,
    markdownHash: string,
    serializedHash: string,
    profile: ProfileId,
    settings: Settings,
  ): RestoredReview | null {
    const record = this.entries.get(input.documentId)
    if (
      !record ||
      record.documentHash !== input.hash ||
      record.markdownHash !== markdownHash ||
      record.serializedHash !== serializedHash ||
      record.profile !== profile ||
      (!sameInputBudgets(record.inputBudgets ?? DEFAULT_INPUT_BUDGETS, settings.analysis) &&
        record.sources.some(
          (source) => this.analyzers.find((a) => a.id === source.id)?.engine === 'ai',
        ))
    )
      return null
    for (const source of record.sources) {
      const analyzer = this.analyzers.find((a) => a.id === source.id)
      if (
        !analyzer ||
        analyzer.version !== source.version ||
        !this.enabled(source.id, profile, settings) ||
        source.configurationHash !== hash(canonical(effectiveConfig(settings, source.id)))
      )
        return null
    }
    const findings: Diagnostic[] = []
    for (const saved of record.findings) {
      const source = record.sources.find((s) => s.id === saved.analyzerId)
      const analyzer = this.analyzers.find((a) => a.id === saved.analyzerId)
      const block = input.blocks[saved.blockIndex]
      if (
        !source ||
        !analyzer ||
        !block ||
        saved.issue.block_id !== String(saved.blockIndex) ||
        block.text.slice(saved.start, saved.start + saved.issue.quote.length) !== saved.issue.quote
      )
        return null
      const dependencies: Record<string, string> = {}
      for (const dependency of saved.dependencies) {
        const context = input.blocks[dependency.blockIndex]
        if (!context || context.hash !== dependency.hash) return null
        dependencies[context.id] = context.hash
      }
      if (saved.documentScope) dependencies.$document = input.hash
      if (saved.nearby)
        dependencies[`$neighbors:${block.id}`] = hash(
          JSON.stringify(
            input.blocks
              .filter((b) => Math.abs(b.order - block.order) === 1)
              .map((b) => [b.id, b.hash]),
          ),
        )
      const from = block.positions[saved.start],
        to = block.positions[saved.start + saved.issue.quote.length]
      if (from === undefined || to === undefined || to <= from) return null
      const finding = resolveIssue(
        {
          ...saved.issue,
          block_id: block.id,
          offset: analyzer.engine === 'deterministic' ? saved.start : undefined,
        },
        { ...input, selection: { from, to } },
        analyzer.id,
        analyzer.version,
        engineMetadata(analyzer, effectiveConfig(settings, analyzer.id)),
        source.configurationHash,
        dependencies,
      )
      if (!finding || !refreshDiagnostic(finding, input)) return null
      findings.push(finding)
    }
    return {
      findings,
      analyzedAt: record.analyzedAt,
      analyzerCount: record.sources.length,
      scope: record.scope,
    }
  }

  // A normal save can normalize Markdown formatting without changing the editor.
  // Rebind the disk hash only when the exact analyzed editor serialization still matches.
  confirmSave(input: Snapshot, serializedHash: string, previousDiskHash: string, diskHash: string) {
    const record = this.entries.get(input.documentId)
    if (
      record &&
      record.documentHash === input.hash &&
      record.serializedHash === serializedHash &&
      (record.markdownHash === previousDiskHash || record.markdownHash === diskHash)
    )
      record.markdownHash = diskHash
  }
  clear() {
    this.entries.clear()
  }
  delete(documentId: string) {
    this.entries.delete(documentId)
  }
  summaries(): SavedReviewSummary[] {
    return [...this.entries.values()].map((review) => ({
      documentId: review.documentId,
      serializedHash: review.serializedHash,
      analyzedAt: review.analyzedAt,
      profile: review.profile,
      scope: review.scope,
      inputBudgets: review.inputBudgets,
      sources: review.sources.map((source) => ({
        ...source,
        findings: review.findings.filter((f) => f.analyzerId === source.id).length,
      })),
    }))
  }
  export(): unknown {
    return { version: 1, reviews: [...this.entries.values()] }
  }
  import(raw: unknown) {
    const parsed = z
      .object({ version: z.literal(1), reviews: z.array(reviewSchema).max(50) })
      .safeParse(raw)
    if (!parsed.success)
      throw new Error('Saved reviews are incompatible or corrupt; they will not be restored.')
    for (const review of parsed.data.reviews) {
      const findings: SavedFinding[] = []
      let valid = true
      for (const saved of review.findings) {
        const result = validateResult({ issues: [saved.issue] })
        if (result.warnings.length) {
          valid = false
          break
        }
        findings.push({ ...saved, issue: result.issues[0] })
      }
      if (valid) this.entries.set(review.documentId, { ...review, findings })
    }
    this.prune()
  }
  private enabled(id: string, profile: ProfileId, settings: Settings) {
    return (settings.analyzers[id]?.enabled ?? true) && profiles[profile].enabled.includes(id)
  }
  private prune() {
    while (
      this.entries.size > 50 ||
      new TextEncoder().encode(JSON.stringify([...this.entries.values()])).byteLength > 500_000
    ) {
      const oldest = [...this.entries].sort(([, a], [, b]) => a.analyzedAt - b.analyzedAt)[0]?.[0]
      if (oldest) this.entries.delete(oldest)
    }
  }
}
