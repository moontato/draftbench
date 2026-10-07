import { z } from 'zod'
import type { Analyzer } from './types'
import type { Scope } from '../diagnostics/types'
import { canonical, hash } from '../diagnostics/hash'
import { effectiveConfig, type Settings } from '../settings/model'
import type { ProfileId } from '../profiles/profiles'
import type { SavedReviewSummary } from './savedReviews'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative()
const timestamp = count.max(8_640_000_000_000_000)
const reviewerSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  engine: z.enum(['ai', 'deterministic', 'unknown']),
  server: z.string().max(2000).optional(),
  model: z.string().max(500).optional(),
  configurationHash: digest,
  options: z
    .object({ timeoutMs: count, maxTokens: count, temperature: z.number().min(0).max(2) })
    .optional(),
  status: z.enum([
    'pending',
    'running',
    'completed',
    'warnings',
    'failed',
    'cancelled',
    'interrupted',
    'skipped',
    'stale',
    'saved',
  ]),
  findings: count,
  cacheHits: count,
  requests: count,
  warnings: count,
  discarded: count,
})
const runSchema = z.object({
  id: z.string().min(1).max(100),
  documentId: z.string().min(1).max(100),
  documentHash: digest,
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  scope: z.enum(['selection', 'block', 'document']),
  profile: z.enum(['general', 'technical', 'essay', 'email']),
  force: z.boolean().nullable(),
  origin: z.enum(['manual', 'saved-review']).default('manual'),
  status: z.enum(['running', 'completed', 'warnings', 'cancelled', 'interrupted', 'saved']),
  reviewers: z.array(reviewerSchema).min(1).max(50),
})
export type HistoryReviewer = z.infer<typeof reviewerSchema>
export type AnalysisRun = z.infer<typeof runSchema>

// Endpoint labels must never persist embedded credentials, query strings, or fragments.
function safeServer(server: string): string | undefined {
  try {
    const url = new URL(server)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

// Metadata-only manual-run log. It is not a cache or a way to replay old findings.
export class AnalysisHistory {
  private runs: AnalysisRun[] = []
  start(
    documentId: string,
    documentHash: string,
    scope: Scope,
    profile: ProfileId,
    force: boolean,
    analyzers: Analyzer[],
    settings: Settings,
  ): string {
    const record: AnalysisRun = {
      id: crypto.randomUUID(),
      documentId,
      documentHash,
      scope,
      profile,
      force,
      origin: 'manual',
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      reviewers: analyzers.map((analyzer) => {
        const config = effectiveConfig(settings, analyzer.id)
        return {
          id: analyzer.id,
          name: analyzer.name,
          version: analyzer.version,
          engine: analyzer.engine,
          ...(analyzer.engine === 'ai'
            ? {
                server: safeServer(config.serverUrl),
                model: config.model,
                options: {
                  timeoutMs: config.timeoutMs,
                  maxTokens: config.maxTokens,
                  temperature: config.temperature,
                },
              }
            : {}),
          configurationHash: hash(canonical(config)),
          status: 'pending',
          findings: 0,
          cacheHits: 0,
          requests: 0,
          warnings: 0,
          discarded: 0,
        }
      }),
    }
    const parsed = runSchema.safeParse(record)
    if (!parsed.success) throw new Error('Analysis history could not record this configuration.')
    this.runs.unshift(parsed.data)
    this.prune()
    return record.id
  }
  update(
    id: string,
    reviewerId: string,
    result: Partial<
      Pick<
        HistoryReviewer,
        'status' | 'findings' | 'cacheHits' | 'requests' | 'warnings' | 'discarded'
      >
    >,
  ) {
    const record = this.runs.find((r) => r.id === id)
    if (!record || record.status !== 'running') return
    const reviewer = record.reviewers.find((r) => r.id === reviewerId)
    if (reviewer) Object.assign(reviewer, result)
  }
  finish(id: string, cancelled = false) {
    const record = this.runs.find((r) => r.id === id)
    if (!record || record.status !== 'running') return
    record.finishedAt = Date.now()
    for (const reviewer of record.reviewers) {
      if (reviewer.status === 'pending') reviewer.status = 'skipped'
      else if (reviewer.status === 'running') reviewer.status = cancelled ? 'cancelled' : 'failed'
    }
    record.status = cancelled
      ? 'cancelled'
      : record.reviewers.some((r) => ['warnings', 'failed', 'stale', 'skipped'].includes(r.status))
        ? 'warnings'
        : 'completed'
    this.prune()
  }
  recoverSavedReviews(reviews: SavedReviewSummary[], analyzers: Analyzer[]): boolean {
    let changed = false
    for (const review of reviews) {
      // Do not create a second entry for a document already covered by a run log.
      if (this.runs.some((r) => r.documentId === review.documentId)) continue
      const record: AnalysisRun = {
        id: `saved:${hash(canonical([review.documentId, review.analyzedAt, review.serializedHash]))}`,
        documentId: review.documentId,
        documentHash: review.serializedHash,
        startedAt: review.analyzedAt,
        finishedAt: null,
        scope: review.scope,
        profile: review.profile,
        force: null,
        origin: 'saved-review',
        status: 'saved',
        reviewers: review.sources.map((source) => {
          const analyzer = analyzers.find((a) => a.id === source.id)
          return {
            id: source.id,
            name: analyzer?.name ?? source.id,
            version: source.version,
            engine: analyzer?.version === source.version ? analyzer.engine : 'unknown',
            configurationHash: source.configurationHash,
            status: 'saved',
            findings: source.findings,
            cacheHits: 0,
            requests: 0,
            warnings: 0,
            discarded: 0,
          }
        }),
      }
      const parsed = runSchema.safeParse(record)
      if (!parsed.success) continue
      this.runs.push(parsed.data)
      changed = true
    }
    if (changed) {
      this.runs.sort((a, b) => b.startedAt - a.startedAt)
      this.prune()
    }
    return changed
  }
  forDocument(documentId: string): AnalysisRun[] {
    return this.runs.filter((r) => r.documentId === documentId)
  }
  delete(documentId: string) {
    this.runs = this.runs.filter((r) => r.documentId !== documentId)
  }
  clear() {
    this.runs = []
  }
  export(): unknown {
    return { version: 1, runs: this.runs }
  }
  import(raw: unknown) {
    const envelope = z
      .object({ version: z.literal(1), runs: z.array(z.unknown()).max(300) })
      .safeParse(raw)
    if (!envelope.success)
      throw new Error('Analysis history is incompatible or corrupt; it will not be shown.')
    const records: AnalysisRun[] = []
    const ids = new Set<string>()
    for (const item of envelope.data.runs) {
      const parsed = runSchema.safeParse(item)
      if (!parsed.success || ids.has(parsed.data.id)) continue
      const record = parsed.data
      ids.add(record.id)
      // Apply the same sanitization to sidecars, not just newly created entries.
      for (const reviewer of record.reviewers)
        if (reviewer.server) reviewer.server = safeServer(reviewer.server)
      if (record.status === 'running') {
        record.status = 'interrupted'
        record.finishedAt = null // The time of interruption is unknown.
        for (const reviewer of record.reviewers) {
          if (reviewer.status === 'pending') reviewer.status = 'skipped'
          else if (reviewer.status === 'running') reviewer.status = 'interrupted'
        }
      }
      records.push(record)
    }
    this.runs = records.sort((a, b) => b.startedAt - a.startedAt)
    this.prune()
  }
  private prune() {
    const counts = new Map<string, number>()
    this.runs = this.runs
      .filter((r) => {
        const total = (counts.get(r.documentId) ?? 0) + 1
        counts.set(r.documentId, total)
        return total <= 50
      })
      .slice(0, 300)
    while (new TextEncoder().encode(JSON.stringify(this.runs)).byteLength > 500_000) this.runs.pop()
  }
}
