import type { Analyzer } from '../types'
export const repeatedWord: Analyzer = {
  id: 'repeated-word',
  version: '1',
  name: 'Repeated word',
  engine: 'deterministic',
  preferredScope: 'paragraph',
  scopes: ['selection', 'block', 'document'],
  description: 'Find accidental adjacent repeated words. Runs locally; no AI.',
  async analyze({ unit }) {
    const issues = []
    for (const block of unit.targets) {
      const matches = block.text.matchAll(
        /(?<![\p{L}\p{N}_])([\p{L}]+)[ \t]+\1(?![\p{L}\p{N}_])/giu,
      )
      for (const match of matches) {
        if (['had', 'that', 'bye', 'very'].includes(match[1].toLowerCase())) continue
        issues.push({
          block_id: block.id,
          quote: match[0],
          offset: match.index,
          category: 'repetition',
          severity: 'warning' as const,
          message: `“${match[1]}” appears twice in a row.`,
          explanation: 'This may be an accidental duplicate. Review it before removing a word.',
          replacement: match[1],
          confidence: 1,
        })
      }
    }
    return { issues, warnings: [] }
  },
}
