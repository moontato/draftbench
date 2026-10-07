import { describe, expect, it } from 'vitest'
import { clampReviewHeight, reviewHeightBounds } from '../diagnostics/useReviewResize'

describe('review inspector height limits', () => {
  it('reserves card space and bounds pointer/keyboard heights', () => {
    expect(reviewHeightBounds(500)).toEqual({ min: 144, max: 404 })
    expect(clampReviewHeight(1000, 500)).toBe(404)
    expect(clampReviewHeight(-100, 500)).toBe(144)
    expect(clampReviewHeight(220, 500)).toBe(220)
  })
  it('shrinks for short windows instead of keeping a large minimum inspector', () => {
    expect(clampReviewHeight(220, 200)).toBe(104)
    expect(clampReviewHeight(220, 100)).toBe(48)
  })
  it('restores the preferred height when more room becomes available', () => {
    const preferred = 280
    expect(clampReviewHeight(preferred, 250)).toBe(154)
    expect(clampReviewHeight(preferred, 600)).toBe(preferred)
  })
})
