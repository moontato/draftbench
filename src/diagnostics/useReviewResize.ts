import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export function reviewHeightBounds(available: number) {
  const max = Math.max(48, available - 96) // Reserve space for the cards, even in a short window.
  return { min: Math.min(144, max), max }
}
export function clampReviewHeight(height: number, available: number) {
  const { min, max } = reviewHeightBounds(available)
  return Math.min(max, Math.max(min, height))
}
export function useReviewResize() {
  const areaRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; y: number; height: number } | null>(null)
  const [available, setAvailable] = useState(400)
  const [preferredHeight, setHeight] = useState(220)
  const height = clampReviewHeight(preferredHeight, available)
  const { min, max } = reviewHeightBounds(available)
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const measure = () => setAvailable(area.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [])
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    drag.current = { id: event.pointerId, y: event.clientY, height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    setHeight(clampReviewHeight(drag.current.height + drag.current.y - event.clientY, available))
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return
    const next =
      key === 'ArrowUp'
        ? height + 20
        : key === 'ArrowDown'
          ? height - 20
          : key === 'Home'
            ? min
            : max
    event.preventDefault()
    setHeight(clampReviewHeight(next, available))
  }
  return {
    areaRef,
    height,
    separatorProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-label': 'Resize review finding',
      'aria-orientation': 'horizontal' as const,
      'aria-valuemin': Math.round(min),
      'aria-valuemax': Math.round(max),
      'aria-valuenow': Math.round(height),
      'aria-valuetext': `${Math.round(height)} pixels. Up/Down to resize; Home/End for minimum/maximum.`,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onLostPointerCapture: () => {
        drag.current = null
      },
      onKeyDown,
    },
  }
}
