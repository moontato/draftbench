export type ProfileId = 'general' | 'technical' | 'essay' | 'email'
export interface WritingProfile {
  name: string
  enabled: string[]
}
const all = ['repeated-word', 'clarity', 'ambiguous-reference', 'redundancy', 'structure']
export const profiles: Record<ProfileId, WritingProfile> = {
  general: {
    name: 'General prose',
    enabled: ['repeated-word', 'clarity', 'ambiguous-reference', 'redundancy'],
  },
  technical: { name: 'Technical writing', enabled: all },
  essay: { name: 'Essay', enabled: all },
  email: {
    name: 'Professional email',
    enabled: ['repeated-word', 'clarity', 'ambiguous-reference', 'redundancy'],
  },
}
