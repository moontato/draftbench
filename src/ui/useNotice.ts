import { useCallback, useEffect, useState } from 'react'

export const NOTICE_DURATION_MS = 8000

export function useNotice() {
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null)
  const showNotice = useCallback((message: string, error = false) => {
    // A fresh object restarts the timer even when the same message is shown twice.
    setNotice({ message, error })
  }, [])
  const dismissNotice = useCallback(() => setNotice(null), [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismissNotice, NOTICE_DURATION_MS)
    return () => clearTimeout(timer)
  }, [notice, dismissNotice])
  return { notice, showNotice, dismissNotice }
}
