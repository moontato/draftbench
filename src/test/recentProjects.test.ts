import { describe, expect, it } from 'vitest'
import { parseRecentProjects, RECENT_PROJECT_LIMIT } from '../storage/recentProjects'

const recent = (path = '/home/writer/notes') => ({ path, name: 'Notes', lastOpened: 1700000000000 })
describe('recent project IPC data', () => {
  it('accepts native paths on Linux, macOS, and Windows without changing their identities', () => {
    const paths = [
      '/home/writer/notes',
      '/Users/writer/notes',
      'C:\\Users\\writer\\notes',
      '\\\\?\\C:\\Users\\writer\\notes',
      '\\\\server\\share\\notes',
    ]
    expect(parseRecentProjects(paths.map((path) => recent(path))).map((p) => p.path)).toEqual(paths)
  })
  it('deduplicates paths while retaining MRU order', () => {
    expect(
      parseRecentProjects([recent('/one'), recent('/two'), recent('/one')]).map((p) => p.path),
    ).toEqual(['/one', '/two'])
  })
  it('rejects corrupt, oversized, relative, or invalid-date entries', () => {
    for (const value of [
      null,
      {},
      [recent('relative')],
      [recent('/bad\0path')],
      [{ ...recent(), lastOpened: -1 }],
      [{ ...recent(), lastOpened: 9e15 }],
      [{ ...recent(), name: '' }],
      Array.from({ length: RECENT_PROJECT_LIMIT + 1 }, (_, i) => recent(`/project-${i}`)),
    ]) {
      expect(() => parseRecentProjects(value)).toThrow('Recent project list')
    }
  })
  it('accepts an empty first-launch list and does not retain extra fields', () => {
    expect(parseRecentProjects([])).toEqual([])
    expect(parseRecentProjects([{ ...recent(), writing: 'not retained' }])[0]).not.toHaveProperty(
      'writing',
    )
  })
})
