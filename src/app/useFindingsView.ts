import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { Editor } from '@tiptap/core'
import type { Analyzer } from '../analyzers/types'
import {
  defaultFindingFilters,
  filterFindings,
  underlinedFindings,
  type FindingFilters,
} from '../diagnostics/filters'
import type { Diagnostic } from '../diagnostics/types'
import { decorate } from '../editor/diagnostics'

/** A shared `ref`-like holder, so extraction never depends on a React ref type version. */
export interface Holder<T> {
  current: T
}
/**
 * The one findings view. The Analysis pane list, the editor underlines and the open
 * inspector all read this state, so they can never disagree about what is visible.
 *
 * `findingsRef` is authoritative and synchronous: a native save or review completion can
 * interleave before React re-renders, and a save must never persist an older feedback frame.
 */
export function useFindingsView(deps: { editorRef: Holder<Editor | null>; analyzers: Analyzer[] }) {
  const [findings, setFindingsState] = useState<Diagnostic[]>([]),
    findingsRef = useRef(findings)
  const setFindings = useCallback<Dispatch<SetStateAction<Diagnostic[]>>>((next) => {
    const value = typeof next === 'function' ? next(findingsRef.current) : next
    findingsRef.current = value
    setFindingsState(value)
  }, [])
  const [selected, setSelected] = useState<string | null>(null),
    [dismissed, setDismissed] = useState(new Set<string>()),
    [filters, setFiltersState] = useState<FindingFilters>(defaultFindingFilters)
  const setFilters = useCallback((patch: Partial<FindingFilters>) => {
    setFiltersState((old) => ({ ...old, ...patch }))
  }, [])
  const visibleFindings = useMemo(
    () => filterFindings(findings, dismissed, filters),
    [findings, dismissed, filters],
  )
  useEffect(() => {
    // A removed analyzer or a category that is no longer present cannot stay selected.
    setFiltersState((old) => {
      const analyzer =
        old.analyzer !== 'all' && !deps.analyzers.some((a) => a.id === old.analyzer)
          ? 'all'
          : old.analyzer
      const category =
        old.category !== 'all' && !findings.some((f) => f.category === old.category)
          ? 'all'
          : old.category
      return analyzer === old.analyzer && category === old.category
        ? old
        : { ...old, analyzer, category }
    })
  }, [deps.analyzers, findings])
  useEffect(() => {
    const editor = deps.editorRef.current
    if (editor && !editor.isDestroyed)
      decorate(editor, underlinedFindings(visibleFindings, dismissed))
    // The list, the underlines and the open inspector always describe one view.
    if (selected && !visibleFindings.some((f) => f.id === selected)) setSelected(null)
  }, [deps.editorRef, visibleFindings, dismissed, selected])
  return {
    findings,
    findingsRef,
    setFindings,
    selected,
    setSelected,
    dismissed,
    setDismissed,
    filters,
    setFilters,
    visibleFindings,
  }
}
