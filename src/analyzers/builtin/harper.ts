import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import type { Analyzer } from '../types'

const findingSchema = z.object({
  offset: z.number().int().nonnegative(),
  quote: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(['info', 'suggestion', 'warning', 'error']),
  message: z.string().min(1),
  explanation: z.string(),
  replacement: z.string().nullable(),
  replacements: z.array(z.string()).max(8),
  confidence: z.number().min(0).max(1),
})
export const harper: Analyzer = {
  id: 'harper',
  version: 'adapter-1-harper-2.11.0',
  name: 'Harper',
  engine: 'deterministic',
  engineName: 'Harper 2.11.0 · offline',
  description:
    'Offline English grammar/style review. American English; spelling and duplicate words are left to the existing checks.',
  preferredScope: 'paragraph',
  scopes: ['selection', 'block', 'document'],
  async analyze({ unit, signal }) {
    const issues = [],
      warnings: string[] = []
    for (const block of unit.targets) {
      if (signal.aborted) throw new Error('Analysis cancelled.')
      const raw = await invoke<unknown>('harper_review', { text: block.text })
      if (signal.aborted) throw new Error('Analysis cancelled.')
      const findings = z.array(findingSchema).max(501).parse(raw)
      if (findings.length > 500)
        warnings.push(
          'Harper: paragraph has more than 500 findings. Showing the first 500; review a smaller passage before saving a complete review.',
        )
      for (const finding of findings.slice(0, 500)) {
        if (
          block.text.slice(finding.offset, finding.offset + finding.quote.length) !== finding.quote
        )
          throw new Error('Harper returned an invalid source offset.')
        issues.push({
          ...finding,
          block_id: block.id,
          replacement: finding.replacement ?? undefined,
        })
      }
    }
    return { issues, warnings }
  },
}
