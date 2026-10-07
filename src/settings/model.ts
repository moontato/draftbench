import { z } from 'zod'
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
      timeoutMs: z.number().min(1000).max(600000).default(120000),
      temperature: z.number().min(0).max(2).default(0.1),
      maxTokens: z.number().int().min(256).max(16384).default(2048),
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
export function defaultSettings(): Settings {
  return settingsSchema.parse({})
}
export function effectiveConfig(settings: Settings, analyzerId: string): EffectiveConfig {
  return {
    ...settings.ai,
    serverUrl: settings.ai.serverUrl.trim().replace(/\/+$/, ''),
    model: settings.analyzers[analyzerId]?.model.trim() || settings.ai.model.trim(),
  }
}
