import { describe, expect, it } from 'vitest'
import {
  clearFindingFilters,
  countHiddenFindings,
  defaultFindingFilters,
  filterFindings,
  filtersActive,
  underlinedFindings,
  type FindingFilters,
} from '../diagnostics/filters'
import type { Diagnostic, Severity } from '../diagnostics/types'

function finding(id: string, analyzerId: string, severity: Severity, category: string): Diagnostic {
  return {
    id,
    analyzerId,
    analyzerVersion: '1',
    category,
    severity,
    message: `${id} message`,
    explanation: '',
    documentId: 'doc',
    blockId: 'b1',
    quote: 'quoted text',
    start: 0,
    end: 11,
    from: 10,
    to: 21,
    blockIndex: 0,
    action: 'guide',
    revision: 0,
    contentHash: 'document-hash',
    blockHash: 'block-hash',
    dependencies: {},
    engine: { kind: 'deterministic', name: 'Test engine' },
    configurationHash: 'config-hash',
  }
}
const clarityWarning = finding('c1', 'clarity', 'warning', 'clarity'),
  clarityInfo = finding('c2', 'clarity', 'info', 'wordiness'),
  harperWarning = finding('h1', 'harper', 'warning', 'harper-grammar'),
  all = [clarityWarning, clarityInfo, harperWarning],
  ids = (list: Diagnostic[]) => list.map((f) => f.id),
  withFilters = (patch: Partial<FindingFilters>) => ({ ...defaultFindingFilters, ...patch })

describe('analysis view filters', () => {
  it('defaults to showing every undismissed finding', () => {
    expect(defaultFindingFilters).toEqual({
      analyzer: 'all',
      severity: 'all',
      category: 'all',
      showDismissed: false,
    })
    expect(ids(filterFindings(all, new Set(), defaultFindingFilters))).toEqual(['c1', 'c2', 'h1'])
    expect(filtersActive(defaultFindingFilters)).toBe(false)
  })
  it('selecting one analyzer leaves only that analyzer in the shared view', () => {
    const filters = withFilters({ analyzer: 'clarity' })
    expect(ids(filterFindings(all, new Set(), filters))).toEqual(['c1', 'c2'])
    expect(ids(underlinedFindings(filterFindings(all, new Set(), filters), new Set()))).toEqual([
      'c1',
      'c2',
    ])
    expect(
      ids(filterFindings(all, new Set(), withFilters({ analyzer: 'harper' }))).map((id) => id),
    ).toEqual(['h1'])
  })
  it('severity and category narrow the same view the editor underlines', () => {
    const bySeverity = withFilters({ severity: 'warning' })
    expect(ids(filterFindings(all, new Set(), bySeverity))).toEqual(['c1', 'h1'])
    const byCategory = withFilters({ analyzer: 'clarity', category: 'wordiness' })
    expect(ids(filterFindings(all, new Set(), byCategory))).toEqual(['c2'])
    expect(ids(underlinedFindings(filterFindings(all, new Set(), byCategory), new Set()))).toEqual([
      'c2',
    ])
  })
  it('dismissed findings stay listed only when asked and are never underlined', () => {
    const dismissed = new Set(['h1'])
    expect(ids(filterFindings(all, dismissed, defaultFindingFilters))).toEqual(['c1', 'c2'])
    const shown = filterFindings(all, dismissed, withFilters({ showDismissed: true }))
    expect(ids(shown)).toEqual(['c1', 'c2', 'h1'])
    expect(ids(underlinedFindings(shown, dismissed))).toEqual(['c1', 'c2'])
  })
  it('counts findings hidden by filters without counting dismissed ones', () => {
    expect(
      countHiddenFindings(all, new Set(), filterFindings(all, new Set(), defaultFindingFilters)),
    ).toBe(0)
    expect(
      countHiddenFindings(
        all,
        new Set(),
        filterFindings(all, new Set(), withFilters({ analyzer: 'clarity' })),
      ),
    ).toBe(1)
    // Dismissing a finding is not the same as filtering it out of the view.
    expect(
      countHiddenFindings(
        all,
        new Set(['h1']),
        filterFindings(all, new Set(['h1']), defaultFindingFilters),
      ),
    ).toBe(0)
  })
  it('clearing filters keeps the show-dismissed preference intact', () => {
    const filters = withFilters({ analyzer: 'harper', severity: 'info', showDismissed: true })
    expect(filtersActive(filters)).toBe(true)
    const cleared = { ...filters, ...clearFindingFilters }
    expect(cleared).toEqual({
      analyzer: 'all',
      severity: 'all',
      category: 'all',
      showDismissed: true,
    })
    expect(filtersActive(cleared)).toBe(false)
  })
})
