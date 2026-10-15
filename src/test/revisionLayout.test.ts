import { expect, it } from 'vitest'
import { clampRevisionDock, revisionDockBounds } from '../diagnostics/useRevisionLayout'
it('keeps the dock inside a sane share of the available height', () => {
  expect(revisionDockBounds(1400)).toEqual({ min: 176, max: 380 })
  expect(revisionDockBounds(700)).toEqual({ min: 176, max: 350 })
  expect(revisionDockBounds(300)).toEqual({ min: 150, max: 150 })
})
it('clamps the preferred dock height into the available bounds', () => {
  expect(clampRevisionDock(240, 700)).toBe(240)
  expect(clampRevisionDock(100, 700)).toBe(176)
  expect(clampRevisionDock(500, 700)).toBe(350)
  expect(clampRevisionDock(240, 300)).toBe(150)
})
