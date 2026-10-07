import type { Settings } from '../settings/model'
export type ProfileId = string
export interface WritingProfile {
  name: string
  description?: string
  enabled: string[]
}
const all = ['repeated-word', 'harper', 'clarity', 'ambiguous-reference', 'redundancy', 'structure']
export const profiles: Record<string, WritingProfile> = {
  general: {
    name: 'General prose',
    enabled: ['repeated-word', 'harper', 'clarity', 'ambiguous-reference', 'redundancy'],
  },
  technical: { name: 'Technical writing', enabled: all },
  essay: { name: 'Essay', enabled: all },
  email: {
    name: 'Professional email',
    enabled: ['repeated-word', 'harper', 'clarity', 'ambiguous-reference', 'redundancy'],
  },
}
export function getProfiles(settings: Settings): Record<string, WritingProfile> {
  return { ...profiles, ...Object.fromEntries(settings.customProfiles.map((p) => [p.id, p])) }
}
export function globallyEnabled(settings: Settings, id: string): boolean {
  return (
    (settings.analyzers[id]?.enabled ?? true) &&
    (settings.customAnalyzers.find((a) => a.id === id)?.enabled ?? true)
  )
}
export function analyzerEnabled(settings: Settings, id: string, profile: string): boolean {
  return (
    globallyEnabled(settings, id) && (getProfiles(settings)[profile]?.enabled.includes(id) ?? false)
  )
}
