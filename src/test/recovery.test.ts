import { describe, expect, it } from 'vitest'
import { hash } from '../diagnostics/hash'
import {
  RECOVERY_CHECKPOINT_MAX_INTERVAL_MS,
  RECOVERY_DOCUMENT_COUNT,
  RECOVERY_DOCUMENT_LIMIT,
  pruneRecoveryRecords,
  recoveryCheckpointDue,
  recoveryDecision,
  recoveryKey,
  recoveryLabel,
  validRecoveryRecord,
  type RecoveryRecord,
} from '../documents/recovery'

const record = (overrides: Partial<RecoveryRecord> = {}): RecoveryRecord => {
  const text = overrides.text ?? 'Unsaved paragraph.\n'
  return {
    key: recoveryKey('/writing', 'essay.md'),
    projectRoot: '/writing',
    documentPath: 'essay.md',
    documentId: 'document-1',
    text,
    textHash: hash(text),
    diskHash: hash('file as it was on disk'),
    capturedAt: 1_000,
    ...overrides,
  }
}

describe('crash recovery records', () => {
  it('keys bind a snapshot to one project and one document path', () => {
    expect(recoveryKey('/writing', 'essay.md')).toBe(recoveryKey('/writing', 'essay.md'))
    expect(recoveryKey('/writing', 'essay.md')).not.toBe(recoveryKey('/writing', 'notes.md'))
    expect(recoveryKey('/writing', 'essay.md')).not.toBe(recoveryKey('/other', 'essay.md'))
    expect(recoveryKey('/a', 'b.md')).not.toBe(recoveryKey('/a\u0000b', '.md'))
  })

  it('accepts a self-consistent snapshot and rejects a forged or oversized one', () => {
    expect(validRecoveryRecord(record())).toBe(true)
    expect(validRecoveryRecord(record({ textHash: hash('something else') }))).toBe(false)
    expect(validRecoveryRecord(record({ diskHash: 'not-a-hash' }))).toBe(false)
    expect(validRecoveryRecord(record({ key: hash('/writing') }))).toBe(false)
    expect(validRecoveryRecord(record({ capturedAt: 0 }))).toBe(false)
    expect(validRecoveryRecord(record({ text: 'x'.repeat(RECOVERY_DOCUMENT_LIMIT + 1) }))).toBe(
      false,
    )
    expect(validRecoveryRecord(record({ documentPath: '../escape.md' }))).toBe(false)
    expect(validRecoveryRecord(record({ documentPath: '' }))).toBe(false)
    expect(validRecoveryRecord(record({ projectRoot: '' }))).toBe(false)
  })

  it('keeps the newest snapshots and caps both count and stored bytes', () => {
    const many = Array.from({ length: RECOVERY_DOCUMENT_COUNT + 6 }, (_, index) =>
      record({
        documentPath: `draft-${index}.md`,
        key: recoveryKey('/writing', `draft-${index}.md`),
        capturedAt: 1_000 + index,
      }),
    )
    const kept = pruneRecoveryRecords(many)
    expect(kept).toHaveLength(RECOVERY_DOCUMENT_COUNT)
    expect(kept[0].documentPath).toBe(`draft-${many.length - 1}.md`)
    expect(kept.at(-1)!.documentPath).toBe('draft-6.md')
    const huge = Array.from({ length: RECOVERY_DOCUMENT_COUNT }, (_, index) =>
      record({
        documentPath: `big-${index}.md`,
        key: recoveryKey('/writing', `big-${index}.md`),
        text: 'x'.repeat(180_000),
        textHash: hash('x'.repeat(180_000)),
        capturedAt: 1_000 + index,
      }),
    )
    const capped = pruneRecoveryRecords(huge)
    expect(capped.length).toBeLessThan(RECOVERY_DOCUMENT_COUNT)
    expect(capped[0].documentPath).toBe(`big-${RECOVERY_DOCUMENT_COUNT - 1}.md`)
  })

  it('drops a snapshot that already matches the file and offers one that differs', () => {
    const saved = 'Paragraph as saved.\n'
    expect(recoveryDecision(record({ text: saved, textHash: hash(saved) }), hash(saved))).toBe(
      'superseded',
    )
    expect(recoveryDecision(record(), hash('Paragraph as saved.\n'))).toBe('restore')
  })

  it('debounces typing yet never lets continuous typing postpone a checkpoint', () => {
    const last = 100_000
    // First change after a document opens: batch it.
    expect(recoveryCheckpointDue(last + 10, last, null)).toBe('schedule')
    // More changes while one checkpoint is pending: do not stack writes.
    expect(recoveryCheckpointDue(last + 20, last, last + 10)).toBe('waiting')
    // Continuous typing past the maximum interval forces a checkpoint immediately.
    expect(recoveryCheckpointDue(last + RECOVERY_CHECKPOINT_MAX_INTERVAL_MS, last, null)).toBe(
      'immediate',
    )
    expect(
      recoveryCheckpointDue(last + RECOVERY_CHECKPOINT_MAX_INTERVAL_MS, last, last + 1_000),
    ).toBe('immediate')
    expect(recoveryCheckpointDue(last + 1_000, last, null)).toBe('schedule')
  })

  it('describes how old a snapshot is in plain language', () => {
    const now = 1_000_000_000
    expect(recoveryLabel(record({ capturedAt: now }), now)).toBe('less than a minute ago')
    expect(recoveryLabel(record({ capturedAt: now - 60_000 }), now)).toBe('about a minute ago')
    expect(recoveryLabel(record({ capturedAt: now - 12 * 60_000 }), now)).toBe(
      'about 12 minutes ago',
    )
    expect(recoveryLabel(record({ capturedAt: now - 3 * 3_600_000 }), now)).toBe(
      'about 3 hours ago',
    )
    expect(recoveryLabel(record({ capturedAt: now - 2 * 86_400_000 }), now)).toBe(
      'about 2 days ago',
    )
  })
})
