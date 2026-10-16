import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { createAnalyzerRegistry } from '../analyzers/registry'
import type { Analyzer } from '../analyzers/types'
import {
  captureRevisionReference,
  canResumeRevisionReference,
  mapRevisionReference,
  referenceState,
  type RevisionReference,
} from '../diagnostics/revisionReference'
import type { Diagnostic, Scope, Snapshot } from '../diagnostics/types'
import { snapshot } from '../editor/blocks'
import { configurationHash, effectiveConfig, type Settings } from '../settings/model'
import { globallyEnabled } from '../profiles/profiles'
import type { Holder } from './useFindingsView'
import type { ProjectMeta, Session } from './workspaceTypes'
export interface RevisionDeps {
  sessionRef: Holder<Session | null>
  editorRef: Holder<Editor | null>
  meta: Holder<ProjectMeta>
  revision: Holder<number>
  findingsRef: Holder<Diagnostic[]>
  settingsRef: Holder<Settings>
  fileLock: Holder<boolean>
  saveLock: Holder<boolean>
  /** Live state, because the pane describes what the author sees in this render. */
  current: Snapshot | null
  findings: Diagnostic[]
  selected: string | null
  dismissed: Set<string>
  settings: Settings
  analyzers: Analyzer[]
  profile: string
  busy: boolean
  fileBusy: boolean
  saving: boolean
  enabled: (id: string) => boolean
  run: (
    scope?: Scope,
    analyzerIds?: string | readonly string[],
    force?: boolean,
  ) => Promise<Diagnostic[] | undefined>
  accept: (finding: Diagnostic) => void
  setSelected: (id: string | null) => void
  setRightOpen: (open: boolean) => void
  showNotice: (message: string, error?: boolean) => void
}
/**
 * Revision mode: one captured passage-and-feedback reference beside the live draft.
 *
 * The capture is separate from the pane's visibility. Closing the pane hides the capture
 * and keeps mapping it through editor transactions; only explicit actions (Revise, Choose
 * another finding, Re-review) may change its review baseline, and a re-review that finishes
 * after the pane was closed or resumed can never publish into it.
 */
export function useRevisionMode(deps: RevisionDeps) {
  const {
    sessionRef,
    editorRef,
    meta,
    revision,
    findingsRef,
    settingsRef,
    fileLock,
    saveLock,
    current,
    findings,
    selected,
    dismissed,
    settings,
    analyzers,
    profile,
    busy,
    fileBusy,
    saving,
    enabled,
    run,
    accept,
    setSelected,
    setRightOpen,
    showNotice,
  } = deps
  const [pinnedReference, setPinnedReference] = useState<RevisionReference | null>(null)
  const referenceRef = useRef<RevisionReference | null>(null)
  const [referenceOpen, setReferenceOpenState] = useState(false)
  const referenceOpenRef = useRef(false)
  /** Bumped on every open/close, so a pending re-review cannot publish into a resumed pane. */
  const referenceIntent = useRef(0)
  const sessionToken = sessionRef.current?.token
  const setReferenceOpen = (open: boolean) => {
    referenceOpenRef.current = open
    referenceIntent.current++
    setReferenceOpenState(open)
  }
  const setReference = (value: RevisionReference | null) => {
    referenceRef.current = value
    setPinnedReference(value)
  }
  useEffect(() => {
    if (referenceRef.current && referenceRef.current.sessionToken !== sessionToken) {
      setReference(null)
      setReferenceOpen(false)
    }
  }, [sessionToken])
  /** Typing keeps a visible or hidden capture readable; it never reattaches it by searching. */
  const mapReference = (before: Snapshot | null, after: Snapshot, transaction: Transaction) => {
    const pinned = referenceRef.current
    if (pinned && pinned.sessionToken === sessionRef.current?.token)
      setReference(mapRevisionReference(pinned, before, after, transaction))
  }
  const retainedReference = pinnedReference?.sessionToken === sessionToken ? pinnedReference : null
  const reference = referenceOpen ? retainedReference : null
  const canResumeRevision = !!retainedReference && !referenceOpen
  const selectedForRevision = findings.find((finding) => finding.id === selected)
  const reviseAsNew = !!(
    canResumeRevision &&
    retainedReference &&
    selectedForRevision &&
    !canResumeRevisionReference(retainedReference, selectedForRevision, findings)
  )
  const referenceView = reference
    ? referenceState(reference, current, findings, dismissed, analyzers, settings, profile)
    : null
  const referenceReviewer = reference
    ? analyzers.find((a) => a.id === reference.finding.analyzerId)
    : undefined
  const referenceScope: Scope | null = referenceReviewer?.scopes.includes('block')
    ? 'block'
    : referenceReviewer?.scopes.includes('document')
      ? 'document'
      : referenceReviewer?.scopes.includes('selection')
        ? 'selection'
        : null
  const canReviewReference =
    !!referenceReviewer &&
    !!referenceScope &&
    (enabled(referenceReviewer.id) ||
      (referenceReviewer.origin === 'custom' && globallyEnabled(settings, referenceReviewer.id))) &&
    (referenceScope === 'document' ||
      (referenceScope === 'block' ? !!referenceView?.reviewLocation : !!referenceView?.location)) &&
    (referenceScope !== 'selection' ||
      referenceView!.location!.to > referenceView!.location!.from) &&
    !busy &&
    !fileBusy &&
    !saving
  const showRevision = (pin: RevisionReference) => {
    const active = sessionRef.current,
      editor = editorRef.current
    if (
      !active ||
      pin.sessionToken !== active.token ||
      !editor?.isEditable ||
      fileLock.current ||
      saveLock.current
    )
      return
    setReference(pin)
    setReferenceOpen(true)
    const view = referenceState(
      pin,
      snapshot(editor, active.id, revision.current),
      findingsRef.current,
      dismissed,
      createAnalyzerRegistry(settingsRef.current),
      settingsRef.current,
      meta.current.documents[active.path]?.profile ?? profile,
    )
    if (view.location) editor.chain().focus().setTextSelection(view.location).scrollIntoView().run()
    else editor.commands.focus(undefined, { scrollIntoView: false })
    // Explicit opening changes the viewport. Never scroll automatically while editing.
    requestAnimationFrame(() => {
      if (
        !editor.isDestroyed &&
        referenceOpenRef.current &&
        referenceRef.current === pin &&
        sessionRef.current?.token === active.token &&
        view.location
      )
        editor.commands.scrollIntoView()
    })
  }
  const resumeRevision = () => {
    const pin = referenceRef.current
    if (pin) showRevision(pin)
  }
  const beginRevision = (finding: Diagnostic) => {
    const active = sessionRef.current,
      editor = editorRef.current
    if (!active || !editor?.isEditable || fileLock.current || saveLock.current) return
    const retained = referenceRef.current
    if (
      !referenceOpenRef.current &&
      retained?.sessionToken === active.token &&
      canResumeRevisionReference(retained, finding, findingsRef.current)
    ) {
      showRevision(retained)
      return
    }
    const live = findingsRef.current.find((f) => f.id === finding.id)
    if (!live) return
    const replacement =
      finding.replacement !== undefined &&
      (live.replacements?.includes(finding.replacement) || finding.replacement === live.replacement)
        ? finding.replacement
        : live.replacement
    const label = analyzers.find((a) => a.id === live.analyzerId)?.name ?? live.analyzerId
    const pin = captureRevisionReference(
      { ...live, replacement },
      snapshot(editor, active.id, revision.current),
      active.token,
      label,
    )
    if (!pin) {
      showNotice('This passage changed. Choose a current finding to revise.', true)
      return
    }
    const latest = referenceRef.current?.latestFindings
    if (
      referenceRef.current?.capturedHash === pin.capturedHash &&
      latest?.some((item) => item.id === pin.finding.id)
    )
      pin.latestFindings = latest
    showRevision(pin)
  }
  const closeRevision = () => {
    // Hide, don't discard: mapping continues while the reference is closed.
    setReferenceOpen(false)
    editorRef.current?.commands.focus(undefined, { scrollIntoView: false })
  }
  const chooseRevisionFinding = () => {
    setReferenceOpen(false)
    setRightOpen(true)
    setSelected(null)
  }
  const currentReference = () => {
    const pin = referenceRef.current,
      active = sessionRef.current,
      editor = editorRef.current
    if (
      !referenceOpenRef.current ||
      !pin ||
      !active ||
      pin.sessionToken !== active.token ||
      !editor ||
      editor.isDestroyed
    )
      return null
    const input = snapshot(editor, active.id, revision.current)
    const activeProfile = meta.current.documents[active.path]?.profile ?? profile
    return {
      pin,
      editor,
      view: referenceState(
        pin,
        input,
        findings,
        dismissed,
        createAnalyzerRegistry(settingsRef.current),
        settingsRef.current,
        activeProfile,
      ),
    }
  }
  const jumpRevision = () => {
    const latest = currentReference()
    if (latest?.view.location)
      latest.editor.chain().focus().setTextSelection(latest.view.location).scrollIntoView().run()
    else
      showNotice(
        'The reference passage moved, split, or was removed. No other occurrence was selected.',
        true,
      )
  }
  const rereviewRevision = async () => {
    const latest = currentReference()
    if (!latest || !referenceScope || !canReviewReference) return
    const intent = referenceIntent.current
    if (referenceScope !== 'document') {
      const location =
        referenceScope === 'block' ? latest.view.reviewLocation : latest.view.location
      if (!location || (referenceScope === 'selection' && location.from === location.to)) return
      latest.editor
        .chain()
        .focus()
        .setTextSelection(referenceScope === 'selection' ? location : location.from)
        .run()
    }
    const input = snapshot(latest.editor, sessionRef.current!.id, revision.current)
    // Explicit re-review asks for current advice, not an old request-cache entry.
    const results = await run(referenceScope, latest.pin.finding.analyzerId, true)
    const active = sessionRef.current
    const pinned = referenceRef.current
    if (
      !results ||
      !referenceOpenRef.current ||
      referenceIntent.current !== intent ||
      !active ||
      latest.editor.isDestroyed ||
      active.token !== latest.pin.sessionToken ||
      !pinned ||
      pinned.capturedAt !== latest.pin.capturedAt ||
      pinned.finding.id !== latest.pin.finding.id
    )
      return
    const after = snapshot(latest.editor, active.id, revision.current)
    if (after.hash !== input.hash) return
    const relevant = results.filter(
      (finding) =>
        finding.analyzerId === latest.pin.finding.analyzerId &&
        (referenceScope === 'document' || finding.blockId === latest.pin.finding.blockId),
    )
    if (relevant.length) {
      const chosen = relevant.find((finding) => finding.id === latest.pin.finding.id) ?? relevant[0]
      const fresh = captureRevisionReference(chosen, after, active.token, latest.pin.reviewer)
      if (fresh) setReference({ ...fresh, latestFindings: relevant })
    } else {
      const block = after.blocks.find((block) => block.id === latest.pin.finding.blockId)
      setReference({
        ...pinned,
        latestFindings: [],
        cleanReview: {
          profile,
          analyzerVersion: referenceReviewer!.version,
          configurationHash: configurationHash(
            effectiveConfig(settingsRef.current, latest.pin.finding.analyzerId),
          ),
          hash: after.hash,
          text:
            referenceScope === 'document'
              ? after.blocks.map((block) => block.text).join('\n\n')
              : (block?.text ?? ''),
          at: Date.now(),
        },
      })
    }
  }
  const acceptRevision = (alternative = 0) => {
    const latest = currentReference()
    if (
      !latest?.view.canApply ||
      !latest.view.finding ||
      !latest.editor.isEditable ||
      fileLock.current ||
      saveLock.current
    ) {
      showNotice(
        'This reference is no longer applicable. Re-review or choose a current finding.',
        true,
      )
      return
    }
    const original = latest.pin.finding
    const variants = original.replacements?.length
      ? original.replacements
      : original.replacement !== undefined
        ? [original.replacement]
        : []
    const replacement = variants[alternative]
    if (original.action !== 'replace' || replacement === undefined) return
    accept({ ...latest.view.finding, replacement })
  }
  return {
    referenceRef,
    referenceOpenRef,
    reference,
    canResumeRevision,
    reviseAsNew,
    referenceView,
    referenceScope,
    canReviewReference,
    mapReference,
    showRevision,
    resumeRevision,
    beginRevision,
    closeRevision,
    chooseRevisionFinding,
    jumpRevision,
    rereviewRevision,
    acceptRevision,
  }
}
