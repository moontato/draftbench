import { describe, expect, it } from 'vitest'
import { AnalysisHistory } from '../analyzers/history'
import { analyzers } from '../analyzers/registry'
import { defaultSettings } from '../settings/model'
import { hash } from '../diagnostics/hash'
import type { SavedReviewSummary } from '../analyzers/savedReviews'

const settings = defaultSettings()
const clarity = analyzers.find((a) => a.id === 'clarity')!
const local = analyzers.find((a) => a.id === 'repeated-word')!
const start = (store: AnalysisHistory, documentId = 'doc') =>
  store.start(
    documentId,
    hash('Markdown'),
    'document',
    'general',
    false,
    [clarity, local],
    settings,
  )

describe('document analysis history', () => {
  const saved: SavedReviewSummary = {
    documentId: 'legacy-doc',
    serializedHash: hash('old content'),
    analyzedAt: 1700000000000,
    profile: 'general',
    scope: 'document',
    sources: [
      {
        id: clarity.id,
        version: clarity.version,
        configurationHash: hash('old config'),
        findings: 3,
      },
    ],
  }
  it('recovers a missing legacy log from a saved review without inventing requests or model provenance', () => {
    const store = new AnalysisHistory()
    expect(store.recoverSavedReviews([saved], analyzers)).toBe(true)
    const recovered = store.forDocument('legacy-doc')[0]
    expect(recovered).toMatchObject({
      origin: 'saved-review',
      status: 'saved',
      startedAt: saved.analyzedAt,
      finishedAt: null,
      force: null,
    })
    expect(recovered.reviewers[0]).toMatchObject({ id: clarity.id, findings: 3, status: 'saved' })
    expect(recovered.reviewers[0].model).toBeUndefined()
    expect(recovered.reviewers[0].server).toBeUndefined()
    expect(recovered.reviewers[0].options).toBeUndefined()
    expect(store.recoverSavedReviews([saved], analyzers)).toBe(false)
    const reopened = new AnalysisHistory()
    reopened.import(store.export())
    expect(reopened.forDocument('legacy-doc')[0].origin).toBe('saved-review')
    expect(reopened.recoverSavedReviews([saved], analyzers)).toBe(false)
  })
  it('does not duplicate documents with a real log and retains zero-finding legacy reviews', () => {
    const store = new AnalysisHistory()
    start(store, 'legacy-doc')
    expect(store.recoverSavedReviews([saved], analyzers)).toBe(false)
    store.clear()
    expect(
      store.recoverSavedReviews(
        [{ ...saved, sources: saved.sources.map((s) => ({ ...s, findings: 0 })) }],
        analyzers,
      ),
    ).toBe(true)
    expect(store.forDocument('legacy-doc')[0].reviewers[0].findings).toBe(0)
  })
  it('does not guess the engine of an unavailable/version-changed historical reviewer', () => {
    const store = new AnalysisHistory()
    store.recoverSavedReviews(
      [{ ...saved, sources: [{ ...saved.sources[0], version: 'unavailable-version' }] }],
      analyzers,
    )
    expect(store.forDocument('legacy-doc')[0].reviewers[0].engine).toBe('unknown')
  })
  it('records metadata-only manual runs with resolved per-analyzer models and options', () => {
    const store = new AnalysisHistory()
    store.start('doc', hash('Markdown'), 'selection', 'essay', true, [clarity, local], {
      ...settings,
      analyzers: { ...settings.analyzers, clarity: { enabled: true, model: 'reviewer-14b' } },
    })
    const run = store.forDocument('doc')[0]
    expect(run.scope).toBe('selection')
    expect(run.profile).toBe('essay')
    expect(run.force).toBe(true)
    expect(run.reviewers[0].model).toBe('reviewer-14b')
    expect(run.reviewers[0].options?.maxTokens).toBe(2048)
    expect(run.reviewers[1].model).toBeUndefined()
    expect(JSON.stringify(store.export())).not.toContain('Markdown')
  })
  it('records zero findings and cache hits without claiming a new inference request', () => {
    const store = new AnalysisHistory(),
      id = start(store)
    store.update(id, clarity.id, { status: 'completed', findings: 0, cacheHits: 3, requests: 0 })
    store.update(id, local.id, { status: 'completed', findings: 1, requests: 3 })
    store.finish(id)
    const run = store.forDocument('doc')[0]
    expect(run.status).toBe('completed')
    expect(run.finishedAt).not.toBeNull()
    expect(run.reviewers[0]).toMatchObject({ findings: 0, cacheHits: 3, requests: 0 })
  })
  it('keeps failures/warnings/stale outcomes separate from success and stops late updates', () => {
    const store = new AnalysisHistory(),
      id = start(store)
    store.update(id, clarity.id, { status: 'failed' })
    store.update(id, local.id, { status: 'warnings', warnings: 2 })
    store.finish(id)
    expect(store.forDocument('doc')[0].status).toBe('warnings')
    store.update(id, clarity.id, { status: 'completed', findings: 99 })
    expect(store.forDocument('doc')[0].reviewers[0].status).toBe('failed')
    const next = start(store)
    store.update(next, clarity.id, { status: 'stale', discarded: 1 })
    store.finish(next)
    expect(store.forDocument('doc')[0].reviewers[0].discarded).toBe(1)
  })
  it('records cancellation with the active reviewer cancelled and untouched reviewers not run', () => {
    const store = new AnalysisHistory(),
      id = start(store)
    store.update(id, clarity.id, { status: 'running' })
    store.finish(id, true)
    const run = store.forDocument('doc')[0]
    expect(run.status).toBe('cancelled')
    expect(run.reviewers.map((r) => r.status)).toEqual(['cancelled', 'skipped'])
    store.finish(id)
    expect(run.status).toBe('cancelled')
  })
  it('round-trips completed runs and marks unfinished persisted runs interrupted', () => {
    const store = new AnalysisHistory(),
      id = start(store)
    store.update(id, clarity.id, { status: 'completed' })
    store.update(id, local.id, { status: 'completed' })
    store.finish(id)
    const running = start(store)
    store.update(running, clarity.id, { status: 'running' })
    const imported = new AnalysisHistory()
    imported.import(JSON.parse(JSON.stringify(store.export())))
    expect(imported.forDocument('doc').map((r) => r.status)).toEqual(['interrupted', 'completed'])
    expect(imported.forDocument('doc')[0].finishedAt).toBeNull()
    expect(imported.forDocument('doc')[0].reviewers[0].status).toBe('interrupted')
  })
  it('sanitizes endpoint credentials/query/fragment on recording and import', () => {
    const store = new AnalysisHistory()
    store.start('doc', hash('Markdown'), 'block', 'general', false, [clarity], {
      ...settings,
      ai: {
        ...settings.ai,
        serverUrl: 'http://user:secret@localhost:8080/v1?api_key=private#private',
      },
    })
    expect(store.forDocument('doc')[0].reviewers[0].server).toBe('http://localhost:8080/v1')
    const encoded = JSON.stringify(store.export())
    expect(encoded).not.toContain('secret')
    expect(encoded).not.toContain('private')
    const raw = JSON.parse(encoded)
    raw.runs[0].reviewers[0].server = 'http://user:secret@localhost:8080?key=private'
    const imported = new AnalysisHistory()
    imported.import(raw)
    expect(JSON.stringify(imported.export())).not.toContain('secret')
  })
  it('keeps document IDs isolated, newest runs first, and deletes/clears explicitly', () => {
    const store = new AnalysisHistory(),
      first = start(store),
      second = start(store)
    start(store, 'other')
    expect(store.forDocument('doc').map((r) => r.id)).toEqual([second, first])
    store.delete('doc')
    expect(store.forDocument('doc')).toEqual([])
    expect(store.forDocument('other')).toHaveLength(1)
    store.clear()
    expect(store.forDocument('other')).toEqual([])
  })
  it('bounds entries per document and per project and skips malformed/duplicate runs', () => {
    const store = new AnalysisHistory()
    for (let i = 0; i < 51; i++) start(store)
    expect(store.forDocument('doc')).toHaveLength(50)
    for (let i = 0; i < 301; i++) start(store, `doc-${i}`)
    expect((store.export() as { runs: unknown[] }).runs.length).toBeLessThanOrEqual(300)
    const raw = JSON.parse(JSON.stringify(store.export()))
    raw.runs = [raw.runs[0], raw.runs[0], { invalid: true }]
    const imported = new AnalysisHistory()
    imported.import(raw)
    expect((imported.export() as { runs: unknown[] }).runs).toHaveLength(1)
    expect(() => imported.import({ version: 3, runs: [] })).toThrow('corrupt')
  })
})
