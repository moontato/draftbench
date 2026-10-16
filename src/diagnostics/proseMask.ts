import { hash } from './hash'

/** A [start, end) span in a block's plain-text projection (UTF-16 code-unit indices). */
export interface TextRange {
  start: number
  end: number
}
const isHigh = (unit: string) => /[\uD800-\uDBFF]/.test(unit)
const isLow = (unit: string) => /[\uDC00-\uDFFF]/.test(unit)

/** Clamp, expand so a UTF-16 surrogate pair is never split, then merge overlaps/adjacency. */
export function normalizeRanges(ranges: TextRange[], length: number): TextRange[] {
  const sorted = ranges
    .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end))
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(length, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: TextRange[] = []
  for (const { start, end } of sorted) {
    const last = merged[merged.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  return merged
}
/** Expand boundaries that would cut a surrogate pair in half, then re-merge. */
export function protectPairs(ranges: TextRange[], text: string): TextRange[] {
  const widened = ranges.map(({ start, end }) => ({
    start: start > 0 && isHigh(text[start - 1]) && isLow(text[start]) ? start - 1 : start,
    end: end < text.length && isHigh(text[end - 1]) && isLow(text[end]) ? end + 1 : end,
  }))
  return normalizeRanges(widened, text.length)
}
/**
 * Replace the given spans with spaces of identical UTF-16 length.
 *
 * Length preservation is the whole point: the native grammar adapter converts its
 * character spans into UTF-16 offsets, and `Block.positions` maps UTF-16 indices to
 * editor positions. A masked index therefore still indexes the original text, so an
 * accepted finding needs no offset translation at all.
 */
export function maskRanges(text: string, ranges: TextRange[]): string {
  const normalized = protectPairs(normalizeRanges(ranges, text.length), text)
  if (!normalized.length) return text
  let out = '',
    cursor = 0
  for (const range of normalized) {
    out += text.slice(cursor, range.start)
    out += ' '.repeat(range.end - range.start)
    cursor = range.end
  }
  return out + text.slice(cursor)
}
/** Ranges actually masked, in the same normalized form `maskRanges` applied. */
export function maskedRanges(text: string, ranges: TextRange[]): TextRange[] {
  return protectPairs(normalizeRanges(ranges, text.length), text)
}
export function overlaps(ranges: TextRange[], start: number, end: number): boolean {
  return ranges.some((range) => start < range.end && end > range.start)
}
/** Stable fingerprint of a block's inline-code formatting. '' when there is none. */
export function formatFingerprint(ranges: TextRange[] | undefined, text: string): string {
  if (!ranges || !ranges.length) return ''
  return hash(JSON.stringify(maskedRanges(text, ranges)))
}
