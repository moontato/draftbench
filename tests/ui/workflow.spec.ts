import { test, expect } from '@playwright/test'
import packageMetadata from '../../package.json' with { type: 'json' }
const appVersion = packageMetadata.version

// Test-only native bridge. Nothing from this module is included in the app bundle.
interface FixtureSeed {
  files?: Record<string, string>
  metadata?: Record<string, unknown>
  settings?: unknown
  recentProjects?: { path: string; name: string; lastOpened: number }[]
  unavailableProjects?: string[]
  recentLoadDelayMs?: number
  recentWriteFails?: boolean
}
async function installDesktopFixture(
  page: import('@playwright/test').Page,
  seed: FixtureSeed = {},
) {
  await page.addInitScript((seed: FixtureSeed) => {
    const files: Record<string, string> = seed.files ?? {
      'essay.md':
        '# A better report\n\nThe the plan has merit.\n\nThis is unclear.\n\nA separate paragraph gives the reader context.\n',
    }
    const calls: { command: string; args: Record<string, unknown> }[] = []
    const pendingRequests = new Map<string, () => void>()
    const metadata: Record<string, unknown> = seed.metadata ?? {}
    let savedSettings: unknown = seed.settings ?? null
    let recentProjects = seed.recentProjects ?? []
    const fileHash = async (text: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('')
    const testWindow = window as unknown as {
      isTauri: boolean
      __TAURI_INTERNALS__: unknown
      __TAURI_EVENT_PLUGIN_INTERNALS__: unknown
      fixture: {
        calls: typeof calls
        files: typeof files
        metadata: typeof metadata
        readonly settings: unknown
        failReviews: boolean | string
        pauseReviews: boolean
        reviewDelayMs: number
        reviewConcurrency: {
          active: number
          peak: number
          byServer: Record<string, { active: number; peak: number; requests: number }>
        }
        readonly recentProjects: typeof recentProjects
      }
    }
    testWindow.isTauri = true
    testWindow.fixture = {
      calls,
      files,
      metadata,
      failReviews: false,
      pauseReviews: false,
      reviewDelayMs: 0,
      reviewConcurrency: { active: 0, peak: 0, byServer: {} },
      get settings() {
        return savedSettings
      },
      get recentProjects() {
        return recentProjects
      },
    }
    testWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    testWindow.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args })
        if (command === 'plugin:dialog|open') return '/writing'
        if (command === 'plugin:dialog|confirm') return true
        if (command === 'load_recent_projects') {
          const snapshot = structuredClone(recentProjects)
          if (seed.recentLoadDelayMs)
            await new Promise((resolve) => setTimeout(resolve, seed.recentLoadDelayMs))
          return snapshot
        }
        if (command === 'remove_recent_project') {
          if (seed.recentWriteFails) throw 'Recent project list could not be saved.'
          recentProjects = recentProjects.filter((project) => project.path !== args.path)
          return recentProjects
        }
        if (command === 'open_project') {
          const root = String(args.path)
          if (seed.unavailableProjects?.includes(root)) throw 'Folder not found.'
          const name =
            root === '/writing' ? 'My writing' : root.split(/[\\/]/).filter(Boolean).at(-1)!
          if (!seed.recentWriteFails)
            recentProjects = [
              { path: root, name, lastOpened: Date.now() },
              ...recentProjects.filter((project) => project.path !== root),
            ].slice(0, 5)
          return {
            root,
            name,
            ...(seed.recentWriteFails
              ? { recentWarning: 'Folder opened, but the recent project list could not be saved.' }
              : { recentProjects }),
            entries: Object.keys(files).map((path) => ({
              path,
              name: path,
              folder: false,
              children: [],
            })),
          }
        }
        if (command === 'list_files')
          return Object.keys(files).map((path) => ({
            path,
            name: path,
            folder: false,
            children: [],
          }))
        if (command === 'read_document')
          return {
            content: files[String(args.path)],
            hash: await fileHash(files[String(args.path)]),
          }
        if (command === 'save_document') {
          files[String(args.path)] = String(args.content)
          return fileHash(files[String(args.path)])
        }
        if (command === 'rename_entry') {
          files[String(args.destination)] = files[String(args.path)]
          delete files[String(args.path)]
          return
        }
        if (command === 'cancel_request') {
          pendingRequests.get(String(args.id))?.()
          return
        }
        if (command === 'load_settings') return savedSettings
        if (command === 'save_settings') {
          savedSettings = args.value
          return
        }
        if (command === 'read_metadata') return metadata[String(args.name)] ?? null
        if (command === 'write_metadata') {
          metadata[String(args.name)] = args.value
          return
        }
        if (command === 'harper_review') {
          const text = String(args.text),
            offset = text.indexOf('could of')
          return offset < 0
            ? []
            : [
                {
                  offset,
                  quote: 'could of',
                  category: 'harper-grammar',
                  severity: 'warning',
                  message: 'Use could have.',
                  explanation: 'Could of is not the intended verb phrase.',
                  replacement: 'could have',
                  replacements: ['could have', "could've"],
                  confidence: 1,
                },
              ]
        }
        if (command === 'has_api_key') return false
        if (command === 'set_api_key') throw 'OS credential store unavailable; key is session-only.'
        if (command === 'ai_http') {
          const request = args.request as {
            id: string
            route: string
            serverUrl: string
            body: { model: string; messages: { content: string }[] }
          }
          if (request.route === 'models')
            return { data: [{ id: 'qwen3-8b' }, { id: 'reviewer-14b' }] }
          const prompt = request.body.messages.at(-1)!.content
          if (prompt === 'Reply with OK.') return { choices: [{ message: { content: 'OK' } }] }
          if (
            testWindow.fixture.failReviews === true ||
            (typeof testWindow.fixture.failReviews === 'string' &&
              request.body.messages[0].content.includes(testWindow.fixture.failReviews))
          )
            throw { kind: 'server', message: 'Test server unavailable.' }
          const concurrency = testWindow.fixture.reviewConcurrency
          concurrency.active++
          concurrency.peak = Math.max(concurrency.peak, concurrency.active)
          const resource = (concurrency.byServer[request.serverUrl] ??= {
            active: 0,
            peak: 0,
            requests: 0,
          })
          resource.active++
          resource.requests++
          resource.peak = Math.max(resource.peak, resource.active)
          try {
            if (testWindow.fixture.pauseReviews)
              await new Promise<void>((_resolve, reject) => {
                pendingRequests.set(request.id, () => {
                  pendingRequests.delete(request.id)
                  reject({ kind: 'cancelled', message: 'Request cancelled.' })
                })
              })
            if (testWindow.fixture.reviewDelayMs)
              await new Promise((resolve) => setTimeout(resolve, testWindow.fixture.reviewDelayMs))
            const input = JSON.parse(prompt)
            const block = input.targets.find((b: { text: string }) =>
              b.text.includes('This is unclear.'),
            )
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      issues: block
                        ? [
                            {
                              block_id: block.block_id,
                              quote: 'This is unclear.',
                              category: 'clarity',
                              severity: 'warning',
                              message: 'Unclear referent hides the point.',
                              explanation:
                                'Name the proposal instead of using an unclear reference.',
                              replacement: 'The proposal is unclear.',
                              confidence: 0.87,
                            },
                          ]
                        : [],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            }
          } finally {
            concurrency.active--
            resource.active--
          }
        }
        return 1
      },
    }
  }, seed)
}

test('desktop shell: write, analyze, inspect, apply, undo, save and model override', async ({
  page,
}) => {
  await installDesktopFixture(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Make your point. Make it well.' })).toBeVisible()
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await expect(editor).toContainText('This is unclear.')
  await expect(page.getByText('“The” appears twice in a row.')).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (call) => call.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await expect(
    page.getByText('Name the proposal instead of using an unclear reference.'),
  ).toBeVisible()
  await expect(editor).toContainText('This is unclear.')
  await page.getByRole('button', { name: 'Apply suggestion' }).click()
  await expect(editor).toContainText('The proposal is unclear.')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(editor).toContainText('This is unclear.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Test Connection', exact: true }).click()
  await expect(page.getByText(/Connected. Model/)).toBeVisible()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await page
    .locator('.analyzer-setting')
    .filter({ has: page.locator('strong', { hasText: /^Clarity$/ }) })
    .getByRole('textbox')
    .fill('reviewer-14b')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await expect(page.getByText(/findings ·/)).toBeVisible()
  const usedOverride = await page.evaluate(() =>
    (
      window as unknown as {
        fixture: { calls: { command: string; args: { request?: { body?: { model: string } } } }[] }
      }
    ).fixture.calls.some(
      (c) => c.command === 'ai_http' && c.args.request?.body?.model === 'reviewer-14b',
    ),
  )
  expect(usedOverride).toBe(true)
  await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toHaveCount(
    0,
  )
  await page.getByLabel('Show dismissed').check()
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toBeVisible()
  await page.screenshot({
    path: `${process.env.TMPDIR ?? '/tmp'}/draftbench-editor.png`,
    fullPage: true,
  })
  expect(errors).toEqual([])
})

test('Problems filters, grouping, and focus mode retain the draft', async ({ page }) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toBeVisible()
  await page.getByLabel('Filter by severity').selectOption('info')
  await expect(page.locator('.finding-card')).toHaveCount(0)
  await page.getByLabel('Filter by severity').selectOption('all')
  await page.getByLabel('Filter by analyzer').selectOption('clarity')
  await expect(page.locator('.finding-card')).toHaveCount(1)
  await page.getByLabel('Group findings').selectOption('severity')
  await expect(page.locator('.finding-group h3')).toContainText('warning')
  await page.getByLabel('Filter by category').selectOption('clarity')
  await expect(page.locator('.finding-card')).toHaveCount(1)
  await page.getByRole('button', { name: 'Toggle focus mode' }).click()
  await expect(page.getByRole('complementary', { name: 'Document analysis' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toContainText(
    'A separate paragraph',
  )
  await page.getByRole('button', { name: 'Toggle focus mode' }).click()
  await expect(page.getByRole('complementary', { name: 'Document analysis' })).toBeVisible()
})

test('save a copy preserves the original, and canceling a switch keeps unsaved changes', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.click()
  await editor.press('Control+End')
  await editor.press('Enter')
  await editor.pressSequentially('New concluding sentence.')
  await page.locator('.document-heading-actions summary').click()
  await page.getByRole('button', { name: 'Save a copy…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save a copy' })
  await dialog.getByRole('textbox').fill('essay-copy.md')
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.document-breadcrumb')).toContainText('essay-copy.md')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const files = await page.evaluate(
    () => (window as unknown as { fixture: { files: Record<string, string> } }).fixture.files,
  )
  expect(files['essay.md']).not.toContain('New concluding sentence.')
  expect(files['essay-copy.md']).toContain('New concluding sentence.')
  await editor.click()
  await editor.press('Control+End')
  await editor.pressSequentially(' Still editing.')
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Cancel' })
    .click()
  await expect(editor).toContainText('Still editing.')
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
})

test('credential-store failure stays visible after save and never persists the key in JSON', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.locator('.advanced summary').click()
  await page.locator('input[type=password]').fill('test-only-secret')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('session-only')
  const persisted = await page.evaluate(() =>
    (
      window as unknown as { fixture: { calls: { command: string; args: unknown }[] } }
    ).fixture.calls.filter((call) => ['save_settings', 'write_metadata'].includes(call.command)),
  )
  expect(persisted.length).toBeGreaterThan(0)
  expect(JSON.stringify(persisted)).not.toContain('test-only-secret')
})

test('expanded AI limits persist and notifications expire without manual dismissal', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.clock.install()
  await page.goto('/')
  await expect(page.locator('.app-header')).not.toContainText('Local-first')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.locator('.advanced summary').click()
  const timeout = page.getByLabel('Timeout (seconds)', { exact: true })
  const tokens = page.getByLabel('Maximum output tokens', { exact: true })
  await expect(timeout).toHaveAttribute('max', '1800')
  await expect(tokens).toHaveAttribute('max', '32768')
  await timeout.fill('1800')
  await tokens.fill('32768')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.locator('.notice')).toContainText('Settings saved locally.')
  const saved = await page.evaluate(
    () =>
      (
        window as unknown as {
          fixture: {
            calls: {
              command: string
              args: { value: { ai: { timeoutMs: number; maxTokens: number } } }
            }[]
          }
        }
      ).fixture.calls
        .filter((call) => call.command === 'save_settings')
        .at(-1)!.args.value.ai,
  )
  expect(saved.timeoutMs).toBe(1_800_000)
  expect(saved.maxTokens).toBe(32768)
  await page.clock.fastForward(7000)
  await expect(page.locator('.notice')).toBeVisible()
  await page.clock.fastForward(1000)
  await expect(page.locator('.notice')).toHaveCount(0)
})

test('reopening restores an exact saved review without inference; edits/config changes reject it', async ({
  page,
  context,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(page.getByText('“The” appears twice in a row.')).toBeVisible()
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fixture: { metadata: { analysis?: { reviews?: { reviews: unknown[] } } } }
            }
          ).fixture.metadata.analysis?.reviews?.reviews.length ?? 0,
      ),
    )
    .toBe(1)
  const seed = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          files: Record<string, string>
          metadata: Record<string, unknown>
          settings: unknown
        }
      }
    ).fixture
    return { files: fixture.files, metadata: fixture.metadata, settings: fixture.settings }
  })
  const openSaved = async (data: FixtureSeed) => {
    const reopened = await context.newPage()
    await installDesktopFixture(reopened, data)
    await reopened.goto('/')
    await reopened.getByRole('button', { name: 'Open a writing folder' }).click()
    await reopened.getByRole('button', { name: 'essay', exact: true }).click()
    return reopened
  }
  const reopened = await openSaved(seed)
  await expect(reopened.locator('.analysis-status')).toContainText('Saved review')
  await expect(
    reopened.getByRole('button', { name: /Unclear referent hides the point/ }),
  ).toBeVisible()
  expect(
    await reopened.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (call) => call.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
  await reopened.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(
    reopened.getByRole('dialog', { name: 'Analysis history', exact: true }).locator('.history-run'),
  ).toHaveCount(1)
  await expect(reopened.locator('.history-reviewers')).toContainText('qwen3-8b')
  await reopened.getByRole('button', { name: 'Close analysis history' }).click()
  await reopened.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await reopened.getByRole('button', { name: 'Apply suggestion' }).click()
  await expect(reopened.getByRole('textbox', { name: 'Document writing editor' })).toContainText(
    'The proposal is unclear.',
  )
  await reopened.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(reopened.getByRole('textbox', { name: 'Document writing editor' })).toContainText(
    'This is unclear.',
  )
  const changed = await openSaved({
    ...seed,
    files: { ...seed.files, 'essay.md': seed.files['essay.md'] + '\nAn external edit.\n' },
  })
  await expect(changed.locator('.analysis-status')).not.toContainText('Saved review')
  await expect(
    changed.getByRole('button', { name: /Unclear referent hides the point/ }),
  ).toHaveCount(0)
  const configured = await openSaved({ ...seed, settings: { ai: { model: 'another-model' } } })
  await expect(configured.locator('.analysis-status')).not.toContainText('Saved review')
  await expect(
    configured.getByRole('button', { name: /Unclear referent hides the point/ }),
  ).toHaveCount(0)
  await reopened.close()
  await changed.close()
  await configured.close()
})

test('history shows manual/cache runs, follows renames, isolates copies, and never replays findings', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  const historyButton = page.getByRole('button', { name: 'Analysis history', exact: true })
  await expect(historyButton).toBeDisabled()
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(page.getByText('“The” appears twice in a row.')).toBeVisible()
  await historyButton.click()
  await expect(page.getByText('No run history is available yet.', { exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(historyButton).toBeFocused()
  const review = async () => {
    await page.locator('.run-controls summary').click()
    await page.getByRole('button', { name: 'Clarity', exact: true }).click()
    await expect(page.locator('.analysis-status')).toContainText('1 findings')
    await expect(page.getByRole('button', { name: 'Analyze document', exact: true })).toBeVisible()
  }
  await review()
  await review()
  const before = await page.getByRole('textbox', { name: 'Document writing editor' }).innerText()
  await historyButton.click()
  const dialog = page.getByRole('dialog', { name: 'Analysis history', exact: true })
  await expect(dialog.locator('.history-run')).toHaveCount(2)
  await expect(dialog.locator('.history-run').first()).toContainText(
    '4 cache hits · 0 review requests',
  )
  await expect(dialog.locator('.history-run').last()).toContainText(
    '0 cache hits · 4 review requests',
  )
  await expect(dialog).toContainText('qwen3-8b')
  await expect(dialog).toContainText('Document · General prose · 1 findings')
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  expect(await page.getByRole('textbox', { name: 'Document writing editor' }).innerText()).toBe(
    before,
  )
  await page.getByRole('button', { name: 'Actions for essay.md' }).click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename', exact: true })
  await rename.getByRole('textbox').fill('renamed.md')
  await rename.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.document-breadcrumb')).toContainText('renamed.md')
  await historyButton.click()
  await expect(dialog.locator('.history-run')).toHaveCount(2)
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  await page.locator('.document-heading-actions summary').click()
  await page.getByRole('button', { name: 'Save a copy…' }).click()
  const copy = page.getByRole('dialog', { name: 'Save a copy' })
  await copy.getByRole('textbox').fill('copy.md')
  await copy.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.document-breadcrumb')).toContainText('copy.md')
  await historyButton.click()
  await expect(dialog.locator('.history-run')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  await page.getByRole('button', { name: 'renamed', exact: true }).click()
  await historyButton.click()
  await expect(dialog.locator('.history-run')).toHaveCount(2)
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  await page.getByRole('button', { name: 'Configure analyzers', exact: true }).click()
  await page.getByRole('button', { name: 'Clear analysis cache' }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await historyButton.click()
  await expect(dialog.locator('.history-run')).toHaveCount(0)
})

test('history records failed and cancelled runs, including cancellation on document switch', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { failReviews: boolean } }).fixture.failReviews = true
  })
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('completed with warnings')
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(page.locator('.history-reviewers')).toContainText('Failed')
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  await page.evaluate(() => {
    const fixture = (
      window as unknown as { fixture: { failReviews: boolean; pauseReviews: boolean } }
    ).fixture
    fixture.failReviews = false
    fixture.pauseReviews = true
  })
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('Reviewing with Clarity')
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('Analysis cancelled')
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('Reviewing with Clarity')
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(page.locator('.history-run')).toHaveCount(3)
  await expect(page.locator('.history-run').first()).toContainText('Cancelled')
  await expect(page.locator('.history-run').nth(1)).toContainText('Cancelled')
  await expect(page.locator('.history-run').last()).toContainText('Failed')
})

test('legacy saved findings recover a labeled history entry even without a valid request cache', async ({
  page,
  context,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('1 findings')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fixture: { metadata: { analysis?: { reviews?: { reviews: unknown[] } } } }
            }
          ).fixture.metadata.analysis?.reviews?.reviews.length ?? 0,
      ),
    )
    .toBe(1)
  const seed = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          files: Record<string, string>
          metadata: Record<string, unknown>
          settings: unknown
        }
      }
    ).fixture
    return { files: fixture.files, metadata: fixture.metadata, settings: fixture.settings }
  })
  for (const cacheMode of ['valid', 'missing', 'corrupt', 'corrupt-history']) {
    const legacy = structuredClone(seed)
    const analysis = legacy.metadata.analysis as Record<string, unknown>
    delete analysis.history
    if (cacheMode === 'missing') delete analysis.cache
    if (cacheMode === 'corrupt') analysis.cache = { version: 999 }
    if (cacheMode === 'corrupt-history') analysis.history = { version: 999 }
    const reopened = await context.newPage()
    await installDesktopFixture(reopened, legacy)
    await reopened.goto('/')
    await reopened.getByRole('button', { name: 'Open a writing folder' }).click()
    await reopened.getByRole('button', { name: 'essay', exact: true }).click()
    await expect(
      reopened.getByRole('button', { name: /Unclear referent hides the point/ }),
    ).toBeVisible()
    await reopened.getByRole('button', { name: 'Analysis history', exact: true }).click()
    const history = reopened.getByRole('dialog', { name: 'Analysis history', exact: true })
    await expect(history.locator('.history-run')).toHaveCount(1)
    await expect(history).toContainText('Recovered saved review')
    await expect(history).toContainText('not a complete log of earlier runs')
    await expect(history).toContainText('Model: not recorded')
    await expect(history).not.toContainText('0 cache hits')
    expect(
      await reopened.evaluate(
        () =>
          (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
            (c) => c.command === 'ai_http',
          ).length,
      ),
    ).toBe(0)
    await expect
      .poll(() =>
        reopened.evaluate(
          () =>
            (
              window as unknown as {
                fixture: { metadata: { analysis?: { history?: { runs: { origin: string }[] } } } }
              }
            ).fixture.metadata.analysis?.history?.runs?.[0]?.origin,
        ),
      )
      .toBe('saved-review')
    await reopened.close()
  }
})

test('review inspector resizes by drag/keyboard and collapses without losing the finding', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Clarity', exact: true }).click()
  const finding = page.getByRole('button', { name: /Unclear referent hides the point/ })
  await finding.click()
  const inspector = page.getByRole('region', { name: 'Review finding', exact: true })
  const resize = page.getByRole('separator', { name: 'Resize review finding' })
  await resize.focus()
  await resize.press('Home')
  const small = (await inspector.boundingBox())!.height
  const handle = (await resize.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 40, {
    steps: 5,
  })
  await page.mouse.up()
  await expect.poll(async () => (await inspector.boundingBox())!.height).toBeGreaterThan(small + 25)
  const dragged = (await inspector.boundingBox())!.height
  await resize.press('ArrowDown')
  await expect
    .poll(async () => Math.round((await inspector.boundingBox())!.height))
    .toBe(Math.round(dragged - 20))
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  const before = await editor.innerText()
  const cardsBefore = await page.locator('.findings-scroll').evaluate((el) => el.clientHeight)
  await page.getByRole('button', { name: 'Collapse review finding' }).click()
  await expect(page.getByRole('button', { name: 'Expand review finding' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(inspector.locator('.inspector-body')).not.toBeVisible()
  await expect(page.locator('.finding-card.selected')).toHaveCount(1)
  await expect
    .poll(() => page.locator('.findings-scroll').evaluate((el) => el.clientHeight))
    .toBeGreaterThan(cardsBefore + 80)
  await page.getByRole('button', { name: 'Expand review finding' }).click()
  await expect(inspector).toContainText('Name the proposal instead')
  await page.setViewportSize({ width: 1280, height: 560 })
  await expect.poll(async () => (await inspector.boundingBox())!.height).toBeLessThanOrEqual(150)
  await page.getByRole('button', { name: 'Collapse review finding' }).click()
  await finding.click()
  await expect(page.getByRole('button', { name: 'Collapse review finding' })).toBeVisible()
  expect(await editor.innerText()).toBe(before)
  await page.getByRole('button', { name: 'Apply suggestion' }).click()
  await expect(editor).toContainText('The proposal is unclear.')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(editor).toContainText('This is unclear.')
})

test('Settings General shows the release version without changing preferences', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'General', exact: true }).click()
  await expect(settings.locator('.app-version')).toContainText(`v${appVersion}`)
  await expect(settings.locator('.app-version')).toContainText('Draftbench')
  await expect(settings.locator('.app-version input')).toHaveCount(0)
  await settings.getByRole('button', { name: 'Editor', exact: true }).click()
  await settings.getByRole('button', { name: 'General', exact: true }).click()
  await expect(settings.locator('.app-version')).toContainText(`v${appVersion}`)
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'save_settings',
        ).length,
    ),
  ).toBe(0)
})

test('startup recent projects reopen directly, persist across restart, and remain bounded/deduplicated', async ({
  page,
  context,
}) => {
  const recentProjects = Array.from({ length: 5 }, (_, i) => ({
    path: `/projects/p${i + 1}`,
    name: `p${i + 1}`,
    lastOpened: 1700000000000 - i,
  }))
  await installDesktopFixture(page, { recentProjects })
  await page.goto('/')
  const recent = page.getByRole('region', { name: 'Recent projects' })
  await expect(recent.getByRole('button', { name: /^Open recent project/ })).toHaveCount(5)
  await page.setViewportSize({ width: 1280, height: 600 })
  await expect(recent.locator('.recent-project-open').first()).toBeInViewport()
  await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/draftbench-recent-projects.png` })
  await recent
    .getByRole('button', { name: 'Open recent project p3 at /projects/p3', exact: true })
    .click()
  await expect(page.getByRole('button', { name: 'essay', exact: true })).toBeVisible()
  const calls = await page.evaluate(
    () =>
      (window as unknown as { fixture: { calls: { command: string; args: { path?: string } }[] } })
        .fixture.calls,
  )
  expect(calls.filter((call) => call.command === 'plugin:dialog|open')).toHaveLength(0)
  expect(calls.find((call) => call.command === 'open_project')?.args.path).toBe('/projects/p3')
  const persisted = await page.evaluate(
    () =>
      (
        window as unknown as {
          fixture: { recentProjects: { path: string; name: string; lastOpened: number }[] }
        }
      ).fixture.recentProjects,
  )
  expect(persisted).toHaveLength(5)
  expect(persisted[0].path).toBe('/projects/p3')
  expect(persisted.filter((p) => p.path === '/projects/p3')).toHaveLength(1)
  const restarted = await context.newPage()
  await installDesktopFixture(restarted, { recentProjects: persisted })
  await restarted.goto('/')
  await expect(restarted.locator('.recent-project-open').first()).toHaveAttribute(
    'title',
    '/projects/p3',
  )
  await restarted
    .getByRole('button', { name: 'Open recent project p3 at /projects/p3', exact: true })
    .click()
  await expect(restarted.getByRole('button', { name: 'essay', exact: true })).toBeVisible()
  expect(
    await restarted.evaluate(
      () =>
        (window as unknown as { fixture: { recentProjects: { path: string }[] } }).fixture
          .recentProjects.length,
    ),
  ).toBe(5)
  await restarted.close()
})

test('unavailable recent folders stay removable and never delete writing', async ({ page }) => {
  await installDesktopFixture(page, {
    recentProjects: [
      { path: '/missing', name: 'Missing', lastOpened: 2 },
      { path: '/writing', name: 'My writing', lastOpened: 1 },
    ],
    unavailableProjects: ['/missing'],
  })
  await page.goto('/')
  const recent = page.getByRole('region', { name: 'Recent projects' })
  await recent
    .getByRole('button', { name: 'Open recent project Missing at /missing', exact: true })
    .click()
  await expect(page.locator('.notice')).toContainText('Could not open this recent folder')
  await expect(recent).toContainText('Folder unavailable')
  await expect(
    page.getByRole('button', { name: 'Open a writing folder', exact: true }),
  ).toBeVisible()
  await recent
    .getByRole('button', { name: 'Remove recent project Missing at /missing', exact: true })
    .click()
  await expect(recent.getByRole('button', { name: /^Open recent project/ })).toHaveCount(1)
  expect(
    await page.evaluate(() =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.some(
        (call) => call.command === 'delete_entry',
      ),
    ),
  ).toBe(false)
  await recent
    .getByRole('button', { name: 'Open recent project My writing at /writing', exact: true })
    .click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toContainText(
    'This is unclear.',
  )
})

test('first launch picker opens are remembered even when the startup list resolves late', async ({
  page,
  context,
}) => {
  await installDesktopFixture(page, { recentLoadDelayMs: 1000 })
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Recent projects' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await expect(page.getByRole('button', { name: 'essay', exact: true })).toBeVisible()
  const persisted = await page.evaluate(
    () =>
      (
        window as unknown as {
          fixture: { recentProjects: { path: string; name: string; lastOpened: number }[] }
        }
      ).fixture.recentProjects,
  )
  expect(persisted[0].path).toBe('/writing')
  const restarted = await context.newPage()
  await installDesktopFixture(restarted, { recentProjects: persisted })
  await restarted.goto('/')
  await expect(
    restarted.getByRole('button', {
      name: 'Open recent project My writing at /writing',
      exact: true,
    }),
  ).toBeVisible()
  await restarted.close()
})

test('recent-list write failures do not prevent opening a project or erase existing entries', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    recentWriteFails: true,
    recentProjects: [{ path: '/writing', name: 'My writing', lastOpened: 1 }],
  })
  await page.goto('/')
  await page
    .getByRole('button', { name: 'Remove recent project My writing at /writing', exact: true })
    .click()
  await expect(page.locator('.notice')).toContainText('Recent project list could not be saved')
  await expect(
    page.getByRole('button', { name: 'Open recent project My writing at /writing', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Open recent project My writing at /writing', exact: true })
    .click()
  await expect(page.getByRole('button', { name: 'essay', exact: true })).toBeVisible()
  await expect(page.locator('.notice')).toContainText(
    'Folder opened, but the recent project list could not be saved',
  )
})

test('parallel jobs persist, bound full-review requests, reuse cache, and preserve reviewed fixes', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await expect(page.getByLabel('Parallel AI jobs')).toHaveValue('1')
  await page.getByLabel('Parallel AI jobs').selectOption('3')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await expect(page.getByLabel('Parallel AI jobs')).toHaveValue('3')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { reviewDelayMs: number } }).fixture.reviewDelayMs = 40
  })
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('findings ·')
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            fixture: { reviewConcurrency: { active: number; peak: number } }
          }
        ).fixture.reviewConcurrency,
    ),
  ).toMatchObject({ active: 0, peak: 3 })
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(page.locator('.history-run')).toHaveCount(1)
  await expect(page.locator('.history-summary')).toContainText('Up to 3 parallel AI jobs')
  await expect(page.locator('.history-reviewers')).not.toContainText('Failed')
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          fixture: { calls: { command: string }[] }
        }
      ).fixture.calls.filter((c) => c.command === 'ai_http').length,
  )
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('13 cached reviews')
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            fixture: { calls: { command: string }[] }
          }
        ).fixture.calls.filter((c) => c.command === 'ai_http').length,
    ),
  ).toBe(calls)
  await page
    .getByRole('button', { name: /Unclear referent hides the point/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Apply suggestion' }).click()
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toContainText(
    'The proposal is unclear.',
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toContainText(
    'This is unclear.',
  )
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await page
    .locator('.analyzer-setting')
    .filter({ has: page.locator('strong', { hasText: /^Redundancy$/ }) })
    .getByRole('textbox')
    .fill('reviewer-14b')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.evaluate(() => {
    const stats = (window as unknown as { fixture: { reviewConcurrency: { peak: number } } })
      .fixture.reviewConcurrency
    stats.peak = 0
  })
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Force rerun all', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('findings ·')
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            fixture: { reviewConcurrency: { active: number; peak: number } }
          }
        ).fixture.reviewConcurrency,
    ),
  ).toMatchObject({ active: 0, peak: 1 })
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(page.locator('.history-summary').first()).toContainText('Sequential')
})

test('parallel cancellation aborts every active request, skips queued work, and allows a new run', async ({
  page,
}) => {
  await installDesktopFixture(page, { settings: { analysis: { parallelJobs: 3 } } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { pauseReviews: boolean } }).fixture.pauseReviews = true
  })
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fixture: { reviewConcurrency: { active: number } }
            }
          ).fixture.reviewConcurrency.active,
      ),
    )
    .toBe(3)
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('Analysis cancelled.')
  expect(
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          fixture: {
            calls: { command: string }[]
            reviewConcurrency: { active: number }
          }
        }
      ).fixture
      return {
        active: fixture.reviewConcurrency.active,
        requests: fixture.calls.filter((c) => c.command === 'ai_http').length,
        cancellations: fixture.calls.filter((c) => c.command === 'cancel_request').length,
      }
    }),
  ).toEqual({ active: 0, requests: 3, cancellations: 3 })
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(page.locator('.history-outcome')).toContainText('Cancelled')
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { pauseReviews: boolean } }).fixture.pauseReviews = false
  })
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('findings ·')
  await expect(page.locator('.analysis-status')).not.toContainText('warnings')
})

test('a failed parallel reviewer does not stop the others or capture a partial saved review', async ({
  page,
}) => {
  await installDesktopFixture(page, { settings: { analysis: { parallelJobs: 3 } } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.evaluate(() => {
    const fixture = (
      window as unknown as { fixture: { failReviews: boolean | string; reviewDelayMs: number } }
    ).fixture
    fixture.failReviews = 'Review clarity:'
    fixture.reviewDelayMs = 30
  })
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('completed with warnings')
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toHaveCount(
    2,
  )
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fixture: { metadata: { analysis?: { reviews?: { reviews: unknown[] } } } }
            }
          ).fixture.metadata.analysis?.reviews?.reviews.length ?? 0,
      ),
    )
    .toBe(0)
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  const reviewers = page.locator('.history-reviewers > li')
  await expect(
    reviewers.filter({ has: page.locator('strong', { hasText: /^Clarity$/ }) }),
  ).toContainText('Failed')
  await expect(
    reviewers.filter({ has: page.locator('strong', { hasText: /^Ambiguous reference$/ }) }),
  ).toContainText('Completed')
  await expect(
    reviewers.filter({ has: page.locator('strong', { hasText: /^Redundancy$/ }) }),
  ).toContainText('Completed')
})

test('parallel responses after editing discard stale findings and cannot save a mismatched review', async ({
  page,
}) => {
  await installDesktopFixture(page, { settings: { analysis: { parallelJobs: 3 } } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { reviewDelayMs: number } }).fixture.reviewDelayMs = 200
  })
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fixture: { reviewConcurrency: { active: number } }
            }
          ).fixture.reviewConcurrency.active,
      ),
    )
    .toBe(3)
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.fill('A completely different draft.')
  await expect(page.locator('.analysis-status')).toContainText('stale results discarded')
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toHaveCount(
    0,
  )
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fixture: { metadata: { analysis?: { reviews?: { reviews: unknown[] } } } }
            }
          ).fixture.metadata.analysis?.reviews?.reviews.length ?? 0,
      ),
    )
    .toBe(0)
})

test('input budgets validate, persist across restart, allow long essays, and gate cached requests', async ({
  page,
  context,
}) => {
  const longEssay =
    '# A long essay\n\nThe the introduction has merit.\n\n' +
    Array.from({ length: 5 }, () => 'A'.repeat(10000)).join('\n\n') +
    '\n\nThis is unclear.\n'
  await installDesktopFixture(page, { files: { 'essay.md': longEssay } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(page.getByText('“The” appears twice in a row.')).toBeVisible()
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Redundancy', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('completed with warnings')
  await expect(page.locator('.notice')).toContainText('48,000-character document input budget')
  await expect(page.locator('.notice')).toContainText('Settings → Analysis')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  const paragraph = page.getByLabel('Paragraph/context input budget (characters)')
  const document = page.getByLabel('Document input budget (characters)')
  await expect(paragraph).toHaveValue('12000')
  await expect(document).toHaveValue('48000')
  await document.fill('999')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(
    page.getByText('Input budgets must be whole numbers between 1,000 and 1,000,000 characters.'),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => (window as unknown as { fixture: { settings: unknown } }).fixture.settings,
    ),
  ).toBeNull()
  await paragraph.fill('64000')
  await document.fill('120000')
  await page.getByLabel('Parallel AI jobs').selectOption('2')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('findings ·')
  await expect(page.locator('.analysis-status')).not.toContainText('warnings')
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toHaveCount(
    3,
  )
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(page.locator('.history-input-budgets').first()).toContainText('64,000')
  await expect(page.locator('.history-input-budgets').first()).toContainText('120,000')
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  const calls = await page.evaluate(
    () =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
        (c) => c.command === 'ai_http',
      ).length,
  )
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await document.fill('1000')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toHaveCount(
    0,
  )
  await expect(page.getByText('“The” appears twice in a row.')).toBeVisible()
  await page.locator('.run-controls summary').click()
  await page.getByRole('button', { name: 'Redundancy', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('completed with warnings')
  await expect(page.locator('.notice')).toContainText('1,000-character document input budget')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await document.fill('120000')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('cached reviews')
  await expect(page.locator('.analysis-status')).not.toContainText('warnings')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'ai_http',
        ).length,
    ),
  ).toBe(calls)
  const seed = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          files: Record<string, string>
          metadata: Record<string, unknown>
          settings: unknown
        }
      }
    ).fixture
    return { files: fixture.files, metadata: fixture.metadata, settings: fixture.settings }
  })
  const reopened = await context.newPage()
  await installDesktopFixture(reopened, seed)
  await reopened.goto('/')
  await reopened.getByRole('button', { name: 'Open a writing folder' }).click()
  await reopened.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(reopened.locator('.analysis-status')).toContainText('Saved review')
  await reopened.getByRole('button', { name: 'Open settings' }).click()
  await reopened.getByRole('button', { name: 'Analysis', exact: true }).click()
  await expect(reopened.getByLabel('Paragraph/context input budget (characters)')).toHaveValue(
    '64000',
  )
  await expect(reopened.getByLabel('Document input budget (characters)')).toHaveValue('120000')
  await expect(reopened.getByLabel('Parallel AI jobs')).toHaveValue('2')
  await reopened.getByRole('button', { name: 'General', exact: true }).click()
  await reopened.getByRole('button', { name: 'Restore defaults', exact: true }).click()
  await reopened.getByRole('button', { name: 'Analysis', exact: true }).click()
  await expect(reopened.getByLabel('Paragraph/context input budget (characters)')).toHaveValue(
    '12000',
  )
  await expect(reopened.getByLabel('Document input budget (characters)')).toHaveValue('48000')
  await reopened.close()
})

test('v0.2 creates a reviewer/profile, routes two backends with bounded overlap, and restores reviews across restart', async ({
  page,
  context,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Backends', exact: true }).click()
  await page.getByLabel('Backend name', { exact: true }).fill('Local Fast')
  await page.getByLabel('Backend default model').fill('fast-model')
  await page.getByLabel('Global AI concurrency').selectOption('4')
  await page.getByRole('button', { name: 'Add backend', exact: true }).click()
  await page.getByLabel('Backend name', { exact: true }).fill('GPU Box')
  await page.getByLabel('Backend server URL').fill('http://100.80.40.20:8080')
  await page.getByLabel('Backend default model').fill('gpu-model')
  await page.getByRole('button', { name: 'Test backend connection', exact: true }).click()
  await expect(page.getByText(/Model “gpu-model” accepted a completion/)).toBeVisible()
  const gpuId = await page
    .getByLabel('Default backend')
    .getByRole('option', { name: 'GPU Box' })
    .getAttribute('value')
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click()
  await page
    .getByRole('region', { name: 'Ambiguous reference analyzer settings', exact: true })
    .getByLabel('Backend', { exact: true })
    .selectOption(gpuId!)
  await page.getByRole('button', { name: 'Create custom analyzer' }).click()
  await page.getByLabel('Analyzer ID', { exact: true }).fill('buried-request')
  await page.getByLabel('Analyzer name', { exact: true }).fill('Buried Request')
  await page.getByLabel('Analyzer description').fill('Flags hidden requests in email.')
  await page
    .getByLabel('Instructions', { exact: true })
    .fill(
      'Flag emails where the main request is difficult to identify. Only report meaningful reader difficulty. Do not rewrite the entire email.',
    )
  await page.getByRole('button', { name: 'Keep analyzer changes' }).click()
  const custom = page.getByRole('region', { name: 'Buried Request analyzer settings', exact: true })
  await custom.getByLabel('Backend', { exact: true }).selectOption(gpuId!)
  await custom.getByLabel('Model override', { exact: true }).fill('gpu-custom-model')
  await page
    .getByRole('region', { name: 'Harper analyzer settings', exact: true })
    .getByRole('checkbox')
    .check()
  await page.getByRole('button', { name: 'Profiles', exact: true }).click()
  await page.getByRole('button', { name: 'Create custom profile' }).click()
  await page.getByLabel('Profile ID', { exact: true }).fill('work-email')
  await page.getByLabel('Profile name', { exact: true }).fill('Work Email')
  const membership = page.getByRole('group', { name: 'Enabled analyzers in this profile' })
  for (const name of ['Harper', 'Clarity', 'Buried Request', 'Ambiguous reference'])
    await membership.getByRole('checkbox', { name, exact: true }).check()
  await page.getByRole('button', { name: 'Keep profile changes' }).click()
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await page.getByLabel('Writing profile').selectOption('work-email')
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { reviewDelayMs: number } }).fixture.reviewDelayMs = 140
  })
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('3 findings')
  const stats = await page.evaluate(
    () =>
      (
        window as unknown as {
          fixture: {
            reviewConcurrency: {
              peak: number
              byServer: Record<string, { peak: number; active: number }>
            }
          }
        }
      ).fixture.reviewConcurrency,
  )
  expect(stats.peak).toBe(4)
  expect(
    Object.values(stats.byServer)
      .map((s) => s.peak)
      .sort(),
  ).toEqual([2, 2])
  expect(Object.values(stats.byServer).every((s) => s.active === 0)).toBe(true)
  const customGroup = page
    .locator('.finding-group')
    .filter({ has: page.getByRole('heading', { name: /^Buried Request/ }) })
  await customGroup.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await page.getByRole('button', { name: /Analyzer & engine/ }).click()
  await expect(page.locator('.engine-details')).toContainText('GPU Box')
  await expect(page.locator('.engine-details')).toContainText('gpu-custom-model')
  await page.getByRole('button', { name: 'Analysis history', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Analysis history' })).toContainText('Work Email')
  await expect(page.getByRole('dialog', { name: 'Analysis history' })).toContainText(
    'Backend: GPU Box',
  )
  await page.getByRole('button', { name: 'Close analysis history' }).click()
  const seed = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          files: Record<string, string>
          metadata: Record<string, unknown>
          settings: unknown
        }
      }
    ).fixture
    return { files: fixture.files, metadata: fixture.metadata, settings: fixture.settings }
  })
  const reopened = await context.newPage()
  await installDesktopFixture(reopened, seed)
  await reopened.goto('/')
  await reopened.getByRole('button', { name: 'Open a writing folder' }).click()
  await reopened.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(reopened.getByLabel('Writing profile')).toHaveValue('work-email')
  await expect(reopened.locator('.analysis-status')).toContainText('Saved review')
  await expect(
    reopened.getByRole('button', { name: /Unclear referent hides the point/ }),
  ).toHaveCount(3)
  await reopened
    .getByRole('button', { name: /Unclear referent hides the point/ })
    .last()
    .click()
  await reopened.getByRole('button', { name: 'Apply suggestion', exact: true }).click()
  await expect(reopened.locator('.tiptap')).toContainText('The proposal is unclear.')
  await reopened.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(reopened.locator('.tiptap')).toContainText('This is unclear.')
  expect(
    await reopened.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
  await reopened.close()
})

test('Harper findings share inline review, suggestion choice and normal Undo/Redo without AI or code linting', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    files: {
      'essay.md':
        'She **could of** finished the report.\n\n```text\nShe could of finished in code.\n```\n',
    },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click()
  await page
    .getByRole('region', { name: 'Harper analyzer settings', exact: true })
    .getByRole('checkbox')
    .check()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('button', { name: /Use could have/ })).toHaveCount(1)
  await expect(page.locator('.diagnostic')).toHaveCount(1)
  await page.getByRole('button', { name: /Use could have/ }).click()
  await page.getByLabel('Suggested replacement').selectOption('1')
  await page.getByRole('button', { name: 'Apply suggestion', exact: true }).click()
  await expect(page.locator('.tiptap strong')).toContainText("could've")
  await expect(page.locator('.tiptap pre')).toContainText('could of')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('.tiptap strong')).toContainText('could of')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(page.locator('.tiptap strong')).toContainText("could've")
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
})

test('custom reviewer validation, duplication, editing/deletion, and corrupt entry recovery are isolated', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    settings: {
      version: 2,
      customAnalyzers: [
        {
          id: 'good-reviewer',
          name: 'Good Reviewer',
          description: '',
          enabled: true,
          scope: 'document',
          instructions: 'Report only unclear actions.',
          severity: 'warning',
        },
        { id: 'bad-reviewer', name: 'Bad Reviewer', scope: 'execute-code', instructions: '' },
      ],
    },
  })
  await page.goto('/')
  await expect(page.locator('.notice')).toContainText('isolated')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Good Reviewer analyzer settings', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Bad Reviewer analyzer settings', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Create custom analyzer' }).click()
  await page.getByLabel('Analyzer ID', { exact: true }).fill('clarity')
  await page.getByLabel('Analyzer name', { exact: true }).fill('Duplicate ID')
  await page.getByLabel('Instructions', { exact: true }).fill('Find unclear writing.')
  await page.getByRole('button', { name: 'Keep analyzer changes' }).click()
  await expect(page.getByText('That analyzer ID already exists.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel analyzer edit' }).click()
  await page.getByRole('button', { name: 'Duplicate Good Reviewer', exact: true }).click()
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Report only unclear actions.',
  )
  await page.getByLabel('Analyzer name', { exact: true }).fill('Copied Reviewer')
  await page.getByRole('button', { name: 'Keep analyzer changes' }).click()
  await page.getByRole('button', { name: 'Edit Copied Reviewer', exact: true }).click()
  await expect(page.getByLabel('Analyzer ID', { exact: true })).toBeDisabled()
  await page.getByLabel('Analyzer name', { exact: true }).fill('Renamed Reviewer')
  await page.getByRole('button', { name: 'Keep analyzer changes' }).click()
  await page.getByRole('button', { name: 'Delete Renamed Reviewer', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Renamed Reviewer analyzer settings', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete Clarity', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Profiles', exact: true }).click()
  await page.getByRole('button', { name: 'Duplicate Professional email', exact: true }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('My Email')
  await page.getByRole('button', { name: 'Keep profile changes' }).click()
  await page.getByRole('button', { name: 'Edit My Email', exact: true }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('Renamed Email')
  await page.getByRole('button', { name: 'Keep profile changes' }).click()
  await page.getByRole('button', { name: 'Delete Renamed Email', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Delete Professional email', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  const saved = await page.evaluate(
    () =>
      (
        window as unknown as {
          fixture: { settings: { customAnalyzers: { id: string }[]; customProfiles: unknown[] } }
        }
      ).fixture.settings,
  )
  expect(saved.customAnalyzers.map((a) => a.id)).toEqual(['good-reviewer'])
  expect(saved.customProfiles).toEqual([])
})

test('preview clearly identifies desktop-only capabilities', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(/This is the frontend preview/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open a writing folder' })).toBeDisabled()
  await page.screenshot({
    path: `${process.env.TMPDIR ?? '/tmp'}/draftbench-welcome.png`,
    fullPage: true,
  })
})
