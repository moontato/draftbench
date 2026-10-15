import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export function revisionDockBounds(available: number) {
  const max = Math.max(64, Math.min(380, Math.floor(available / 2)))
  return { min: Math.min(176, max), max }
}
export function clampRevisionDock(height: number, available: number) {
  const { min, max } = revisionDockBounds(available)
  return Math.max(min, Math.min(max, height))
}
export function useRevisionLayout() {
  const areaRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(() =>
    typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1280, height: 700 },
  )
  const [preferredHeight, setHeight] = useState(240)
  const compact = size.width < 1120 || size.height < 560
  const height = clampRevisionDock(preferredHeight, size.height)
  const { min, max } = revisionDockBounds(size.height)
  const drag = useRef<{ id: number; y: number; height: number } | null>(null)
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const measure = () => {
      const { width, height } = area.getBoundingClientRect()
      if (width > 0 && height > 0)
        setSize((old) => (old.width === width && old.height === height ? old : { width, height }))
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(area)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])
  useEffect(() => {
    drag.current = null
  }, [compact])
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    drag.current = { id: event.pointerId, y: event.clientY, height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return {
    areaRef,
    compact,
    height,
    separatorProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-label': 'Resize revision reference',
      'aria-orientation': 'horizontal' as const,
      'aria-valuemin': Math.round(min),
      'aria-valuemax': Math.round(max),
      'aria-valuenow': Math.round(height),
      'aria-valuetext': `${Math.round(height)} pixels. Up/Down to resize; Home/End for minimum/maximum.`,
      onPointerDown,
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.id === event.pointerId)
          setHeight(
            clampRevisionDock(drag.current.height + drag.current.y - event.clientY, size.height),
          )
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: () => {
        drag.current = null
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        setHeight(
          clampRevisionDock(
            event.key === 'Home'
              ? min
              : event.key === 'End'
                ? max
                : height + (event.key === 'ArrowUp' ? 20 : -20),
            size.height,
          ),
        )
      },
    },
  }
}
