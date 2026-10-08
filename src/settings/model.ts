import { z } from 'zod'
import { canonical, hash } from '../diagnostics/hash'
import {
  BUILTIN_ANALYZER_IDS,
  BUILTIN_PROFILE_IDS,
  customAnalyzerSchema,
  customProfileSchema,
  stableId,
} from './definitions'

export const AI_LIMITS = { timeoutMs: 30 * 60 * 1000, maxTokens: 32768 } as const
export const MAX_PARALLEL_JOBS = 8
export const INPUT_BUDGET_LIMITS = { min: 1000, max: 1_000_000 } as const
export const DEFAULT_INPUT_BUDGETS = { paragraphInputChars: 12000, documentInputChars: 48000 }
const inputBudget = z.number().int().min(INPUT_BUDGET_LIMITS.min).max(INPUT_BUDGET_LIMITS.max)
export const inputBudgetsSchema = z.object({
  paragraphInputChars: inputBudget,
  documentInputChars: inputBudget,
})
export const analyzerIds = BUILTIN_ANALYZER_IDS
export type AnalyzerId = string
const aiDefaults = {
  serverUrl: 'http://localhost:8080',
  model: 'qwen3-8b',
  timeoutMs: 120000,
  temperature: 0.1,
  maxTokens: 2048,
  credentialGeneration: 0,
}
const aiSchema = z.object({
  serverUrl: z.string().max(2000).default(aiDefaults.serverUrl),
  model: z.string().max(200).default(aiDefaults.model),
  timeoutMs: z.number().min(1000).max(AI_LIMITS.timeoutMs).default(aiDefaults.timeoutMs),
  temperature: z.number().min(0).max(2).default(aiDefaults.temperature),
  maxTokens: z.number().int().min(256).max(AI_LIMITS.maxTokens).default(aiDefaults.maxTokens),
  credentialGeneration: z.number().int().nonnegative().default(0),
})
export function normalizeBackendUrl(value: string): string {
  const url = new URL(value.trim())
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTP or HTTPS server URL without credentials, query or fragment.')
  return url.toString().replace(/\/+$/, '')
}
export const backendSchema = aiSchema
  .extend({
    id: stableId,
    name: z.string().trim().min(1).max(100),
    serverUrl: z
      .string()
      .max(2000)
      .transform((value, context) => {
        try {
          return normalizeBackendUrl(value)
        } catch {
          context.addIssue({ code: 'custom', message: 'Invalid HTTP/HTTPS backend URL.' })
          return z.NEVER
        }
      }),
    credentialRef: z.string().max(100).default(''),
    parallelJobs: z.number().int().min(1).max(MAX_PARALLEL_JOBS).default(2),
  })
  .superRefine((backend, ctx) => {
    if (
      backend.credentialRef &&
      backend.credentialRef !==
        (backend.id === 'default' ? 'openai-compatible' : `backend:${backend.id}`)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['credentialRef'],
        message: 'Credential reference must belong to this backend.',
      })
  })
export type Backend = z.infer<typeof backendSchema>
export function legacyBackend(ai = aiDefaults): Backend {
  return {
    ...ai,
    id: 'default',
    name: 'Default',
    credentialRef: 'openai-compatible',
    parallelJobs: 2,
  }
}
const analyzerConfig = z.object({
  enabled: z.boolean().default(true),
  model: z.string().max(200).default(''),
  backend: stableId.or(z.literal('')).optional(),
})
const defaults: Record<string, z.infer<typeof analyzerConfig>> = Object.fromEntries(
  analyzerIds.map((id) => [id, { enabled: id !== 'harper', model: '' }]),
)
const schemaV2 = z
  .object({
    version: z.literal(2).default(2),
    // Compatibility alias for the migrated backend. No secrets live here.
    ai: aiSchema.default(aiDefaults),
    backends: z.array(backendSchema).min(1).max(20).default([legacyBackend()]),
    defaultBackend: stableId.default('default'),
    customAnalyzers: z.array(customAnalyzerSchema).max(40).default([]),
    customProfiles: z.array(customProfileSchema).max(40).default([]),
    analysis: z
      .object({
        parallelJobs: z.number().int().min(1).max(MAX_PARALLEL_JOBS).default(1),
        legacySingleModel: z.boolean().default(true),
        paragraphInputChars: inputBudget.default(DEFAULT_INPUT_BUDGETS.paragraphInputChars),
        documentInputChars: inputBudget.default(DEFAULT_INPUT_BUDGETS.documentInputChars),
      })
      .default({ parallelJobs: 1, legacySingleModel: true, ...DEFAULT_INPUT_BUDGETS }),
    analyzers: z
      .record(stableId, analyzerConfig)
      .default(defaults)
      .transform((configs) => ({ ...defaults, ...configs })),
    editor: z
      .object({
        fontSize: z.number().min(14).max(24).default(18),
        spellcheck: z.boolean().default(true),
      })
      .default({ fontSize: 18, spellcheck: true }),
    general: z
      .object({ defaultProfile: stableId.default('general') })
      .default({ defaultProfile: 'general' }),
  })
  .superRefine((settings, ctx) => {
    const checkIds = (ids: string[], path: string) => {
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', path: [path], message: 'Duplicate or reserved IDs.' })
    }
    checkIds(
      settings.backends.map((b) => b.id),
      'backends',
    )
    checkIds(
      [...BUILTIN_ANALYZER_IDS, ...settings.customAnalyzers.map((a) => a.id)],
      'customAnalyzers',
    )
    checkIds(
      [...BUILTIN_PROFILE_IDS, ...settings.customProfiles.map((p) => p.id)],
      'customProfiles',
    )
    if (!settings.backends.some((b) => b.id === settings.defaultBackend))
      ctx.addIssue({
        code: 'custom',
        path: ['defaultBackend'],
        message: 'Choose an existing default backend.',
      })
    if (settings.backends.some((b) => b.id === 'default')) {
      try {
        normalizeBackendUrl(settings.ai.serverUrl)
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['ai', 'serverUrl'],
          message: 'Invalid Default backend URL.',
        })
      }
    }
    const knownAnalyzers: string[] = [
      ...BUILTIN_ANALYZER_IDS,
      ...settings.customAnalyzers.map((a) => a.id),
    ]
    for (const profile of settings.customProfiles) {
      if (profile.enabled.some((id) => !knownAnalyzers.includes(id)))
        ctx.addIssue({
          code: 'custom',
          path: ['customProfiles'],
          message: 'Profile refers to a missing analyzer.',
        })
    }
    const profileIds: string[] = [
      ...BUILTIN_PROFILE_IDS,
      ...settings.customProfiles.map((p) => p.id),
    ]
    if (!profileIds.includes(settings.general.defaultProfile))
      ctx.addIssue({ code: 'custom', path: ['general'], message: 'Default profile is missing.' })
  })
function migrate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const value = raw as Record<string, unknown>
  if (value.version !== undefined && value.version !== 1) return value
  const parsed = aiSchema.safeParse(value.ai === undefined ? {} : value.ai)
  if (!parsed.success) return { ...value, version: 2 }
  const ai = parsed.data
  return {
    ...value,
    version: 2,
    ai,
    backends: [legacyBackend(ai)],
    defaultBackend: 'default',
    customAnalyzers: [],
    customProfiles: [],
  }
}
export const settingsSchema = z.preprocess(migrate, schemaV2)
export type Settings = z.infer<typeof schemaV2>
export type EffectiveConfig = Settings['ai'] & {
  backendId?: string
  backendName?: string
  credentialRef?: string
}
export type InputBudgets = z.infer<typeof inputBudgetsSchema>
export function sameInputBudgets(a: InputBudgets, b: InputBudgets): boolean {
  return (
    a.paragraphInputChars === b.paragraphInputChars && a.documentInputChars === b.documentInputChars
  )
}
export function defaultSettings(): Settings {
  return structuredClone(settingsSchema.parse({}))
}
export function backendConfig(settings: Settings, id: string): EffectiveConfig {
  const backend = settings.backends.find((b) => b.id === id)
  if (!backend) throw new Error(`Backend “${id}” is missing. Choose a backend in Settings.`)
  const config = backend.id === 'default' ? settings.ai : backend
  return {
    serverUrl: normalizeBackendUrl(config.serverUrl),
    model: config.model.trim(),
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    credentialGeneration: config.credentialGeneration,
    backendId: backend.id,
    backendName: backend.name,
    credentialRef: backend.credentialRef,
  }
}
export function effectiveConfig(settings: Settings, analyzerId: string): EffectiveConfig {
  const config = backendConfig(
    settings,
    settings.analyzers[analyzerId]?.backend || settings.defaultBackend,
  )
  return { ...config, model: settings.analyzers[analyzerId]?.model.trim() || config.model }
}
// Display names/IDs are not inference input. Keep legacy cache/review hashes compatible.
export function inferenceConfig(
  config: EffectiveConfig,
): Settings['ai'] & { credentialRef?: string } {
  const options = { ...config }
  delete options.backendId
  delete options.backendName
  if (options.credentialRef === undefined || options.credentialRef === 'openai-compatible')
    delete options.credentialRef
  return options
}
export const configurationHash = (config: EffectiveConfig) =>
  hash(canonical(inferenceConfig(config)))

// Startup-only repair. Saving remains strict; bad entries never wipe good entries.
export function loadSettings(raw: unknown): {
  settings: Settings
  warnings: string[]
  migrated: boolean
} {
  const migrated = !!raw && typeof raw === 'object' && (raw as { version?: number }).version !== 2
  const data = structuredClone(migrate(raw)) as Record<string, unknown>
  const warnings: string[] = []
  if (!data || typeof data !== 'object')
    return { settings: settingsSchema.parse(data), warnings, migrated }
  const isolate = (key: string, schema: z.ZodType, reserved: readonly string[], limit: number) => {
    const used = new Set(reserved),
      result: unknown[] = []
    const entries = data[key] ?? []
    if (!Array.isArray(entries)) {
      warnings.push(`${key}: corrupt list ignored.`)
      data[key] = result
      return
    }
    for (const entry of entries.slice(0, limit)) {
      const parsed = schema.safeParse(entry)
      const id = parsed.success ? (parsed.data as { id: string }).id : ''
      if (!parsed.success || used.has(id)) {
        warnings.push(
          `${key}: invalid or duplicate entry “${typeof entry?.id === 'string' ? entry.id.slice(0, 64) : 'unknown'}” isolated.`,
        )
        continue
      }
      used.add(id)
      result.push(parsed.data)
    }
    if (entries.length > limit) warnings.push(`${key}: extra entries ignored (limit ${limit}).`)
    data[key] = result
  }
  isolate('customAnalyzers', customAnalyzerSchema, BUILTIN_ANALYZER_IDS, 40)
  isolate('customProfiles', customProfileSchema, BUILTIN_PROFILE_IDS, 40)
  isolate('backends', backendSchema, [], 20)
  const legacyFallback = (data.backends as Backend[]).find((b) => b.id === 'default') ?? aiDefaults
  if (data.ai === undefined) data.ai = aiSchema.parse(legacyFallback)
  const repairSection = (
    key: string,
    shape: Record<string, z.ZodType>,
    fallback: Record<string, unknown> = {},
  ) => {
    if (data[key] === undefined) return
    const raw = data[key]
    const object =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    if (object !== raw)
      warnings.push(`${key}: corrupt options repaired; original retained until Save settings.`)
    data[key] = Object.fromEntries(
      Object.entries(shape).map(([field, schema]) => {
        const parsed = schema.safeParse(
          key === 'ai' && object[field] === undefined ? fallback[field] : object[field],
        )
        if (parsed.success) return [field, parsed.data]
        warnings.push(
          `${key}.${field}: invalid option repaired; original retained until Save settings.`,
        )
        return [field, schema.parse(fallback[field])]
      }),
    )
  }
  repairSection('ai', aiSchema.shape, legacyFallback)
  for (const key of ['editor', 'analysis', 'general'] as const)
    repairSection(key, schemaV2.shape[key].unwrap().shape)
  let disableDefaultAI = false
  const ai = aiSchema.parse(data.ai ?? {})
  try {
    normalizeBackendUrl(ai.serverUrl)
  } catch {
    ai.serverUrl = legacyFallback.serverUrl
    disableDefaultAI = !(data.backends as Backend[]).some((b) => b.id === 'default')
    warnings.push(
      disableDefaultAI
        ? 'Invalid Default backend URL; default-routed AI reviewers disabled until reconfigured.'
        : 'Invalid Default backend URL; retained the saved Default backend address.',
    )
  }
  data.ai = ai
  if (!(data.backends as Backend[]).length) {
    data.backends = [legacyBackend(aiSchema.parse(data.ai ?? {}))]
    warnings.push('No valid backend remained; legacy Default retained.')
  }
  let disableInheritedAI = false
  if (!(data.backends as Backend[]).some((b) => b.id === data.defaultBackend)) {
    // Never redirect a formerly configured default's prose to a different server.
    const ai = aiSchema.parse(data.ai ?? {})
    if (
      !(data.backends as Backend[]).some((b) => b.id === 'default') &&
      (data.backends as Backend[]).length >= 20
    ) {
      data.defaultBackend = (data.backends as Backend[])[0].id
      disableInheritedAI = true
      warnings.push(
        'Missing default backend at the backend limit; inherited AI reviewers disabled until reconfigured. Existing backends retained.',
      )
    } else {
      if (!(data.backends as Backend[]).some((b) => b.id === 'default'))
        (data.backends as Backend[]).push(legacyBackend(ai))
      data.defaultBackend = 'default'
      warnings.push(
        'Missing default backend: retained legacy Default. Review AI settings before analysis.',
      )
    }
  }
  const profiles = [
    ...BUILTIN_PROFILE_IDS,
    ...(data.customProfiles as { id: string }[]).map((p) => p.id),
  ]
  const general = data.general as { defaultProfile?: string } | undefined
  if (general?.defaultProfile && !profiles.includes(general.defaultProfile)) {
    data.general = { ...general, defaultProfile: 'general' }
    warnings.push('Missing default profile: General prose selected.')
  }
  if (data.analyzers !== undefined) {
    const configs: Record<string, z.infer<typeof analyzerConfig>> = {}
    const entries =
      data.analyzers && typeof data.analyzers === 'object' && !Array.isArray(data.analyzers)
        ? Object.entries(data.analyzers)
        : []
    for (const [id, entry] of entries) {
      const parsed = analyzerConfig.safeParse(entry)
      if (!stableId.safeParse(id).success) {
        warnings.push('Invalid analyzer settings ID ignored.')
        continue
      }
      configs[id] = parsed.success ? parsed.data : { enabled: false, model: '' }
      if (!parsed.success) warnings.push(`${id}: corrupt analyzer options disabled.`)
      if (
        configs[id].backend &&
        !(data.backends as Backend[]).some((b) => b.id === configs[id].backend)
      ) {
        configs[id].enabled = false
        warnings.push(`${id}: missing backend; analyzer disabled until reconfigured.`)
      }
    }
    if (!data.analyzers || typeof data.analyzers !== 'object' || Array.isArray(data.analyzers))
      warnings.push('Corrupt analyzer options isolated.')
    data.analyzers = configs
  }
  const ids: string[] = [
    ...BUILTIN_ANALYZER_IDS,
    ...(data.customAnalyzers as { id: string }[]).map((a) => a.id),
  ]
  for (const profile of data.customProfiles as z.infer<typeof customProfileSchema>[]) {
    const enabled = profile.enabled.filter((id) => ids.includes(id))
    if (enabled.length !== profile.enabled.length)
      warnings.push(`${profile.name}: missing analyzer memberships removed.`)
    profile.enabled = enabled
  }
  if (disableDefaultAI || disableInheritedAI) {
    const configs = (data.analyzers ?? {}) as Record<string, z.infer<typeof analyzerConfig>>
    for (const id of ids.filter((id) => id !== 'harper' && id !== 'repeated-word')) {
      if (
        (disableDefaultAI && (configs[id]?.backend || data.defaultBackend) === 'default') ||
        (disableInheritedAI && !configs[id]?.backend)
      )
        configs[id] = { ...configs[id], enabled: false, model: configs[id]?.model ?? '' }
    }
    data.analyzers = configs
  }
  const settings = settingsSchema.parse(data)
  return { settings, warnings, migrated }
}
