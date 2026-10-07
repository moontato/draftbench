import { test, expect } from '@playwright/test'

// Test-only native bridge. Nothing from this module is included in the app bundle.
async function installDesktopFixture(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const files: Record<string, string> = {
      'essay.md':
        '# A better report\n\nThe the plan has merit.\n\nThis is unclear.\n\nA separate paragraph gives the reader context.\n',
    }
    const calls: { command: string; args: Record<string, unknown> }[] = []
    const metadata: Record<string, unknown> = {}
    let savedSettings: unknown = null
    const testWindow = window as unknown as {
      isTauri: boolean
      __TAURI_INTERNALS__: unknown
      __TAURI_EVENT_PLUGIN_INTERNALS__: unknown
      fixture: { calls: typeof calls; files: typeof files }
    }
    testWindow.isTauri = true
    testWindow.fixture = { calls, files }
    testWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    testWindow.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args })
        if (command === 'plugin:dialog|open') return '/writing'
        if (command === 'plugin:dialog|confirm') return true
        if (command === 'open_project')
          return {
            root: '/writing',
            name: 'My writing',
            entries: Object.keys(files).map((path) => ({
              path,
              name: path,
              folder: false,
              children: [],
            })),
          }
        if (command === 'list_files')
          return Object.keys(files).map((path) => ({
            path,
            name: path,
            folder: false,
            children: [],
          }))
        if (command === 'read_document')
          return { content: files[String(args.path)], hash: 'disk-hash' }
        if (command === 'save_document') {
          files[String(args.path)] = String(args.content)
          return 'saved-hash'
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
        if (command === 'has_api_key') return false
        if (command === 'set_api_key') throw 'OS credential store unavailable; key is session-only.'
        if (command === 'ai_http') {
          const request = args.request as {
            route: string
            body: { model: string; messages: { content: string }[] }
          }
          if (request.route === 'models')
            return { data: [{ id: 'qwen3-8b' }, { id: 'reviewer-14b' }] }
          const prompt = request.body.messages.at(-1)!.content
          if (prompt === 'Reply with OK.') return { choices: [{ message: { content: 'OK' } }] }
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
                            explanation: 'Name the proposal instead of using an unclear reference.',
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
        }
        return 1
      },
    }
  })
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

test('preview clearly identifies desktop-only capabilities', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(/This is the frontend preview/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open a writing folder' })).toBeDisabled()
  await page.screenshot({
    path: `${process.env.TMPDIR ?? '/tmp'}/draftbench-welcome.png`,
    fullPage: true,
  })
})
