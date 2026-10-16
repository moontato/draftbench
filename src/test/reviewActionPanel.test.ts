import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProblemsPanel } from '../diagnostics/ProblemsPanel'
import { defaultFindingFilters } from '../diagnostics/filters'
import { resolveIssue } from '../diagnostics/mapping'
import { evalSnapshot } from '../eval/harness'
import { development, analyzers } from '../analyzers/registry'
import { reviewContextFor } from '../profiles/reviewContext'
import type { ReviewAction } from '../diagnostics/types'

let root: Root, container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render(action: ReviewAction, needsRerun?: 'genre' | 'disabled') {
  const input = evalSnapshot('The point is unclear.'),
    block = input.blocks[0]
  const finding = resolveIssue(
    {
      block_id: block.id,
      quote: block.text,
      category: 'development',
      severity: 'suggestion',
      message: 'Develop this point.',
      explanation: 'The connection to the conclusion is not explained.',
      action,
      replacement: action === 'replace' ? 'The proposal is unclear.' : undefined,
      guidance:
        action === 'question'
          ? 'Which result do you mean?'
          : action === 'guide'
            ? 'Name the result and connect it to your conclusion.'
            : undefined,
    },
    input,
    development.id,
    development.version,
    { kind: 'ai', name: 'Test' },
    'config',
    { [block.id]: block.hash },
    reviewContextFor(development, 'essay'),
  )!
  await act(async () =>
    root.render(
      createElement(ProblemsPanel, {
        findings: [{ ...finding, needsRerun }],
        visible: [{ ...finding, needsRerun }],
        filters: defaultFindingFilters,
        onFilters: vi.fn(),
        selected: finding.id,
        dismissed: new Set<string>(),
        analyzers,
        busy: false,
        status: '',
        hasDocument: true,
        canApply: true,
        onSelect: vi.fn(),
        onApply: vi.fn(),
        onDismiss: vi.fn(),
        onResetDismissed: vi.fn(),
        onRun: vi.fn(),
        onSettings: vi.fn(),
        onHistory: vi.fn(),
      }),
    ),
  )
}
it.each(['guide', 'question'] as const)(
  'renders %s feedback as text without an Apply button',
  async (action) => {
    await render(action)
    expect(container.textContent).toContain(
      action === 'question' ? 'A QUESTION FOR YOU' : 'REVISION GUIDANCE',
    )
    expect(container.querySelector('.inspector-body .source-review')?.textContent).toBe(
      action === 'question'
        ? 'Which result do you mean?'
        : 'Name the result and connect it to your conclusion.',
    )
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Apply suggestion'),
      ),
    ).toBe(false)
  },
)
it('still offers a reviewed diff and Apply for replacement findings', async () => {
  await render('replace')
  expect(container.querySelector('.replacement-review')?.textContent).toContain('proposal')
  expect(
    [...container.querySelectorAll('button')].some((button) =>
      button.textContent?.includes('Apply suggestion'),
    ),
  ).toBe(true)
})
it('identifies the originating profile and does not promise disabled reviews disappear on analysis', async () => {
  await render('guide', 'disabled')
  const note = container.querySelector('.inspector-body [role="note"]')?.textContent
  expect(note).toContain('Originally reviewed for: essay')
  expect(note).toContain('remains visible')
  expect(note).not.toContain('will clear when you reanalyze')
})
