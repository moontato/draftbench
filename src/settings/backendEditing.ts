import type { Backend, Settings } from './model'

export function updateBackend(settings: Settings, id: string, patch: Partial<Backend>): Settings {
  const current = settings.backends.find((b) => b.id === id)
  if (!current) return settings
  const backend = { ...current, ...(id === 'default' ? settings.ai : {}), ...patch, id }
  const ai =
    id === 'default'
      ? {
          serverUrl: backend.serverUrl,
          model: backend.model,
          timeoutMs: backend.timeoutMs,
          temperature: backend.temperature,
          maxTokens: backend.maxTokens,
          credentialGeneration: backend.credentialGeneration,
        }
      : settings.ai
  return { ...settings, ai, backends: settings.backends.map((b) => (b.id === id ? backend : b)) }
}
