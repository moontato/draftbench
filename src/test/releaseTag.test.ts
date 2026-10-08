import { describe, expect, it } from 'vitest'
import { checkReleaseTag } from '../../scripts/check-release-tag'

describe('release tag gate', () => {
  it('accepts the exact stable application version', () => {
    expect(checkReleaseTag('v0.2.1', '0.2.1')).toBe('v0.2.1')
    expect(checkReleaseTag('v10.20.30', '10.20.30')).toBe('v10.20.30')
  })
  it('rejects missing, malformed and prerelease tags', () => {
    for (const tag of [undefined, '', '0.2.1', 'vfoo', 'v00.2.1', 'v0.2.1-beta.1', 'v0.2.1\n'])
      expect(() => checkReleaseTag(tag, '0.2.1')).toThrow('form vX.Y.Z')
  })
  it('rejects a version mismatch rather than building a mislabeled installer', () => {
    expect(() => checkReleaseTag('v0.2.2', '0.2.1')).toThrow('does not match application version')
  })
})
