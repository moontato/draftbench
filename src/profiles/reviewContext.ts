import type { Analyzer } from '../analyzers/types'
import type { Diagnostic, ReviewContext, Snapshot } from '../diagnostics/types'
import { refreshDiagnostic } from '../diagnostics/mapping'
import { hash } from '../diagnostics/hash'
import { configurationHash, effectiveConfig, type Settings } from '../settings/model'
import { analyzerEnabled, globallyEnabled } from './profiles'

// Genre policy is inference input, not merely a profile label. Hash the actual
// policy so edits invalidate caches and saved reviews even if the profile ID stays put.
export const genrePolicies: Readonly<Record<string, string>> = {
  general:
    'The writing is general prose: judge clarity, specificity, and reader comprehension without imposing an essay formula or prescribed outline.',
  technical:
    'The writing is technical: judge precise explanation, unstated prerequisites, terminology, and whether the reader can act on the instructions.',
  essay:
    'The writing may be an argumentative essay or a personal statement. For an argument, judge development, coherence, and support. For a personal statement, judge concrete experience, reflection, and connections to the stated goal without demanding an argumentative thesis or invented anecdotes. Do not assume one specific essay format.',
}
export function genrePolicyFor(analyzer: Pick<Analyzer, 'profileAware'>, profile: string): string {
  return analyzer.profileAware && Object.hasOwn(genrePolicies, profile)
    ? genrePolicies[profile]
    : ''
}
export function reviewContextFor(
  analyzer: Pick<Analyzer, 'profileAware'>,
  profile = 'general',
): ReviewContext {
  return { profile, policyHash: hash(genrePolicyFor(analyzer, profile)) }
}
export function reviewContextMatches(
  finding: Diagnostic,
  analyzer: Analyzer,
  profile: string,
): boolean {
  return (
    !analyzer.profileAware ||
    finding.reviewContext?.policyHash === reviewContextFor(analyzer, profile).policyHash
  )
}

// Run this after profile changes AND history restoration. Journal snapshots retain
// the originating context; their old display flags must never override current compatibility.
export function reconcileReviewContexts(
  findings: Diagnostic[],
  analyzers: Analyzer[],
  settings: Settings,
  profile: string,
  input?: Snapshot | null,
): Diagnostic[] {
  return findings.flatMap((finding) => {
    const fresh = input ? refreshDiagnostic(finding, input) : finding
    if (!fresh) return []
    const analyzer = analyzers.find((a) => a.id === fresh.analyzerId)
    const rest = { ...fresh }
    delete rest.needsRerun
    const enabled =
      analyzerEnabled(settings, fresh.analyzerId, profile) ||
      // Custom reviewers may be explicitly run outside preset membership. That
      // request remains valid in its original profile, but does not broaden others.
      (analyzer?.origin === 'custom' &&
        globallyEnabled(settings, fresh.analyzerId) &&
        fresh.reviewContext?.profile === profile)
    if (!analyzer || !enabled) return [{ ...rest, needsRerun: 'disabled' as const }]
    if (
      analyzer.version !== fresh.analyzerVersion ||
      (analyzer.engine === 'ai' &&
        fresh.configurationHash !== configurationHash(effectiveConfig(settings, analyzer.id)))
    )
      return [{ ...rest, needsRerun: 'reviewer' as const }]
    if (!reviewContextMatches(fresh, analyzer, profile))
      return [{ ...rest, needsRerun: 'genre' as const }]
    return [rest]
  })
}
