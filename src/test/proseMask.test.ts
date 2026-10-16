import { describe, expect, it } from 'vitest'
import {
  formatFingerprint,
  maskRanges,
  maskedRanges,
  normalizeRanges,
  overlaps,
} from '../diagnostics/proseMask'

/** Every masked unit becomes a space and every other unit keeps its exact index. */
function expectMaskedAt(text: string, masked: string, ranges: { start: number; end: number }[]) {
  expect(masked.length).toBe(text.length)
  for (let i = 0; i < text.length; i++) {
    const inside = ranges.some((r) => i >= r.start && i < r.end)
    expect(masked[i]).toBe(inside ? ' ' : text[i])
  }
}
describe('prose mask', () => {
  it('replaces code text with spaces without changing UTF-16 length or prose offsets', () => {
    const text = 'Call run() before you ship.',
      ranges = [{ start: text.indexOf('run()'), end: text.indexOf('run()') + 5 }]
    const masked = maskRanges(text, ranges)
    expectMaskedAt(text, masked, ranges)
    expect(masked).not.toContain('run()')
    // An index the reviewer returns still addresses the same source character.
    expect(masked.slice(text.indexOf('before'), text.indexOf('before') + 6)).toBe('before')
  })
  it('clamps, sorts and merges overlapping or adjacent spans before masking', () => {
    const text = 'a code1 code2 b'
    expect(
      normalizeRanges(
        [
          { start: 14, end: 20 },
          { start: 8, end: 13 },
          { start: 2, end: 7 },
        ],
        text.length,
      ),
    ).toEqual([
      { start: 2, end: 7 },
      { start: 8, end: 13 },
      { start: 14, end: 15 },
    ])
    expect(
      maskedRanges(text, [
        { start: 2, end: 7 },
        { start: 7, end: 13 },
      ]),
    ).toEqual([{ start: 2, end: 13 }])
    const clamped = maskRanges(text, [
      { start: -5, end: 3 },
      { start: 10, end: 999 },
    ])
    expectMaskedAt(text, clamped, [
      { start: 0, end: 3 },
      { start: 10, end: 15 },
    ])
    expect(maskRanges(text, [])).toBe(text)
    expect(maskRanges(text, [{ start: 5, end: 5 }])).toBe(text)
  })
  it('never splits a surrogate pair, keeping the native payload valid UTF-16', () => {
    const text = 'a😀b', // high surrogate at 1, low surrogate at 2
      masked = maskRanges(text, [{ start: 2, end: 3 }])
    expect(masked).toBe('a  b')
    expect(masked.length).toBe(text.length)
    expect(masked).not.toMatch(/[\uD800-\uDFFF]/)
  })
  it('reports overlap for anything touching masked code text', () => {
    const ranges = [{ start: 4, end: 8 }]
    expect(overlaps(ranges, 7, 10)).toBe(true) // a lint widened into the code span
    expect(overlaps(ranges, 8, 10)).toBe(false)
    expect(overlaps(ranges, 0, 4)).toBe(false)
    expect(overlaps(ranges, 5, 6)).toBe(true)
  })
  it('fingerprints formatting only, and treats no-code and empty as the same identity', () => {
    const text = 'Use code here.'
    expect(formatFingerprint(undefined, text)).toBe('')
    expect(formatFingerprint([], text)).toBe('')
    const a = formatFingerprint([{ start: 4, end: 8 }], text)
    expect(a).toHaveLength(64)
    expect(a).toBe(formatFingerprint([{ start: 4, end: 8 }], text))
    expect(a).not.toBe(formatFingerprint([{ start: 4, end: 9 }], text))
    // Adjacent code nodes merge, so splitting one code span into two nodes is not a change.
    expect(
      formatFingerprint(
        [
          { start: 4, end: 6 },
          { start: 6, end: 8 },
        ],
        text,
      ),
    ).toBe(a)
  })
})
