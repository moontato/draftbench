import type { EffectiveConfig } from '../settings/model'
export type FailureKind =
  | 'configuration'
  | 'unreachable'
  | 'timeout'
  | 'authentication'
  | 'unsupported'
  | 'model'
  | 'malformed'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'cancelled'
  | 'format_unsupported'
export class ProviderError extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
    public status?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
export interface ConnectionResult {
  message: string
  models: string[]
}
export interface StructuredRequest {
  system: string
  user: string
  schema: Record<string, unknown>
}
export interface AIProvider {
  testConnection(config: EffectiveConfig, signal?: AbortSignal): Promise<ConnectionResult>
  listModels(config: EffectiveConfig, signal?: AbortSignal): Promise<string[]>
  completeStructured(
    request: StructuredRequest,
    config: EffectiveConfig,
    signal: AbortSignal,
  ): Promise<unknown>
}
