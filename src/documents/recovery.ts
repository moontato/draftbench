import { hash } from '../diagnostics/hash'

/**
 * Crash recovery for unsaved writing.
 *
 * Records live in Draftbench's own application storage (never inside the author's Markdown
 * project) and are keyed by project + document path. A record keeps the hash of the file as
 * it was on disk when the snapshot was captured, so restoring can never overwrite a file
 * that changed somewhere else: the Save that follows reports a conflict instead.
 */
export interface RecoveryRecord {
  key: string
  projectRoot: string
  documentPath: string
  documentId: string
  text: string
  textHash: string
  diskHash: string
  capturedAt: number
}

export const RECOVERY_DOCUMENT_COUNT = 20
export const RECOVERY_DOCUMENT_LIMIT = 1024 * 1024
export const RECOVERY_FILE_LIMIT = 2 * 1024 * 1024
/** Typing pauses are batched… */
export const RECOVERY_CHECKPOINT_DEBOUNCE_MS = 3_000
/** …but continuous typing still checkpoints at least this often. */
export const RECOVERY_CHECKPOINT_MAX_INTERVAL_MS = 30_000

const HEX = /^[a-f0-9]{64}$/

export function recoveryKey(projectRoot: string, documentPath: string): string {
  return hash(`${projectRoot}\u0000${documentPath}`)
}

export function validRecoveryRecord(record: RecoveryRecord): boolean {
  return (
    typeof record === 'object' &&
    HEX.test(record.key) &&
    HEX.test(record.textHash) &&
    HEX.test(record.diskHash) &&
    Number.isFinite(record.capturedAt) &&
    record.capturedAt > 0 &&
    typeof record.text === 'string' &&
    record.text.length <= RECOVERY_DOCUMENT_LIMIT &&
    hash(record.text) === record.textHash &&
    typeof record.projectRoot === 'string' &&
    record.projectRoot.length > 0 &&
    typeof record.documentPath === 'string' &&
    record.documentPath.length > 0 &&
    !record.documentPath.split(/[\\/]/).some((part) => part === '..' || part === '.') &&
    // The key must be derived from the record's own location, never invented separately.
    record.key === recoveryKey(record.projectRoot, record.documentPath)
  )
}

/** Newest first, capped by document count and by total stored bytes. */
export function pruneRecoveryRecords(records: RecoveryRecord[]): RecoveryRecord[] {
  const sorted = [...records].sort((a, b) => b.capturedAt - a.capturedAt)
  let kept = sorted.slice(0, RECOVERY_DOCUMENT_COUNT)
  const size = (items: RecoveryRecord[]) =>
    items.reduce((total, record) => total + record.text.length + 512, 0)
  while (kept.length > 1 && size(kept) > RECOVERY_FILE_LIMIT) kept = kept.slice(0, -1)
  return kept
}

/**
 * What to do with a stored snapshot when its document is opened.
 *
 * superseded — the file on disk already holds exactly the recovered text, so nothing is at
 * stake and the snapshot can be dropped.
 * restore — the recovered text differs from the file, so the author decides.
 */
export function recoveryDecision(
  record: RecoveryRecord,
  diskHash: string,
): 'superseded' | 'restore' {
  return record.textHash === diskHash ? 'superseded' : 'restore'
}

export function recoveryCheckpointDue(
  now: number,
  lastCheckpointAt: number,
  scheduledAt: number | null,
): 'immediate' | 'schedule' | 'waiting' {
  if (now - lastCheckpointAt >= RECOVERY_CHECKPOINT_MAX_INTERVAL_MS) return 'immediate'
  if (scheduledAt !== null) return 'waiting'
  return 'schedule'
}

export function recoveryLabel(record: RecoveryRecord, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - record.capturedAt) / 60_000))
  if (minutes < 1) return 'less than a minute ago'
  if (minutes === 1) return 'about a minute ago'
  if (minutes < 60) return `about ${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `about ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `about ${days} day${days === 1 ? '' : 's'} ago`
}
