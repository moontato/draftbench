import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLocalAnalysis } from '../app/useLocalAnalysis'
import { AnalysisCache } from '../analyzers/cache'
import { defaultSettings, type Settings } from '../settings/model'
import { hash } from '../diagnostics/hash'
import type { Diagnostic, Snapshot } from '../diagnostics/types'
import type { Analyzer, AnalyzerResult } from '../analyzers/types'
import type { AIProvider } from '../ai/types'

const harper: Analyzer = {
  id: 'harper',
  name: 'Harper',
  version: 'test-1',
  engine: 'deterministic',
  description: '',
  preferredScope: 'paragraph',
  scopes: ['document', 'block', 'selection'],
  analyze: vi.fn(),
}
const repeated: Analyzer = {
  ...harper,
  id: 'repeated-word',
  name: 'Repeated word',
  analyze: vi.fn(),
}
const ai: Analyzer = { ...harper, id: 'clarity', name: 'Clarity', engine: 'ai', analyze: vi.fn() }
const analyzers = [repeated, harper, ai]
const provider: AIProvider = {
  completeStructured: vi.fn(),
  testConnection: vi.fn(),
  listModels: vi.fn(),
}
const showNotice = vi.fn()
let root: Root, settings: Settings, current: Snapshot, findings: Diagnostic[]
let liveInput: { current: Snapshot | null }
function input(text = 'Original phrase.'): Snapshot {
  return {
    documentId: 'doc',
    revision: 0,
    hash: hash(text),
    blocks: [
      {
        id: 'block',
        type: 'paragraph',
        text,
        hash: hash(text),
        order: 0,
        from: 1,
        to: text.length + 1,
        positions: Array.from({ length: text.length + 1 }, (_, index) => index + 1),
      },
    ],
  }
}
function result(snapshot: Snapshot): AnalyzerResult {
  const block = snapshot.blocks[0]
  return {
    issues: [
      {
        block_id: block.id,
        offset: 0,
        quote: block.text,
        replacement: 'Better phrase.',
        category: 'harper-grammar',
        severity: 'warning',
        message: 'Check this phrase.',
        explanation: 'Use clearer wording.',
      },
    ],
    warnings: [],
  }
}
function Harness({ settings, current }: { settings: Settings; current: Snapshot }) {
  const [items, setFindings] = useState<Diagnostic[]>([])
  findings = items
  const currentRef = useRef(current),
    cache = useRef(new AnalysisCache()),
    providerRef = useRef(provider)
  currentRef.current = current
  liveInput = currentRef
  useLocalAnalysis({
    current,
    currentRef,
    settings,
    profile: 'general',
    analyzers,
    cache,
    provider: providerRef,
    setFindings,
    showNotice,
  })
  return null
}
async function render() {
  await act(async () => root.render(createElement(Harness, { settings, current })))
}
async function debounce() {
  await act(async () => vi.advanceTimersByTimeAsync(350))
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  settings = defaultSettings()
  settings.analyzers.harper.enabled = true
  current = input()
  findings = []
  vi.mocked(harper.analyze).mockImplementation(async () => result(current))
  vi.mocked(repeated.analyze).mockResolvedValue({ issues: [], warnings: [] })
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
})
it('keeps automatic Harper off by default while Repeated word continues and AI never runs', async () => {
  await render()
  await debounce()
  expect(repeated.analyze).toHaveBeenCalledTimes(1)
  expect(harper.analyze).not.toHaveBeenCalled()
  expect(ai.analyze).not.toHaveBeenCalled()
  expect(provider.completeStructured).not.toHaveBeenCalled()
  current = input('Changed phrase.')
  await render()
  await debounce()
  expect(repeated.analyze).toHaveBeenCalledTimes(2)
  expect(harper.analyze).not.toHaveBeenCalled()
})
it('runs background Harper only when both automatic mode and reviewer enablement permit it', async () => {
  settings.analysis.autoHarper = true
  await render()
  await debounce()
  expect(harper.analyze).toHaveBeenCalledTimes(1)
  expect(findings.filter((finding) => finding.analyzerId === 'harper')).toHaveLength(1)
  settings = structuredClone(settings)
  settings.analyzers.harper.enabled = false
  current = input('Another phrase.')
  await render()
  await debounce()
  expect(harper.analyze).toHaveBeenCalledTimes(1)
  expect(findings.filter((finding) => finding.analyzerId === 'harper')).toHaveLength(0)
})
it('turning automatic mode off retains existing feedback without scheduling new Harper reviews', async () => {
  settings.analysis.autoHarper = true
  await render()
  await debounce()
  const original = findings.find((finding) => finding.analyzerId === 'harper')!
  settings = structuredClone(settings)
  settings.analysis.autoHarper = false
  current = input('Changed phrase.')
  await render()
  await debounce()
  expect(harper.analyze).toHaveBeenCalledTimes(1)
  expect(findings.find((finding) => finding.analyzerId === 'harper')?.id).toBe(original.id)
  expect(repeated.analyze).toHaveBeenCalledTimes(2)
})
it('discards an in-flight automatic review when the toggle is disabled', async () => {
  settings.analysis.autoHarper = true
  let release!: (result: AnalyzerResult) => void
  vi.mocked(harper.analyze).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await render()
  await debounce()
  expect(harper.analyze).toHaveBeenCalledTimes(1)
  settings = structuredClone(settings)
  settings.analysis.autoHarper = false
  await render()
  await act(async () => {
    release(result(current))
  })
  await debounce()
  expect(findings.filter((finding) => finding.analyzerId === 'harper')).toHaveLength(0)
  expect(harper.analyze).toHaveBeenCalledTimes(1)
  expect(showNotice).not.toHaveBeenCalled()
})
it('never lets an obsolete empty result erase feedback after the editor changes before React rerenders', async () => {
  settings.analysis.autoHarper = true
  await render()
  await debounce()
  const original = findings.find((finding) => finding.analyzerId === 'harper')!
  let release!: (result: AnalyzerResult) => void
  vi.mocked(harper.analyze).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  current = input('Intermediate phrase.')
  await render()
  await debounce()
  expect(harper.analyze).toHaveBeenCalledTimes(2)
  // The workspace updates its snapshot ref synchronously in the editor callback.
  liveInput.current = input('Newer draft before the render.')
  await act(async () => {
    release({ issues: [], warnings: [] })
  })
  expect(findings.find((finding) => finding.analyzerId === 'harper')?.id).toBe(original.id)
})
it('honors profile membership even when the global automatic switch is on', async () => {
  settings.analysis.autoHarper = true
  settings.customProfiles.push({
    id: 'no-harper',
    name: 'No Harper',
    description: '',
    enabled: ['repeated-word'],
  })
  // Use the same hook with a profile that explicitly excludes Harper.
  function ProfileHarness() {
    const currentRef = useRef(current),
      cache = useRef(new AnalysisCache()),
      providerRef = useRef(provider)
    const [, setFindings] = useState<Diagnostic[]>([])
    useLocalAnalysis({
      current,
      currentRef,
      settings,
      profile: 'no-harper',
      analyzers,
      cache,
      provider: providerRef,
      setFindings,
      showNotice,
    })
    return null
  }
  await act(async () => root.render(createElement(ProfileHarness)))
  await debounce()
  expect(harper.analyze).not.toHaveBeenCalled()
  expect(repeated.analyze).toHaveBeenCalledTimes(1)
})
