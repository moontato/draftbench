import type { EffectiveConfig } from '../settings/model'
import type { Block, Issue, Scope, Snapshot } from '../diagnostics/types'
import type { AIProvider } from '../ai/types'
export interface AnalysisUnit {
  targets: Block[]
  context: Block[]
  documentScope: boolean
}
export interface AnalyzerContext {
  input: Snapshot
  unit: AnalysisUnit
  config: EffectiveConfig
  provider: AIProvider
  signal: AbortSignal
  scope: Scope
  priorState?: unknown
}
export interface AnalyzerResult {
  issues: Issue[]
  warnings: string[]
}
export interface Analyzer {
  id: string
  version: string
  name: string
  description: string
  engine: 'deterministic' | 'ai'
  preferredScope: 'paragraph' | 'nearby' | 'document'
  scopes: Scope[]
  analyze(context: AnalyzerContext): Promise<AnalyzerResult>
}
