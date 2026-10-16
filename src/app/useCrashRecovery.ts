import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { hash } from '../diagnostics/hash'
import { writeMarkdown } from '../documents/markdown'
import {
  RECOVERY_CHECKPOINT_DEBOUNCE_MS,
  RECOVERY_DOCUMENT_LIMIT,
  recoveryCheckpointDue,
  recoveryKey,
  validRecoveryRecord,
  type RecoveryRecord,
} from '../documents/recovery'
import { desktopAvailable, errorMessage, storage, type Project } from '../storage/desktop'
import type { Holder } from './useFindingsView'
import type { Session } from './workspaceTypes'
export interface RecoveryDeps {
  project: Project | null
  sessionRef: Holder<Session | null>
  editorRef: Holder<Editor | null>
  dirtyRef: Holder<boolean>
  fileLock: Holder<boolean>
  saveLock: Holder<boolean>
  showNotice: (message: string, error?: boolean) => void
}
/**
 * Crash recovery for unsaved writing.
 *
 * Checkpoints are debounced so continuous typing does not hammer the disk, but they are
 * also capped by a maximum interval so an author who never pauses still gets a snapshot.
 * Recovery never writes to the author's Markdown file: it stores the draft in Draftbench's
 * own storage, and restoring loads it into the editor as an ordinary unsaved edit whose
 * Save conflicts if the file changed elsewhere.
 */
export function useCrashRecovery(deps: RecoveryDeps) {
  const { project, sessionRef, editorRef, dirtyRef, fileLock, saveLock, showNotice } = deps
  const [pendingRecovery, setPendingRecovery] = useState<RecoveryRecord | null>(null)
  const projectRef = useRef<Project | null>(project)
  const lastCheckpointAt = useRef(0)
  const timer = useRef<number | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const storageWarned = useRef(false)
  const stopped = useRef(false)
  projectRef.current = project
  // Recovery storage is native-only; the browser preview has no private app storage.
  const usable = desktopAvailable
  const enqueue = (work: () => Promise<unknown>) => {
    queue.current = queue.current
      .then(async () => {
        await work()
      })
      .catch((error) => {
        if (!storageWarned.current) {
          storageWarned.current = true
          showNotice(
            `Crash recovery storage is unavailable: ${errorMessage(error)} Your draft in the editor is unaffected.`,
            true,
          )
        }
      })
    return queue.current
  }
  const cancelCheckpoint = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  const checkpoint = () => {
    if (!usable || stopped.current) return
    const active = sessionRef.current,
      editor = editorRef.current
    if (!active || !editor || editor.isDestroyed) return
    if (!dirtyRef.current || fileLock.current || saveLock.current) return
    if (active.source.unsupported.length) return
    const root = projectRef.current?.root
    if (!root) return
    const text = writeMarkdown(active.source, editor.getMarkdown())
    lastCheckpointAt.current = Date.now()
    if (text.length > RECOVERY_DOCUMENT_LIMIT) {
      if (!storageWarned.current) {
        storageWarned.current = true
        showNotice(
          'This draft is too large for crash-recovery checkpoints. Save it to keep your writing.',
          true,
        )
      }
      return
    }
    const record: RecoveryRecord = {
      key: recoveryKey(root, active.path),
      projectRoot: root,
      documentPath: active.path,
      documentId: active.id,
      text,
      textHash: hash(text),
      // The file as it was when this snapshot was taken: restoring keeps this reference so
      // a later Save conflicts rather than overwriting a file that changed elsewhere.
      diskHash: active.diskHash,
      capturedAt: Date.now(),
    }
    void enqueue(() => storage.recoveryWrite(record).then(() => (storageWarned.current = false)))
  }
  const scheduleCheckpoint = () => {
    if (!usable) return
    const decision = recoveryCheckpointDue(Date.now(), lastCheckpointAt.current, timer.current)
    if (decision === 'immediate') {
      cancelCheckpoint()
      checkpoint()
      return
    }
    if (decision === 'waiting') return
    timer.current = window.setTimeout(() => {
      timer.current = null
      checkpoint()
    }, RECOVERY_CHECKPOINT_DEBOUNCE_MS)
  }
  /** Called when a document is opened: the interval restarts and stale timers are dropped. */
  const noteOpened = () => {
    cancelCheckpoint()
    lastCheckpointAt.current = Date.now()
  }
  const clearRecovery = (key?: string) => {
    if (!usable) return
    cancelCheckpoint()
    void enqueue(() => storage.recoveryClear(key))
  }
  const discardRecovery = () => {
    const record = pendingRecovery
    setPendingRecovery(null)
    if (record) clearRecovery(record.key)
  }
  /** Hide the prompt without throwing the snapshot away: it is offered again next time. */
  const dismissRecovery = () => setPendingRecovery(null)
  const lookupRecovery = async (
    root: string,
    documentPath: string,
  ): Promise<RecoveryRecord | null> => {
    if (!usable) return null
    try {
      const file = await storage.recoveryLoad()
      const key = recoveryKey(root, documentPath)
      const record = file.records.find((item) => item.key === key)
      if (!record) return null
      if (!validRecoveryRecord(record)) {
        void enqueue(() => storage.recoveryClear(key))
        return null
      }
      return record
    } catch {
      return null
    }
  }
  const armRecovery = (record: RecoveryRecord) => {
    setPendingRecovery(record)
  }
  const clearFor = (documentPath: string) => {
    const root = projectRef.current?.root
    if (!root) return
    clearRecovery(recoveryKey(root, documentPath))
  }
  /** A deleted folder takes its documents' snapshots with it. */
  const clearSubtree = (folderPath: string) => {
    const root = projectRef.current?.root
    if (!usable || !root) return
    void enqueue(async () => {
      const prefix = folderPath.replace(/[\\/]+$/, '') + '/'
      const file = await storage.recoveryLoad()
      for (const record of file.records)
        if (record.projectRoot === root && record.documentPath.startsWith(prefix))
          await storage.recoveryClear(record.key)
    })
  }
  /** Renaming a document keeps its snapshot attached to the new path. */
  const renameRecovery = async (oldPath: string, newPath: string) => {
    const root = projectRef.current?.root
    if (!usable || !root) return
    const record = await lookupRecovery(root, oldPath)
    if (!record) return
    await enqueue(async () => {
      await storage.recoveryClear(recoveryKey(root, oldPath))
      await storage.recoveryWrite({
        ...record,
        key: recoveryKey(root, newPath),
        documentPath: newPath,
      })
    })
  }
  const clearCurrent = () => {
    const active = sessionRef.current
    if (active) clearFor(active.path)
  }
  useEffect(
    () => () => {
      stopped.current = true
      cancelCheckpoint()
    },
    [],
  )
  return {
    pendingRecovery,
    armRecovery,
    cancelCheckpoint,
    checkpoint,
    clearCurrent,
    clearFor,
    clearRecovery,
    clearSubtree,
    discardRecovery,
    dismissRecovery,
    lookupRecovery,
    noteOpened,
    renameRecovery,
    scheduleCheckpoint,
  }
}
