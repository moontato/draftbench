import { z } from 'zod'
export const AI_LIMITS = { timeoutMs: 30 * 60 * 1000, maxTokens: 32768 } as const
export const MAX_PARALLEL_JOBS = 8
export const INPUT_BUDGET_LIMITS = { min: 1000, max: 1_000_000 } as const
export const DEFAULT_INPUT_BUDGETS = { paragraphInputChars: 12000, documentInputChars: 48000 }
const inputBudget = z.number().int().min(INPUT_BUDGET_LIMITS.min).max(INPUT_BUDGET_LIMITS.max)
export const inputBudgetsSchema = z.object({
  paragraphInputChars: inputBudget,
  documentInputChars: inputBudget,
})
export const analyzerIds = [
  'repeated-word',
  'clarity',
  'ambiguous-reference',
  'redundancy',
  'structure',
] as const
export type AnalyzerId = (typeof analyzerIds)[number]
const analyzerConfig = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default(''),
})
export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  ai: z
    .object({
      serverUrl: z.string().default('http://localhost:8080'),
      model: z.string().default('qwen3-8b'),
      timeoutMs: z.number().min(1000).max(AI_LIMITS.timeoutMs).default(120000),
      temperature: z.number().min(0).max(2).default(0.1),
      maxTokens: z.number().int().min(256).max(AI_LIMITS.maxTokens).default(2048),
      credentialGeneration: z.number().int().default(0),
    })
    .default({
      serverUrl: 'http://localhost:8080',
      model: 'qwen3-8b',
      timeoutMs: 120000,
      temperature: 0.1,
      maxTokens: 2048,
      credentialGeneration: 0,
    }),
  analysis: z
    .object({
      parallelJobs: z.number().int().min(1).max(MAX_PARALLEL_JOBS).default(1),
      paragraphInputChars: inputBudget.default(DEFAULT_INPUT_BUDGETS.paragraphInputChars),
      documentInputChars: inputBudget.default(DEFAULT_INPUT_BUDGETS.documentInputChars),
    })
    .default({ parallelJobs: 1, ...DEFAULT_INPUT_BUDGETS }),
  analyzers: z
    .record(z.string(), analyzerConfig)
    .default(Object.fromEntries(analyzerIds.map((id) => [id, { enabled: true, model: '' }]))),
  editor: z
    .object({
      fontSize: z.number().min(14).max(24).default(18),
      spellcheck: z.boolean().default(true),
    })
    .default({ fontSize: 18, spellcheck: true }),
  general: z
    .object({
      defaultProfile: z.enum(['general', 'technical', 'essay', 'email']).default('general'),
    })
    .default({ defaultProfile: 'general' }),
})
export type Settings = z.infer<typeof settingsSchema>
export type EffectiveConfig = Settings['ai']
export type InputBudgets = z.infer<typeof inputBudgetsSchema>
export function sameInputBudgets(a: InputBudgets, b: InputBudgets): boolean {
  return (
    a.paragraphInputChars === b.paragraphInputChars && a.documentInputChars === b.documentInputChars
  )
}
export function defaultSettings(): Settings {
  return structuredClone(settingsSchema.parse({}))
}
export function effectiveConfig(settings: Settings, analyzerId: string): EffectiveConfig {
  return {
    ...settings.ai,
    serverUrl: settings.ai.serverUrl.trim().replace(/\/+$/, ''),
    model: settings.analyzers[analyzerId]?.model.trim() || settings.ai.model.trim(),
  }
}
