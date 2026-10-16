import type { Diagnostic } from './types'

/**
 * The Analysis pane's view filters. They are shared with the editor so the
 * underlines always describe the same findings the list is showing.
 */
export interface FindingFilters {
  analyzer: string
  severity: string
  category: string
  showDismissed: boolean
}
export const defaultFindingFilters: FindingFilters = {
  analyzer: 'all',
  severity: 'all',
  category: 'all',
  showDismissed: false,
}
export function filterFindings(
  findings: Diagnostic[],
  dismissed: Set<string>,
  filters: FindingFilters,
): Diagnostic[] {
  return findings.filter(
    (f) =>
      (filters.showDismissed || !dismissed.has(f.id)) &&
      (filters.analyzer === 'all' || f.analyzerId === filters.analyzer) &&
      (filters.severity === 'all' || f.severity === filters.severity) &&
      (filters.category === 'all' || f.category === filters.category),
  )
}
export function filtersActive(filters: FindingFilters): boolean {
  return filters.analyzer !== 'all' || filters.severity !== 'all' || filters.category !== 'all'
}
/** Clears the narrowing filters without changing the “Show dismissed” preference. */
export const clearFindingFilters: Partial<FindingFilters> = {
  analyzer: 'all',
  severity: 'all',
  category: 'all',
}
/**
 * Underlined findings: the visible list minus dismissed ones. A dismissed
 * finding stays listed when "Show dismissed" is on, but it is never underlined
 * again because the author already decided to ignore it.
 */
export function underlinedFindings(visible: Diagnostic[], dismissed: Set<string>): Diagnostic[] {
  return visible.filter((f) => !dismissed.has(f.id))
}
export function countHiddenFindings(
  findings: Diagnostic[],
  dismissed: Set<string>,
  visible: Diagnostic[],
): number {
  const listed = findings.filter((f) => !dismissed.has(f.id)).length
  return listed - visible.filter((f) => !dismissed.has(f.id)).length
}
