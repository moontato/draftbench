import { repeatedWord } from './builtin/repeatedWord'
import { harper } from './builtin/harper'
import { customAnalyzer } from './llm/custom'
import type { Settings } from '../settings/model'
import { clarity, semanticAnalyzer } from './llm/semantic'
export const ambiguousReference = semanticAnalyzer(
  {
    id: 'ambiguous-reference',
    name: 'Ambiguous reference',
    preferredScope: 'nearby',
    scopes: ['selection', 'block', 'document'],
    description: 'Unclear antecedents for it, this, that, they, these, those, former, or latter.',
  },
  'Detect only meaningful reference ambiguity: a reader cannot tell what a pronoun or demonstrative refers to, or multiple plausible antecedents exist. Use nearby context to avoid false positives. Do not flag a reference whose meaning is clear from context. Use category ambiguous-reference.',
)
export const redundancy = semanticAnalyzer(
  {
    id: 'redundancy',
    name: 'Redundancy',
    preferredScope: 'document',
    scopes: ['document'],
    description: 'Nearby or document-level repetition of ideas and claims, not vocabulary.',
  },
  'Review semantic repetition of ideas or claims across the supplied document. Repetition for emphasis, useful reminders, or shared vocabulary is not automatically redundant. Quote one exact single-block passage that unnecessarily repeats an earlier point, and explain its relationship to the earlier passage. Use category redundancy.',
)
export const development = semanticAnalyzer(
  {
    id: 'development',
    name: 'Development',
    preferredScope: 'document',
    scopes: ['document'],
    profileAware: true,
    description:
      'Specificity, paragraph development, reasoning, support, and connections between claims.',
  },
  'Review how well the writing develops its ideas: report generic or underdeveloped claims, missing support or examples, weak connections between points, and reasoning that stops short of its conclusion. Use severity warning for reader-facing problems and severity suggestion or info for strengthening opportunities. Each finding must quote one exact affected block, explain the concrete effect on the reader, and choose a safe single-block replacement when one clearly exists, otherwise concise revision guidance or a focused question. Do not prescribe a formulaic structure, do not praise the writing, and suppress generic advice. Use category development.',
)
export const structure = semanticAnalyzer(
  {
    id: 'structure',
    name: 'Structure',
    preferredScope: 'document',
    scopes: ['document'],
    profileAware: true,
    description:
      'Paragraph purpose, disconnected material, weak transitions, and unfulfilled promises.',
  },
  'Review paragraph and document organization: paragraphs with no clear function, disconnected material, unclear transitions, conclusions introducing a major new argument, or promised topics not addressed. Do not prescribe a formulaic outline. Quote a single affected block and describe the structural issue. Leave replacement null for cross-paragraph or document-wide changes. Use category structure.',
)
export const analyzers = [
  repeatedWord,
  clarity,
  ambiguousReference,
  redundancy,
  structure,
  development,
  harper,
]
export function createAnalyzerRegistry(settings: Settings) {
  return [...analyzers, ...settings.customAnalyzers.map(customAnalyzer)]
}
