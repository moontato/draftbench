import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import type { Analyzer } from '../types'
import { AnalysisJobs } from '../jobs'
import { maskRanges, maskedRanges, overlaps } from '../../diagnostics/proseMask'
// Native lints cannot be interrupted mid-call. Share one CPU lane across automatic
// and manual checks, and remove obsolete queued calls before they reach IPC.
const grammarJobs = new AnalysisJobs(1)

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
  formatSensitive: true,
  async analyze({ unit, signal }) {
    const issues = [],
      warnings: string[] = []
    let skipped = 0
    for (const block of unit.targets) {
      if (signal.aborted) throw new Error('Analysis cancelled.')
      // Inline code is not prose. Mask it at identical UTF-16 length so every offset
      // Harper returns still indexes the original block text: no re-searching, no
      // reattachment to a nearby occurrence, and no diagnostic can land on code.
      const ranges = maskedRanges(block.text, block.codeRanges ?? []),
        masked = maskRanges(block.text, block.codeRanges ?? [])
      const raw = await grammarJobs.run(signal, () =>
        invoke<unknown>('harper_review', { text: masked }),
      )
      if (signal.aborted) throw new Error('Analysis cancelled.')
      const findings = z.array(findingSchema).max(501).parse(raw)
      if (findings.length > 500)
        warnings.push(
          'Harper: paragraph has more than 500 findings. Showing the first 500; review a smaller passage before saving a complete review.',
        )
      for (const finding of findings.slice(0, 500)) {
        const end = finding.offset + finding.quote.length
        if (masked.slice(finding.offset, end) !== finding.quote)
          throw new Error('Harper returned an invalid source offset.')
        // Anything touching masked code text is discarded, including whitespace lints
        // the adapter widened into a code span.
        if (overlaps(ranges, finding.offset, end)) {
          skipped++
          continue
        }
        const quote = block.text.slice(finding.offset, end)
        // The accepted quote must be the real source text, never the mask.
        if (quote !== finding.quote || !quote.trim()) {
          skipped++
          continue
        }
        issues.push({
          ...finding,
          quote,
          block_id: block.id,
          replacement: finding.replacement ?? undefined,
        })
      }
    }
    if (skipped)
      warnings.push(
        `Harper skipped ${skipped} diagnostic${skipped === 1 ? '' : 's'} inside inline code.`,
      )
    return { issues, warnings }
  },
}
