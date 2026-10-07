import type { MarkdownFile } from '../documents/markdown'
import type { ProfileId } from '../profiles/profiles'
export interface Session {
  path: string
  id: string
  token: string
  source: MarkdownFile
  diskHash: string
  original: string
}
export interface ProjectMeta {
  version: 1 | 2
  documents: Record<string, { id: string; profile: ProfileId }>
}
export interface Ask {
  title: string
  description: string
  initial: string
  resolve: (answer: string | null) => void
}
