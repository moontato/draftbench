import { useEffect, useRef, useState } from 'react'
import { defaultSettings, loadSettings } from '../settings/model'
import { desktopAvailable, errorMessage, storage } from '../storage/desktop'

export function useSettingsState(showNotice: (message: string, error?: boolean) => void) {
  const [settings, setSettings] = useState(defaultSettings)
  const settingsRef = useRef(settings)
  const [settingsLoaded, setSettingsLoaded] = useState(!desktopAvailable)
  const settingsReady = useRef<Promise<void>>(Promise.resolve())
  settingsRef.current = settings
  useEffect(() => {
    if (!desktopAvailable) return
    let active = true
    settingsReady.current = storage
      .loadSettings()
      .then(async (raw) => {
        if (!active || !raw) return
        const loaded = loadSettings(raw)
        settingsRef.current = loaded.settings
        setSettings(loaded.settings)
        if (loaded.warnings.length) showNotice(loaded.warnings.join(' '), true)
        // Do not overwrite an original that needed entry repair. Successful legacy
        // migration is atomic and awaited before settings editing becomes available.
        if (loaded.migrated && !loaded.warnings.length) {
          try {
            await storage.saveSettings(loaded.settings)
          } catch {
            if (active)
              showNotice(
                'Settings migration could not be saved; your original settings are intact.',
                true,
              )
          }
        }
      })
      .catch((error) => {
        if (active) showNotice(errorMessage(error), true)
      })
      .finally(() => {
        if (active) setSettingsLoaded(true)
      })
    return () => {
      active = false
    }
  }, [showNotice])
  return { settings, settingsRef, setSettings, settingsLoaded, settingsReady }
}
