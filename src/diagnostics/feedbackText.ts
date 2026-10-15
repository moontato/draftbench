/** Avoid repeating an identical reviewer message without hiding additional detail. */
export function hasDistinctExplanation(message: string, explanation: string): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
  return !!normalize(explanation) && normalize(message) !== normalize(explanation)
}
