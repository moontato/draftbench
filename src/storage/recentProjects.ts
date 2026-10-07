import { z } from 'zod'

export const RECENT_PROJECT_LIMIT = 5
const recentProject = z.object({
  path: z
    .string()
    .min(1)
    .max(8192)
    .refine(
      (path) =>
        (path.startsWith('/') || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) && !path.includes('\0'),
    ),
  name: z.string().trim().min(1).max(512),
  lastOpened: z.number().int().nonnegative().max(8_640_000_000_000_000),
})
export type RecentProject = z.infer<typeof recentProject>
export function parseRecentProjects(value: unknown): RecentProject[] {
  const result = z.array(recentProject).max(RECENT_PROJECT_LIMIT).safeParse(value)
  if (!result.success)
    throw new Error(
      'Recent project list could not be loaded. You can still open a writing folder normally.',
    )
  return result.data.filter(
    (project, index, all) => all.findIndex((other) => other.path === project.path) === index,
  )
}
