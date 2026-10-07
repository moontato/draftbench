import { canonical, hash } from './hash'
import type { Diagnostic, EngineMetadata, Issue, Snapshot } from './types'
export function resolveIssue(
  issue: Issue,
  input: Snapshot,
  analyzerId: string,
  version: string,
  engine: EngineMetadata,
  configurationHash: string,
  dependencies: Record<string, string>,
): Diagnostic | null {
  const block = input.blocks.find((b) => b.id === issue.block_id)
  if (!block || !issue.quote) return null
  const trustedOffset = engine.kind === 'deterministic' && issue.offset !== undefined
  let start = trustedOffset ? issue.offset! : -1
  if (!trustedOffset) {
    const matches: number[] = []
    for (
      let at = block.text.indexOf(issue.quote);
      at >= 0;
      at = block.text.indexOf(issue.quote, at + 1)
    ) {
      const from = block.positions[at],
        to = block.positions[at + issue.quote.length]
      if (!input.selection || (from >= input.selection.from && to <= input.selection.to))
        matches.push(at)
    }
    if (matches.length !== 1) return null
    start = matches[0]
  }
  if (start < 0 || block.text.slice(start, start + issue.quote.length) !== issue.quote) return null
  // Never attach a model quote to one half of a Unicode surrogate pair.
  const splitsPair = (index: number) =>
    index > 0 &&
    index < block.text.length &&
    /[\uD800-\uDBFF]/.test(block.text[index - 1]) &&
    /[\uDC00-\uDFFF]/.test(block.text[index])
  if (splitsPair(start) || splitsPair(start + issue.quote.length)) return null
  const end = start + issue.quote.length
  const from = block.positions[start],
    to = block.positions[end]
  if (from === undefined || to === undefined || to <= from) return null
  if (input.selection && (from < input.selection.from || to > input.selection.to)) return null
  return {
    ...issue,
    id: hash(
      [
        input.documentId,
        analyzerId,
        version,
        configurationHash,
        block.id,
        block.hash,
        start,
        canonical(dependencies),
        issue.category,
        issue.severity,
        issue.message,
        issue.explanation,
        issue.replacement ?? '',
      ].join('|'),
    ),
    analyzerId,
    analyzerVersion: version,
    documentId: input.documentId,
    blockId: block.id,
    start,
    end,
    from,
    to,
    blockIndex: block.order,
    revision: input.revision,
    contentHash: input.hash,
    blockHash: block.hash,
    dependencies,
    engine,
    configurationHash,
  }
}
export function refreshDiagnostic(finding: Diagnostic, current: Snapshot): Diagnostic | null {
  if (finding.documentId !== current.documentId) return null
  const blocks = new Map(current.blocks.map((b) => [b.id, b]))
  const block = blocks.get(finding.blockId)
  if (
    !block ||
    block.hash !== finding.blockHash ||
    block.text.slice(finding.start, finding.end) !== finding.quote
  )
    return null
  if (
    Object.entries(finding.dependencies).some(
      ([id, fingerprint]) => !id.startsWith('$') && blocks.get(id)?.hash !== fingerprint,
    )
  )
    return null
  if (finding.dependencies.$document && finding.dependencies.$document !== current.hash) return null
  for (const [key, fingerprint] of Object.entries(finding.dependencies)) {
    if (!key.startsWith('$neighbors:')) continue
    const target = blocks.get(key.slice('$neighbors:'.length))
    if (!target) return null
    const neighbors = current.blocks.filter((b) => Math.abs(b.order - target.order) === 1)
    if (hash(JSON.stringify(neighbors.map((b) => [b.id, b.hash]))) !== fingerprint) return null
  }
  const from = block.positions[finding.start],
    to = block.positions[finding.end]
  if (from === undefined || to === undefined) return null
  return { ...finding, from, to, blockIndex: block.order }
}
