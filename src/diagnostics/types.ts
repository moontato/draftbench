export type Severity = 'info' | 'suggestion' | 'warning' | 'error'
export type Scope = 'selection' | 'block' | 'document'
/** How a finding should be resolved: a safe rewrite, guidance, or a question for the author. */
export type ReviewAction = 'replace' | 'guide' | 'question'
export function effectiveAction(issue: Pick<Issue, 'action' | 'replacement'>): ReviewAction {
  return issue.action ?? (issue.replacement !== undefined ? 'replace' : 'guide')
}
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
  backend?: string
  backendId?: string
}
export interface ReviewContext {
  /** The profile at review time, retained even when the current profile changes. */
  profile: string
  /** Fingerprint of the actual genre policy supplied to this reviewer. */
  policyHash: string
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
  action: ReviewAction
  replacement?: string
  replacements?: string[]
  guidance?: string
  confidence?: number
  revision: number
  contentHash: string
  blockHash: string
  dependencies: Record<string, string>
  engine: EngineMetadata
  configurationHash: string
  reviewContext?: ReviewContext
  /** Original AI input budgets; restoration/Undo must not erase compatibility checks. */
  reviewInputBudgets?: { paragraphInputChars: number; documentInputChars: number }
  /** The quote is intact, but edits changed the original analysis context. */
  contextChanged?: boolean
  /** Transaction-mapped reference feedback after manual edits; never applicable until reviewed again. */
  stale?: boolean
  /** Immutable original analysis snapshot; rebasing must not redefine when a finding was reviewed. */
  reviewOrigin?: Omit<Diagnostic, 'reviewOrigin'>
  /** The finding comes from a review context that no longer matches the writing profile.
   *  `genre`: the reviewer still applies but now uses profile-specific guidance;
   *  `disabled`: the reviewer is not enabled in the current profile at all;
   *  `reviewer`: the reviewer version or inference settings have changed. */
  needsRerun?: 'genre' | 'disabled' | 'reviewer'
}
export interface Issue {
  block_id: string
  quote: string
  category: string
  severity: Severity
  message: string
  explanation: string
  action?: ReviewAction
  replacement?: string
  replacements?: string[]
  guidance?: string
  confidence?: number
  offset?: number
}
