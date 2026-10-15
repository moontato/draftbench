import { z } from 'zod'
import type { Analyzer } from './types'
import type { Diagnostic, Issue, Snapshot } from '../diagnostics/types'
import { hash } from '../diagnostics/hash'
import { refreshDiagnostic, resolveIssue } from '../diagnostics/mapping'
import { validateResult } from './llm/semantic'
import { reconcileReviewContexts } from '../profiles/reviewContext'
import {
  DEFAULT_INPUT_BUDGETS,
  inputBudgetsSchema,
  type InputBudgets,
  type Settings,
} from '../settings/model'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const dependencies = z
  .array(z.object({ blockIndex: z.number().int().nonnegative(), hash: digest }))
  .max(5000)
const fingerprint = z.object({
  start: z.number().int().nonnegative(),
  blockHash: digest,
  contentHash: digest,
  dependencies,
  documentScope: z.boolean(),
  nearby: z.boolean(),
})
const itemSchema = z
  .object({
    id: digest,
    analyzerId: z.string().min(1).max(100),
    analyzerVersion: z.string().min(1).max(100),
    configurationHash: digest,
    engine: z.object({
      kind: z.enum(['ai', 'deterministic']),
      name: z.string().min(1),
      server: z.string().optional(),
      model: z.string().optional(),
      backend: z.string().optional(),
      backendId: z.string().optional(),
    }),
    reviewContext: z.object({ profile: z.string().min(1).max(64), policyHash: digest }).optional(),
    reviewInputBudgets: inputBudgetsSchema.optional(),
    blockIndex: z.number().int().nonnegative(),
    location: fingerprint,
    origin: fingerprint,
    previousReview: z.boolean(),
    issue: z.unknown(),
  })
  .refine(
    (item) => item.engine.kind !== 'ai' || !!item.reviewInputBudgets,
    'AI feedback is missing its original input budgets.',
  )
const recordSchema = z.object({
  documentId: z.string().min(1).max(100),
  documentHash: digest,
  markdownHash: digest,
  serializedHash: digest,
  savedAt: z.number().int().nonnegative(),
  findings: z.array(itemSchema).max(1000),
})
type SavedItem = Omit<z.infer<typeof itemSchema>, 'issue'> & { issue: Issue }
type SavedFeedback = Omit<z.infer<typeof recordSchema>, 'findings'> & { findings: SavedItem[] }

function encodeFingerprint(finding: Omit<Diagnostic, 'reviewOrigin'>, input: Snapshot) {
  return {
    start: finding.start,
    blockHash: finding.blockHash,
    contentHash: finding.contentHash,
    dependencies: Object.entries(finding.dependencies)
      .filter(([key]) => !key.startsWith('$'))
      .flatMap(([id, value]) => {
        const blockIndex = input.blocks.findIndex((block) => block.id === id)
        return blockIndex < 0 ? [] : [{ blockIndex, hash: value }]
      }),
    documentScope: !!finding.dependencies.$document,
    nearby: !!finding.dependencies[`$neighbors:${finding.blockId}`],
  }
}
function neighborHash(input: Snapshot, blockIndex: number) {
  return hash(
    JSON.stringify(
      input.blocks
        .filter((block) => Math.abs(block.order - blockIndex) === 1)
        .map((block) => [block.id, block.hash]),
    ),
  )
}

/** Current feedback on the SAVED draft, separate from exact-current successful reviews.
 *  Persist block indices/validated offsets, never editor ranges or session block IDs.
 *  Previous feedback remains non-applicable; original provenance is never rewritten. */
export class FeedbackSnapshots {
  private entries = new Map<string, SavedFeedback>()

  capture(
    input: Snapshot,
    markdownHash: string,
    serializedHash: string,
    findings: Diagnostic[],
    inputBudgets: InputBudgets = DEFAULT_INPUT_BUDGETS,
  ): boolean {
    if (findings.length > 1000) return false
    const saved: SavedItem[] = []
    for (const finding of findings) {
      const fresh = refreshDiagnostic(finding, input)
      if (!fresh) return false
      const origin = finding.reviewOrigin ?? finding
      const blockIndex = input.blocks.findIndex((block) => block.id === finding.blockId)
      const issue: Issue = {
        block_id: String(blockIndex),
        quote: finding.quote,
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
        explanation: finding.explanation,
        action: finding.action,
        replacement: finding.replacement,
        replacements: finding.replacements,
        guidance: finding.guidance,
        confidence: finding.confidence,
      }
      const validated = validateResult({ issues: [issue] }, 'persisted')
      if (validated.warnings.length || validated.issues.length !== 1) return false
      saved.push({
        id: finding.id,
        analyzerId: finding.analyzerId,
        analyzerVersion: finding.analyzerVersion,
        configurationHash: finding.configurationHash,
        engine: { ...finding.engine },
        reviewContext: finding.reviewContext ? { ...finding.reviewContext } : undefined,
        reviewInputBudgets:
          finding.engine.kind === 'ai'
            ? { ...(finding.reviewInputBudgets ?? inputBudgets) }
            : undefined,
        blockIndex,
        issue: validated.issues[0],
        location: encodeFingerprint({ ...fresh, contentHash: input.hash }, input),
        origin: encodeFingerprint(origin, input),
        previousReview:
          !!finding.stale || !!finding.contextChanged || !refreshDiagnostic(origin, input),
      })
    }
    const record = {
      documentId: input.documentId,
      documentHash: input.hash,
      markdownHash,
      serializedHash,
      savedAt: Date.now(),
      findings: saved,
    }
    const parsed = recordSchema.safeParse(record)
    if (!parsed.success) return false
    const checked: SavedFeedback = {
      ...parsed.data,
      findings: parsed.data.findings.map((item, index) => ({ ...item, issue: saved[index].issue })),
    }
    this.entries.set(input.documentId, checked)
    this.prune()
    return this.entries.get(input.documentId) === checked
  }

  restore(
    input: Snapshot,
    markdownHash: string,
    serializedHash: string,
    analyzers: Analyzer[],
    settings: Settings,
    profile: string,
  ): Diagnostic[] | null {
    const record = this.entries.get(input.documentId)
    if (
      !record ||
      record.documentHash !== input.hash ||
      record.markdownHash !== markdownHash ||
      record.serializedHash !== serializedHash
    )
      return null
    const restored: Diagnostic[] = []
    for (const saved of record.findings) {
      const block = input.blocks[saved.blockIndex]
      const start = saved.location.start
      const end = start + saved.issue.quote.length
      if (
        saved.location.contentHash !== input.hash ||
        !block ||
        block.hash !== saved.location.blockHash ||
        saved.issue.block_id !== String(saved.blockIndex) ||
        block.text.slice(start, end) !== saved.issue.quote
      )
        return null
      const from = block.positions[start],
        to = block.positions[end]
      if (from === undefined || to === undefined || to <= from) return null
      const deps: Diagnostic['dependencies'] = {}
      for (const dependency of saved.location.dependencies) {
        const context = input.blocks[dependency.blockIndex]
        if (!context || context.hash !== dependency.hash) return null
        deps[context.id] = dependency.hash
      }
      if (saved.location.documentScope) deps.$document = input.hash
      if (saved.location.nearby) deps[`$neighbors:${block.id}`] = neighborHash(input, block.order)
      const mapped = resolveIssue(
        {
          ...saved.issue,
          block_id: block.id,
          offset: saved.engine.kind === 'deterministic' ? start : undefined,
        },
        { ...input, selection: { from, to } },
        saved.analyzerId,
        saved.analyzerVersion,
        { ...saved.engine },
        saved.configurationHash,
        deps,
        saved.reviewContext,
      )
      if (!mapped || mapped.start !== start || mapped.end !== end) return null
      const finding: Diagnostic = {
        ...mapped,
        id: saved.id,
        reviewInputBudgets: saved.reviewInputBudgets,
        stale: saved.previousReview,
        contextChanged: saved.previousReview,
      }
      // Previous feedback has an old context fingerprint. Across sessions we
      // conservatively require the entire original document to match to clear it.
      // Fresh feedback can safely rebind its unchanged dependency neighborhood.
      const originDeps: Diagnostic['dependencies'] = {}
      if (saved.previousReview) originDeps.$document = saved.origin.contentHash
      else {
        for (const dependency of saved.origin.dependencies) {
          const context = input.blocks[dependency.blockIndex]
          if (!context || context.hash !== dependency.hash) return null
          originDeps[context.id] = dependency.hash
        }
        if (saved.origin.documentScope) originDeps.$document = saved.origin.contentHash
        if (saved.origin.nearby)
          originDeps[`$neighbors:${block.id}`] = neighborHash(input, block.order)
      }
      finding.reviewOrigin = {
        ...finding,
        start: saved.origin.start,
        end: saved.origin.start + saved.issue.quote.length,
        blockHash: saved.origin.blockHash,
        contentHash: saved.origin.contentHash,
        dependencies: originDeps,
        stale: false,
        contextChanged: false,
      }
      if (!refreshDiagnostic(finding, input)) return null
      if (!refreshDiagnostic(finding.reviewOrigin, input)) {
        finding.stale = true
        finding.contextChanged = true
      }
      restored.push(finding)
    }
    return reconcileReviewContexts(restored, analyzers, settings, profile, input)
  }

  has(documentId: string) {
    return this.entries.has(documentId)
  }
  delete(documentId: string) {
    this.entries.delete(documentId)
  }
  clear() {
    this.entries.clear()
  }
  export(): unknown {
    return { version: 1, documents: [...this.entries.values()] }
  }
  import(raw: unknown) {
    const parsed = z
      .object({ version: z.literal(1), documents: z.array(recordSchema).max(50) })
      .safeParse(raw)
    if (!parsed.success)
      throw new Error('Saved feedback is incompatible or corrupt; it will not be restored.')
    const imported = new Map<string, SavedFeedback>()
    for (const record of parsed.data.documents) {
      const findings: SavedItem[] = []
      for (const saved of record.findings) {
        const validated = validateResult({ issues: [saved.issue] }, 'persisted')
        if (validated.warnings.length || validated.issues.length !== 1)
          throw new Error('Saved feedback contains an invalid finding.')
        findings.push({ ...saved, issue: validated.issues[0] })
      }
      imported.set(record.documentId, { ...record, findings })
    }
    for (const [documentId, record] of imported) this.entries.set(documentId, record)
    this.prune()
  }
  private prune() {
    while (
      this.entries.size > 50 ||
      new TextEncoder().encode(JSON.stringify([...this.entries.values()])).byteLength > 500_000
    ) {
      const oldest = [...this.entries].sort(([, a], [, b]) => a.savedAt - b.savedAt)[0]?.[0]
      if (!oldest) break
      this.entries.delete(oldest)
    }
  }
}
