import { z } from 'zod'

export const stableId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'Use a lowercase ID with letters, numbers and hyphens.')
  .refine((id) => !['constructor', 'prototype', '__proto__'].includes(id), 'Reserved ID.')
const name = z.string().trim().min(1).max(100)
export const customAnalyzerSchema = z.object({
  id: stableId,
  name,
  description: z.string().trim().max(1000).default(''),
  enabled: z.boolean().default(true),
  scope: z.enum(['paragraph', 'nearby', 'selection', 'document']),
  instructions: z.string().trim().min(1).max(16000),
  severity: z.enum(['info', 'suggestion', 'warning', 'error']).default('suggestion'),
})
export const customProfileSchema = z.object({
  id: stableId,
  name,
  description: z.string().trim().max(1000).default(''),
  enabled: z
    .array(stableId)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate analyzer membership.'),
})
export type CustomAnalyzer = z.infer<typeof customAnalyzerSchema>
export type CustomProfile = z.infer<typeof customProfileSchema>
export const BUILTIN_ANALYZER_IDS = [
  'repeated-word',
  'clarity',
  'ambiguous-reference',
  'redundancy',
  'structure',
  'harper',
] as const
export const BUILTIN_PROFILE_IDS = ['general', 'technical', 'essay', 'email'] as const
export function uniqueId(prefix: string, ids: string[]): string {
  const used = new Set(ids)
  let n = 1
  while (used.has(`${prefix}-${n}`)) n++
  return `${prefix}-${n}`
}
