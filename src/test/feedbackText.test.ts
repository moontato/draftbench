import { expect, it } from 'vitest'
import { hasDistinctExplanation } from '../diagnostics/feedbackText'

it('suppresses repeated messages, including whitespace differences and empty details', () => {
  expect(hasDistinctExplanation('Use could have.', 'Use could have.')).toBe(false)
  expect(hasDistinctExplanation('Use could have.', ' Use   could have.\n')).toBe(false)
  expect(hasDistinctExplanation('Use could have.', '  ')).toBe(false)
})
it('retains additional explanation rather than hiding similar but useful feedback', () => {
  expect(
    hasDistinctExplanation('Use could have.', 'Use could have. This expresses possibility.'),
  ).toBe(true)
})
