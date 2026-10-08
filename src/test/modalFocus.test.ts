import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Modal } from '../ui/Modal'
it('traps Tab through a final textarea and only the top modal consumes Escape', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const rects = vi
    .spyOn(HTMLElement.prototype, 'getClientRects')
    .mockReturnValue([{}] as unknown as DOMRectList)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const firstEscape = vi.fn(),
    topEscape = vi.fn()
  try {
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Modal, {
            onEscape: firstEscape,
            children: createElement('button', null, 'Behind'),
          }),
          createElement(Modal, {
            onEscape: topEscape,
            children: [
              createElement('button', { id: 'first', key: 'first' }, 'First'),
              createElement('textarea', { id: 'last', key: 'last' }),
            ],
          }),
        ),
      ),
    )
    const first = container.querySelector<HTMLButtonElement>('#first')!
    const last = container.querySelector<HTMLTextAreaElement>('#last')!
    last.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    last.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(last)
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(topEscape).toHaveBeenCalledTimes(1)
    expect(firstEscape).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    rects.mockRestore()
  }
})
