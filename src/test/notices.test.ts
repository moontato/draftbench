import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTICE_DURATION_MS, useNotice } from '../ui/useNotice'

let root: Root
let container: HTMLDivElement
let state: ReturnType<typeof useNotice>
function Probe() {
  state = useNotice()
  return null
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(createElement(Probe)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('notification lifetime', () => {
  it('automatically hides success notifications after eight seconds', () => {
    act(() => state.showNotice('Saved.'))
    act(() => vi.advanceTimersByTime(NOTICE_DURATION_MS - 1))
    expect(state.notice).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(state.notice).toBeNull()
  })
  it('keeps warnings readable until dismissed, even if a success follows', () => {
    act(() => state.showNotice('Review results could not be saved.', true))
    act(() => vi.advanceTimersByTime(NOTICE_DURATION_MS * 10))
    act(() => state.showNotice('Analysis complete.'))
    expect(state.notice?.message).toBe('Review results could not be saved.')
    act(() => state.dismissNotice())
    expect(state.notice).toBeNull()
  })
  it('restarts the timer for identical messages and never lets an old timer dismiss a newer notice', () => {
    act(() => state.showNotice('Saved.'))
    act(() => vi.advanceTimersByTime(7000))
    act(() => state.showNotice('Saved.'))
    act(() => vi.advanceTimersByTime(1000))
    expect(state.notice?.message).toBe('Saved.')
    act(() => state.showNotice('Analysis complete.'))
    act(() => vi.advanceTimersByTime(7000))
    expect(state.notice?.message).toBe('Analysis complete.')
    act(() => vi.advanceTimersByTime(1000))
    expect(state.notice).toBeNull()
  })
  it('supports early dismissal and cancels its timer', () => {
    act(() => state.showNotice('Saved.'))
    act(() => state.dismissNotice())
    expect(state.notice).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
