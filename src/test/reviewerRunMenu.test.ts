import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReviewerRunMenu } from '../app/ReviewerRunMenu'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { defaultSettings } from '../settings/model'
import { analyzerEnabled, globallyEnabled } from '../profiles/profiles'

type Props = ComponentProps<typeof ReviewerRunMenu>
let root: Root,
  container: HTMLDivElement,
  settings = defaultSettings(),
  profile = 'general'
const onRun = vi.fn()
let overrides: Partial<Props>
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  settings = defaultSettings()
  profile = 'general'
  onRun.mockReset()
  overrides = {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render(changes: Partial<Props> = {}) {
  overrides = { ...overrides, ...changes }
  const props: Props = {
    analyzers: createAnalyzerRegistry(settings),
    enabled: (id) => analyzerEnabled(settings, id, profile),
    globallyEnabled: (id) => globallyEnabled(settings, id),
    hasDocument: true,
    busy: false,
    onRun,
    ...overrides,
  }
  await act(async () =>
    root.render(
      createElement(
        'div',
        {
          onClick: () => {
            const menu = container.querySelector('details')
            if (menu) menu.open = false
          },
        },
        createElement(ReviewerRunMenu, props),
      ),
    ),
  )
}
function checkbox(name: string) {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
}
function button(text: string) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === text)!
}
async function click(element: HTMLElement) {
  await act(async () => element.click())
}
async function scope(value: string) {
  await act(async () => {
    const select = container.querySelector('select')!
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
it('starts with profile defaults and checking multiple boxes does not run or close the menu', async () => {
  await render()
  expect(button('Run selected (6)').disabled).toBe(false)
  expect(checkbox('Harper').disabled).toBe(true)
  const menu = container.querySelector('details')!
  menu.open = true
  await click(button('Clear'))
  expect(button('Run selected (0)').disabled).toBe(true)
  await click(checkbox('Clarity'))
  await click(checkbox('Ambiguous reference'))
  expect(menu.open).toBe(true)
  expect(button('Run selected (2)').disabled).toBe(false)
  expect(onRun).not.toHaveBeenCalled()
  await click(button('Run selected (2)'))
  expect(onRun).toHaveBeenCalledExactlyOnceWith(
    'document',
    ['clarity', 'ambiguous-reference'],
    false,
  )
  expect(menu.open).toBe(false)
  expect(document.activeElement).toBe(menu.querySelector('summary'))
})
it('Clear stays empty across scope changes and cannot fall back to running everyone', async () => {
  await render()
  await click(button('Clear'))
  await scope('block')
  expect(button('Run selected (0)').disabled).toBe(true)
  await click(button('Run selected (0)'))
  await scope('document')
  expect(checkbox('Clarity').checked).toBe(false)
  expect(onRun).not.toHaveBeenCalled()
})
it('Select all respects scope and enablement; force is separate and never starts a run', async () => {
  await render()
  await scope('block')
  expect(checkbox('Development').disabled).toBe(true)
  expect(checkbox('Development').checked).toBe(false)
  expect(checkbox('Structure').disabled).toBe(true)
  expect(container.textContent).toContain('Document only')
  await click(button('Clear'))
  await click(button('Select all'))
  const force = container.querySelector<HTMLInputElement>('.reviewer-run-force input')!
  await click(force)
  expect(onRun).not.toHaveBeenCalled()
  await click(button('Run selected (3)'))
  expect(onRun).toHaveBeenCalledExactlyOnceWith(
    'block',
    ['repeated-word', 'clarity', 'ambiguous-reference'],
    true,
  )
})
it('remembers explicit selections across documents and profile changes without running unavailable reviewers', async () => {
  await render()
  await click(button('Clear'))
  await click(checkbox('Clarity'))
  await click(checkbox('Structure'))
  await render({ hasDocument: false })
  expect(container.querySelector('details')).toBeNull()
  profile = 'email'
  await render({ hasDocument: true })
  expect(checkbox('Clarity').checked).toBe(true)
  expect(checkbox('Structure').checked).toBe(false)
  expect(checkbox('Structure').disabled).toBe(true)
  expect(button('Run selected (1)').disabled).toBe(false)
  profile = 'essay'
  await render()
  expect(checkbox('Structure').checked).toBe(true)
  expect(button('Run selected (2)').disabled).toBe(false)
  expect(onRun).not.toHaveBeenCalled()
})
it('allows explicit custom reviewers outside the profile and distinguishes duplicate names', async () => {
  settings.customAnalyzers.push({
    id: 'custom-clarity',
    name: 'Clarity',
    description: '',
    enabled: true,
    scope: 'selection',
    instructions: 'Review selected text.',
    severity: 'warning',
  })
  await render()
  expect(checkbox('Clarity (clarity)').checked).toBe(true)
  expect(checkbox('Clarity (custom-clarity)').disabled).toBe(true)
  await scope('selection')
  expect(checkbox('Clarity (custom-clarity)').disabled).toBe(false)
  expect(checkbox('Clarity (custom-clarity)').checked).toBe(false)
  await click(button('Clear'))
  await click(checkbox('Clarity (custom-clarity)'))
  await click(button('Run selected (1)'))
  expect(onRun).toHaveBeenCalledExactlyOnceWith('selection', ['custom-clarity'], false)
})
it('forgets deleted reviewer IDs rather than selecting a newly created task with the same ID', async () => {
  const definition = {
    id: 'my-reviewer',
    name: 'My reviewer',
    description: '',
    enabled: true,
    scope: 'document' as const,
    instructions: 'Review paragraphs.',
    severity: 'warning' as const,
  }
  settings.customAnalyzers.push(definition)
  await render()
  await click(button('Clear'))
  await click(checkbox('My reviewer'))
  settings.customAnalyzers = []
  await render()
  settings.customAnalyzers.push(definition)
  await render()
  expect(checkbox('My reviewer').checked).toBe(false)
  expect(button('Run selected (0)').disabled).toBe(true)
})
it('busy controls cannot change choices or trigger another run', async () => {
  await render({ busy: true })
  expect(container.querySelector('select')!.disabled).toBe(true)
  expect(checkbox('Clarity').disabled).toBe(true)
  expect(button('Clear').disabled).toBe(true)
  expect(button('Select all').disabled).toBe(true)
  expect(button('Run selected (6)').disabled).toBe(true)
  await click(checkbox('Clarity'))
  await click(button('Run selected (6)'))
  expect(onRun).not.toHaveBeenCalled()
})
it('Escape closes the menu and returns focus to its summary', async () => {
  await render()
  const menu = container.querySelector('details')!
  menu.open = true
  checkbox('Clarity').focus()
  await act(async () =>
    checkbox('Clarity').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  )
  expect(menu.open).toBe(false)
  expect(document.activeElement).toBe(menu.querySelector('summary'))
  expect(onRun).not.toHaveBeenCalled()
})
