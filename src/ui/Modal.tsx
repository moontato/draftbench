import { useEffect, useRef, type ReactNode } from 'react'
export function Modal({ children, onEscape }: { children: ReactNode; onEscape?: () => void }) {
  const root = useRef<HTMLDivElement>(null),
    escape = useRef(onEscape)
  escape.current = onEscape
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const focusable = () =>
      [
        ...(root.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
        ) ?? []),
      ].filter((el) => el.getClientRects().length)
    const current = document.activeElement
    if (!root.current?.contains(current)) focusable()[0]?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escape.current) {
        event.preventDefault()
        escape.current()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable(),
        first = elements[0],
        last = elements.at(-1)
      if (!first) {
        event.preventDefault()
        return
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !root.current?.contains(document.activeElement))
      ) {
        event.preventDefault()
        last?.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !root.current?.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <div className="modal-backdrop" ref={root}>
      {children}
    </div>
  )
}
