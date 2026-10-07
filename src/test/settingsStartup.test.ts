import { act, StrictMode, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsState } from '../app/useSettingsState'
import { defaultSettings } from '../settings/model'
const bridge = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock('../storage/desktop', () => ({
  desktopAvailable: true,
  storage: { loadSettings: bridge.load, saveSettings: bridge.save },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let root: Root, container: HTMLDivElement, state: ReturnType<typeof useSettingsState>
const notice = vi.fn()
function Probe() {
  state = useSettingsState(notice)
  return null
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  bridge.load.mockReset()
  bridge.save.mockReset()
  notice.mockReset()
  bridge.save.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
it('awaits one active StrictMode migration before opening settings or restoring document profiles', async () => {
  const old = deferred<unknown>(),
    current = deferred<unknown>(),
    write = deferred<void>()
  bridge.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  bridge.save.mockReturnValue(write.promise)
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))))
  expect(bridge.load).toHaveBeenCalledTimes(2)
  await act(async () => {
    old.resolve({ version: 1, ai: { model: 'abandoned-render' } })
    current.resolve({ version: 1, ai: { model: 'preserved-model', credentialGeneration: 7 } })
  })
  expect(state.settings.ai.model).toBe('preserved-model')
  expect(state.settingsRef.current.ai.credentialGeneration).toBe(7)
  expect(state.settingsLoaded).toBe(false)
  expect(bridge.save).toHaveBeenCalledTimes(1)
  expect(bridge.save.mock.calls[0][0]).toMatchObject({
    version: 2,
    ai: { model: 'preserved-model' },
  })
  let ready = false
  void state.settingsReady.current.then(() => {
    ready = true
  })
  await act(async () => write.resolve())
  expect(ready).toBe(true)
  expect(state.settingsLoaded).toBe(true)
})
it('isolates damaged custom entries without overwriting the original settings', async () => {
  bridge.load.mockResolvedValue({
    ...defaultSettings(),
    customAnalyzers: [
      {
        id: 'valid-reviewer',
        name: 'Valid',
        description: '',
        scope: 'document',
        instructions: 'Report unclear actions.',
        enabled: true,
        severity: 'suggestion',
      },
      { id: 'bad-reviewer', name: 'Broken', scope: 'document', instructions: '' },
    ],
  })
  await act(async () => root.render(createElement(Probe)))
  expect(state.settingsLoaded).toBe(true)
  expect(state.settings.customAnalyzers.map((a) => a.id)).toEqual(['valid-reviewer'])
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('bad-reviewer'), true)
  expect(bridge.save).not.toHaveBeenCalled()
})
it('a failed native settings read permits recovery without automatically writing defaults', async () => {
  bridge.load.mockRejectedValue(new Error('Cannot read settings.'))
  await act(async () => root.render(createElement(Probe)))
  expect(state.settingsLoaded).toBe(true)
  expect(state.settings.version).toBe(2)
  expect(notice).toHaveBeenCalledWith('Cannot read settings.', true)
  expect(bridge.save).not.toHaveBeenCalled()
})
