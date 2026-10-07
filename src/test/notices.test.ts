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
describe('transient notifications', () => {
  it.each([false, true])(
    'automatically hides notifications after eight seconds (error=%s)',
    (error) => {
      act(() => state.showNotice('Saved or failed.', error))
      expect(state.notice).toEqual({ message: 'Saved or failed.', error })
      act(() => vi.advanceTimersByTime(NOTICE_DURATION_MS - 1))
      expect(state.notice).not.toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(state.notice).toBeNull()
    },
  )
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
