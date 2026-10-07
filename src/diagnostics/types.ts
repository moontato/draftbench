export type Severity = 'info' | 'suggestion' | 'warning' | 'error'
export type Scope = 'selection' | 'block' | 'document'
export interface Block {
  id: string
  type: string
  text: string
  hash: string
  from: number
  to: number
  positions: number[]
  order: number
  headingLevel?: number
  ancestors?: string[]
}
export interface Snapshot {
  documentId: string
  revision: number
  hash: string
  blocks: Block[]
  selection?: { from: number; to: number }
  caret?: number
}
export interface EngineMetadata {
  kind: 'deterministic' | 'ai'
  name: string
  server?: string
  model?: string
}
export interface Diagnostic {
  id: string
  analyzerId: string
  analyzerVersion: string
  category: string
  severity: Severity
  message: string
  explanation: string
  documentId: string
  blockId: string
  quote: string
  start: number
  end: number
  from: number
  to: number
  blockIndex: number
  replacement?: string
  confidence?: number
  revision: number
  contentHash: string
  blockHash: string
  dependencies: Record<string, string>
  engine: EngineMetadata
  configurationHash: string
}
export interface Issue {
  block_id: string
  quote: string
  category: string
  severity: Severity
  message: string
  explanation: string
  replacement?: string
  confidence?: number
  offset?: number
}
