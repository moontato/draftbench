import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import packageMetadata from '../../package.json' with { type: 'json' }
import { defaultSettings } from '../../src/settings/model'
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
  recovery?: {
    key: string
    projectRoot: string
    documentPath: string
    documentId: string
    text: string
    textHash: string
    diskHash: string
    capturedAt: number
  }[]
  reviewAction?: 'replace' | 'guide' | 'question'
  harperExplanation?: string
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
    let activeRoot = ''
    let callbackId = 0
    const callbacks = new Map<number, (event: unknown) => void>()
    let closeHandler = 0
    const calls: { command: string; args: Record<string, unknown> }[] = []
    const pendingRequests = new Map<string, () => void>()
    const metadata: Record<string, unknown> = seed.metadata ?? {}
    let savedSettings: unknown = seed.settings ?? null
    let recentProjects = seed.recentProjects ?? []
    let recovery = seed.recovery ?? []
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
        saveDelayMs: number
        openDelayMs: number
        keyDelayMs: number
        failSaves: boolean
        requestClose: () => void
        failReviews: boolean | string
        pauseReviews: boolean
        reviewDelayMs: number
        reviewConcurrency: {
          active: number
          peak: number
          byServer: Record<string, { active: number; peak: number; requests: number }>
        }
        readonly recentProjects: typeof recentProjects
        readonly recovery: typeof recovery
      }
    }
    testWindow.isTauri = true
    testWindow.fixture = {
      calls,
      files,
      metadata,
      saveDelayMs: 0,
      openDelayMs: 0,
      keyDelayMs: 0,
      failSaves: false,
      requestClose: () => {
        callbacks.get(closeHandler)?.({
          event: 'tauri://close-requested',
          id: closeHandler,
          payload: null,
        })
      },
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
      get recovery() {
        return recovery
      },
    }
    testWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    testWindow.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (callback: (event: unknown) => void) => {
        callbacks.set(++callbackId, callback)
        return callbackId
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id)
      },
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args })
        if (command === 'plugin:event|listen') {
          if (args.event === 'tauri://close-requested') closeHandler = Number(args.handler)
          return args.handler
        }
        if (command === 'plugin:dialog|open') return '/writing'
        if (command === 'plugin:dialog|confirm') return true
        if (command === 'plugin:dialog|message') return 'Ok'
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
          if (testWindow.fixture.openDelayMs)
            await new Promise((resolve) => setTimeout(resolve, testWindow.fixture.openDelayMs))
          if (seed.unavailableProjects?.includes(root)) throw 'Folder not found.'
          const name =
            root === '/writing' ? 'My writing' : root.split(/[\\/]/).filter(Boolean).at(-1)!
          if (!seed.recentWriteFails)
            recentProjects = [
              { path: root, name, lastOpened: Date.now() },
              ...recentProjects.filter((project) => project.path !== root),
            ].slice(0, 5)
          activeRoot = root
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
          if (testWindow.fixture.saveDelayMs)
            await new Promise((resolve) => setTimeout(resolve, testWindow.fixture.saveDelayMs))
          if (testWindow.fixture.failSaves) throw 'Could not safely save file: permission denied.'
          const previous = files[String(args.path)]
          if (previous !== undefined && args.expectedHash !== (await fileHash(previous)))
            throw 'CONFLICT: File changed on disk. Reload it or save a copy.'
          if (previous === undefined && args.expectedHash != null)
            throw 'CONFLICT: File was removed on disk. Save a copy.'
          files[String(args.path)] = String(args.content)
          return fileHash(files[String(args.path)])
        }
        if (command === 'delete_entry') {
          delete files[String(args.path)]
          return
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
        if (command === 'load_recovery') return { version: 1, records: structuredClone(recovery) }
        if (command === 'write_recovery') {
          const record = structuredClone(args.record) as {
            key: string
            documentPath: string
            text: string
            textHash: string
          }
          if (record.textHash !== (await fileHash(record.text)))
            throw 'Recovery snapshot is too large or malformed to store.'
          recovery = recovery.filter((item) => item.key !== record.key)
          recovery.push(record as (typeof recovery)[number])
          return
        }
        if (command === 'clear_recovery') {
          recovery =
            args.key == null ? [] : recovery.filter((item) => item.key !== String(args.key))
          return
        }
        if (
          (command === 'read_metadata' || command === 'write_metadata') &&
          args.projectRoot &&
          args.projectRoot !== activeRoot
        )
          throw 'Project changed; metadata was not read or written.'
        if (command === 'read_metadata') return metadata[String(args.name)] ?? null
        if (command === 'write_metadata') {
          metadata[String(args.name)] = args.value
          return
        }
        if (command === 'harper_review') {
          const text = String(args.text),
            match = /could\s+of/.exec(text),
            offset = match?.index ?? -1
          return offset < 0
            ? []
            : [
                {
                  offset,
                  quote: match![0],
                  category: 'harper-grammar',
                  severity: 'warning',
                  message: 'Use could have.',
                  explanation:
                    seed.harperExplanation ?? 'Could of is not the intended verb phrase.',
                  replacement: 'could have',
                  replacements: ['could have', "could've"],
                  confidence: 1,
                },
              ]
        }
        if (command === 'has_api_key') return false
        if (command === 'set_api_key') {
          if (testWindow.fixture.keyDelayMs)
            await new Promise((resolve) => setTimeout(resolve, testWindow.fixture.keyDelayMs))
          throw 'OS credential store unavailable; key is session-only.'
        }
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
                              action: seed.reviewAction ?? 'replace',
                              replacement:
                                !seed.reviewAction || seed.reviewAction === 'replace'
                                  ? 'The proposal is unclear.'
                                  : null,
                              guidance:
                                seed.reviewAction === 'question'
                                  ? 'Which proposal do you mean here?'
                                  : seed.reviewAction === 'guide'
                                    ? 'Name the proposal and the specific unresolved issue.'
                                    : null,
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

async function fixtureCallCount(page: Page, command: string): Promise<number> {
  return page.evaluate(
    (command) =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
        (call) => call.command === command,
      ).length,
    command,
  )
}

interface FixtureRecoveryRecord {
  key: string
  projectRoot: string
  documentPath: string
  documentId: string
  text: string
  textHash: string
  diskHash: string
  capturedAt: number
}
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
// Mirrors the native key: project root, NUL, document path.
function recoverySeed(
  root: string,
  documentPath: string,
  text: string,
  diskText: string,
  ageMs = 60_000,
): FixtureRecoveryRecord[] {
  return [
    {
      key: sha256(`${root}\u0000${documentPath}`),
      projectRoot: root,
      documentPath,
      documentId: 'recovered-document',
      text,
      textHash: sha256(text),
      diskHash: sha256(diskText),
      capturedAt: Date.now() - ageMs,
    },
  ]
}
async function fixtureRecovery(page: Page): Promise<FixtureRecoveryRecord[]> {
  return page.evaluate(() =>
    structuredClone(
      (window as unknown as { fixture: { recovery: FixtureRecoveryRecord[] } }).fixture.recovery,
    ),
  )
}
async function fixtureFile(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (path) =>
      (window as unknown as { fixture: { files: Record<string, string> } }).fixture.files[path],
    path,
  )
}
async function writeFixtureFile(page: Page, path: string, content: string): Promise<void> {
  await page.evaluate(
    ([path, content]) => {
      ;(window as unknown as { fixture: { files: Record<string, string> } }).fixture.files[path] =
        content
    },
    [path, content],
  )
}
async function openEssay(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
}

// Restart the renderer with only the native-owned files/settings/sidecars.
// No editor state, block identities, request cache objects or React state survive.
async function restartFixture(page: Page): Promise<Page> {
  const seed = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          files: Record<string, string>
          metadata: Record<string, unknown>
          settings: unknown
          recovery: FixtureRecoveryRecord[]
        }
      }
    ).fixture
    return structuredClone({
      files: fixture.files,
      metadata: fixture.metadata,
      settings: fixture.settings,
      recovery: fixture.recovery,
    })
  })
  const restarted = await page.context().newPage()
  await page.close()
  await installDesktopFixture(restarted, seed)
  await restarted.goto('/')
  await restarted.getByRole('button', { name: 'Open a writing folder' }).click()
  await restarted.getByRole('button', { name: 'essay', exact: true }).click()
  return restarted
}

async function runReviewers(
  page: Page,
  names: string[] | undefined,
  scope: 'document' | 'selection' | 'block' = 'document',
  force = false,
) {
  const menu = page.locator('.reviewer-run-menu')
  await menu.locator('summary').click()
  await menu.getByLabel('Review scope').selectOption(scope)
  await menu.getByRole('button', { name: 'Clear', exact: true }).click()
  if (names) {
    for (const name of names) await menu.getByRole('checkbox', { name, exact: true }).check()
  } else await menu.getByRole('button', { name: 'Select all', exact: true }).click()
  await menu
    .getByRole('checkbox', { name: 'Force rerun (bypass cache)', exact: true })
    .setChecked(force)
  await menu.getByRole('button', { name: /^Run selected \(\d+\)$/ }).click()
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
  await runReviewers(page, ['Clarity'])
  await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await expect(
    page.getByText('Name the proposal instead of using an unclear reference.'),
  ).toBeVisible()
  await expect(editor).toContainText('This is unclear.')
  await page.getByRole('button', { name: 'Apply suggestion' }).click()
  await expect(editor).toContainText('The proposal is unclear.')
  const suggestion = page.getByRole('button', { name: /Unclear referent hides the point/ })
  await expect(suggestion).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(editor).toContainText('This is unclear.')
  await expect(suggestion).toBeVisible()
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(editor).toContainText('The proposal is unclear.')
  await expect(suggestion).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(suggestion).toBeVisible()
  await suggestion.click()
  await expect(page.getByRole('button', { name: 'Apply suggestion' })).toBeEnabled()
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
  await runReviewers(page, ['Clarity'])
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
  await runReviewers(page, ['Clarity'])
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

test('filtering the analysis pane also limits the editor underlines', async ({ page }) => {
  const settings = defaultSettings()
  settings.analyzers.harper.enabled = true
  await installDesktopFixture(page, {
    settings,
    files: { 'essay.md': 'The the plan has merit. She could of finished the report.\n' },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const repeated = page.locator(
    '.editor-scroll [data-finding][title="“The” appears twice in a row."]',
  )
  const harper = page.locator('.editor-scroll [data-finding][title="Use could have."]')
  await expect(repeated).toBeVisible()
  await runReviewers(page, ['Harper'])
  await expect(harper).toBeVisible()
  await expect(page.locator('.editor-scroll [data-finding]')).toHaveCount(2)

  // Only the selected reviewer stays listed and underlined.
  await page.getByLabel('Filter by analyzer').selectOption('harper')
  await expect(harper).toBeVisible()
  await expect(repeated).toHaveCount(0)
  await expect(page.locator('.finding-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /1 hidden by filters/ })).toBeVisible()

  // Severity narrows the same shared view, so the remaining warning disappears too.
  await page.getByLabel('Filter by severity').selectOption('info')
  await expect(page.locator('.editor-scroll [data-finding]')).toHaveCount(0)
  await expect(page.locator('.finding-card')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /2 hidden by filters/ })).toBeVisible()

  await page.getByRole('button', { name: /hidden by filters/ }).click()
  await expect(page.getByLabel('Filter by analyzer')).toHaveValue('all')
  await expect(page.getByLabel('Filter by severity')).toHaveValue('all')
  await expect(page.locator('.editor-scroll [data-finding]')).toHaveCount(2)
  await expect(page.getByRole('button', { name: /hidden by filters/ })).toHaveCount(0)

  // A dismissed finding stays listed when asked, but it is never underlined again.
  await harper.click()
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await page.getByLabel('Show dismissed').check()
  await expect(page.getByRole('button', { name: /Use could have/ })).toBeVisible()
  await expect(harper).toHaveCount(0)
  await expect(page.locator('.editor-scroll [data-finding]')).toHaveCount(1)
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

test('reopening restores saved feedback without inference; external edits reject it and config changes block Apply', async ({
  page,
  context,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(page.getByText('“The” appears twice in a row.')).toBeVisible()
  await runReviewers(page, ['Clarity'])
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
  await expect(reopened.locator('.analysis-status')).toContainText('Saved feedback')
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
  await expect(changed.locator('.analysis-status')).toContainText('not restored')
  await expect(
    changed.getByRole('button', { name: /Unclear referent hides the point/ }),
  ).toHaveCount(0)
  const configured = await openSaved({ ...seed, settings: { ai: { model: 'another-model' } } })
  await expect(configured.locator('.analysis-status')).toContainText('includes previous reviews')
  const previous = configured.getByRole('button', { name: /Unclear referent hides the point/ })
  await expect(previous).toContainText('Reviewer settings changed · rerun')
  await previous.click()
  await expect(configured.getByRole('button', { name: 'Apply suggestion' })).toBeDisabled()
  expect(
    await configured.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (call) => call.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
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
    await runReviewers(page, ['Clarity'])
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
  await runReviewers(page, ['Clarity'])
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
  await runReviewers(page, ['Clarity'])
  await expect(page.locator('.analysis-status')).toContainText('Reviewing with Clarity')
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('Analysis cancelled')
  await runReviewers(page, ['Clarity'])
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
  await runReviewers(page, ['Clarity'])
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
  await runReviewers(page, ['Clarity'])
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
  await expect(page.locator('.analysis-status')).toContainText('15 cached reviews')
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
  await runReviewers(page, undefined, 'document', true)
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
    4,
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
  await runReviewers(page, ['Redundancy'])
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
    5,
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
  await runReviewers(page, ['Redundancy'])
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
  await expect(reopened.locator('.analysis-status')).toContainText('Saved feedback')
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

test('reviewer checkboxes run only a chosen batch, reuse cache, and keep session choices across documents', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    files: {
      'essay.md':
        '# A better report\n\nThe the plan has merit.\n\nThis is unclear.\n\nA separate paragraph gives the reader context.\n',
      'notes.md': 'Some separate notes.\n',
    },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const menu = page.locator('.reviewer-run-menu')
  const requests = () =>
    page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'ai_http',
        ).length,
    )
  await menu.locator('summary').click()
  await menu.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(menu.getByRole('button', { name: 'Run selected (0)', exact: true })).toBeDisabled()
  await menu.getByRole('checkbox', { name: 'Clarity', exact: true }).check()
  await menu.getByRole('checkbox', { name: 'Development', exact: true }).check()
  await expect(menu.getByRole('button', { name: 'Run selected (2)', exact: true })).toBeVisible()
  expect(await requests()).toBe(0)
  await menu.getByRole('button', { name: 'Run selected (2)', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('2 findings')
  await expect.poll(requests).toBe(5) // Four nearby Clarity units, one Development unit.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fixture: {
                metadata: { analysis: { history: { runs: { reviewers: { id: string }[] }[] } } }
              }
            }
          ).fixture.metadata.analysis?.history?.runs[0]?.reviewers.map((r) => r.id) ?? [],
      ),
    )
    .toEqual(['clarity', 'development'])
  await menu.locator('summary').click()
  await expect(menu.getByRole('checkbox', { name: 'Clarity', exact: true })).toBeChecked()
  await expect(menu.getByRole('checkbox', { name: 'Development', exact: true })).toBeChecked()
  await expect(menu.getByRole('checkbox', { name: 'Structure', exact: true })).not.toBeChecked()
  await menu.getByRole('button', { name: 'Run selected (2)', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('5 cached reviews')
  expect(await requests()).toBe(5)
  await menu.locator('summary').click()
  await menu.getByRole('checkbox', { name: 'Force rerun (bypass cache)', exact: true }).check()
  expect(await requests()).toBe(5)
  await menu.getByRole('button', { name: 'Run selected (2)', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('2 findings')
  await expect.poll(requests).toBe(10)
  await expect(page.getByRole('button', { name: 'Analyze document', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'notes', exact: true }).click()
  await menu.locator('summary').click()
  await expect(menu.getByRole('checkbox', { name: 'Clarity', exact: true })).toBeChecked()
  await expect(menu.getByRole('checkbox', { name: 'Development', exact: true })).toBeChecked()
  await menu.getByLabel('Review scope').selectOption('block')
  await expect(menu.getByRole('checkbox', { name: 'Development', exact: true })).toBeDisabled()
  await expect(menu.getByRole('button', { name: 'Run selected (1)', exact: true })).toBeVisible()
  await menu.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(menu.getByRole('button', { name: 'Run selected (0)', exact: true })).toBeDisabled()
  expect(await requests()).toBe(10)
  await page.keyboard.press('Escape')
  await expect(menu.locator('summary')).toBeFocused()
})

for (const action of ['guide', 'question'] as const) {
  test(`${action} feedback has no Apply action and survives cache reuse and saved-review restoration`, async ({
    page,
    context,
  }) => {
    await installDesktopFixture(page, { reviewAction: action })
    await page.goto('/')
    await page.getByRole('button', { name: 'Open a writing folder' }).click()
    await page.getByRole('button', { name: 'essay', exact: true }).click()
    await runReviewers(page, ['Clarity'])
    await expect(page.locator('.analysis-status')).toContainText('findings ·')
    await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
    const label = action === 'question' ? 'A QUESTION FOR YOU' : 'REVISION GUIDANCE'
    const text =
      action === 'question'
        ? 'Which proposal do you mean here?'
        : 'Name the proposal and the specific unresolved issue.'
    await expect(page.getByText(label, { exact: true })).toBeVisible()
    await expect(page.getByText(text, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apply suggestion' })).toHaveCount(0)
    const requests = await page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'ai_http',
        ).length,
    )
    await runReviewers(page, ['Clarity'])
    await expect(page.locator('.analysis-status')).toContainText('cached reviews')
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
            (c) => c.command === 'ai_http',
          ).length,
      ),
    ).toBe(requests)
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
    await installDesktopFixture(reopened, { ...seed, reviewAction: action })
    await reopened.goto('/')
    await reopened.getByRole('button', { name: 'Open a writing folder' }).click()
    await reopened.getByRole('button', { name: 'essay', exact: true }).click()
    await expect(reopened.locator('.analysis-status')).toContainText('Saved feedback')
    await reopened.getByRole('button', { name: /Unclear referent hides the point/ }).click()
    await expect(reopened.getByText(label, { exact: true })).toBeVisible()
    await expect(reopened.getByText(text, { exact: true })).toBeVisible()
    await expect(reopened.getByRole('button', { name: 'Apply suggestion' })).toHaveCount(0)
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
}

test('revision mode pins a passage and feedback while editing; stale advice cannot be applied', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await runReviewers(page, ['Clarity'])
  await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  await expect(reference.getByRole('heading', { name: 'Revision reference' })).toBeVisible()
  await expect(page.getByText('LIVE DRAFT', { exact: true })).toBeVisible()
  await expect(reference.locator('.revision-quote')).toHaveText('This is unclear.')
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  await expect(reference.locator('.revision-actions button.primary-button')).toBeEnabled()
  await expect(page.locator('.revision-resize')).toHaveCount(0)
  // The pinned reference is read-only; the live draft keeps accepting edits.
  await page.locator('.prose p', { hasText: 'This is unclear.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' More.')
  await expect(editor).toContainText('This is unclear. More.')
  await expect(reference.locator('.revision-quote')).toHaveText('This is unclear.')
  await expect(reference.locator('.revision-state')).toHaveText('Review context changed')
  await expect(reference.locator('.revision-actions button.primary-button')).toBeDisabled()
  // Exact Undo restores both the text and the original review snapshot.
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(editor).toContainText('This is unclear.')
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  await expect(reference.locator('.revision-actions button.primary-button')).toBeEnabled()
  // Jump selects the mapped reference location in the live draft.
  await reference.getByRole('button', { name: 'Jump to draft' }).click()
  await page.waitForSelector('.ProseMirror-focused')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X')
  await expect(page.locator('.prose p', { hasText: 'XThis is unclear.' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(editor).toContainText('This is unclear.')
  // A user-initiated rerun explicitly refreshes the captured advice.
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { reviewDelayMs: number } }).fixture.reviewDelayMs = 250
  })
  await reference.getByRole('button', { name: 'Re-review paragraph' }).click()
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  await expect(reference.locator('.revision-run-status')).toContainText('findings')
  await reference.getByRole('button', { name: 'Apply suggestion' }).click()
  await expect(editor).toContainText('The proposal is unclear.')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await expect(reference.getByRole('button', { name: 'Re-review paragraph' })).toBeEnabled()
  await expect(reference.getByRole('button', { name: 'Jump to draft' })).toBeDisabled()
  await reference.getByRole('button', { name: 'Re-review paragraph' }).click()
  await expect(reference.locator('.revision-run-status .spinner')).toBeVisible()
  await expect(reference.locator('.revision-run-status .spinner')).toHaveCount(0)
  await expect(reference.locator('.revision-state')).toHaveText('No issues detected')
  await expect(reference.locator('.revision-message')).toHaveCount(0)
  await expect(reference.getByRole('button', { name: 'Apply suggestion' })).toHaveCount(0)
  // Exiting returns to the normal three-pane layout.
  await page.getByRole('button', { name: 'Exit revision mode' }).click()
  await expect(reference).toHaveCount(0)
  await expect(page.locator('.documents-pane')).toBeVisible()
  await expect(page.locator('.analysis-pane')).toBeVisible()
})

test('repeated underline clicks place the caret and exact keyboard Undo restores review state', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await runReviewers(page, ['Clarity'])
  const underline = page.locator(
    '.editor-scroll [data-finding][title="Unclear referent hides the point."]',
  )
  const selectionText = () => page.evaluate(() => window.getSelection()?.toString())
  const caretPlaced = () =>
    page.evaluate(() => {
      const selection = window.getSelection()
      return (
        !!selection?.isCollapsed && !!selection.anchorNode?.parentElement?.closest('.ProseMirror')
      )
    })
  await underline.click()
  await expect.poll(selectionText).toBe('This is unclear.')
  for (const x of [8, 30, 65, 20]) {
    await underline.click({ position: { x, y: 8 } })
    await expect.poll(caretPlaced).toBe(true)
  }
  await page.keyboard.type('X')
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toContainText('X')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(underline).toHaveText('This is unclear.')
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toBeVisible()
  await underline.click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  await reference.getByRole('button', { name: 'Jump to draft' }).click()
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toBeFocused()
  await page.keyboard.type('A different point.')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await expect(reference.getByRole('button', { name: 'Apply suggestion' })).toBeDisabled()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  await expect(reference.getByRole('button', { name: 'Apply suggestion' })).toBeEnabled()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await expect(reference.getByRole('button', { name: 'Apply suggestion' })).toBeDisabled()
})

test('explicit re-review replaces captured feedback in place and displays a clean result', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await runReviewers(page, ['Clarity'])
  const initialRequests = await page.evaluate(
    () =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
        (call) => call.command === 'ai_http',
      ).length,
  )
  await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  await reference.getByRole('button', { name: 'Jump to draft' }).click()
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.type(' More detail.')
  await expect(reference.locator('.revision-passage')).not.toContainText('More detail.')
  await expect(reference.getByRole('button', { name: 'Apply suggestion' })).toBeDisabled()
  await reference.getByRole('button', { name: 'Re-review paragraph' }).click()
  await expect(reference.locator('.revision-passage')).toContainText(
    'This is unclear. More detail.',
  )
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  await expect(reference.getByRole('button', { name: 'Apply suggestion' })).toBeEnabled()
  await reference.getByRole('button', { name: 'Jump to draft' }).click()
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toBeFocused()
  await page.keyboard.type('The proposal is clear.')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await reference.getByRole('button', { name: 'Re-review paragraph' }).click()
  await expect(reference.locator('.revision-state')).toHaveText('No issues detected')
  await expect(reference.locator('.revision-passage')).toContainText(
    'The proposal is clear. More detail.',
  )
  await expect(reference.locator('.revision-message')).toHaveCount(0)
  await expect(reference.getByRole('button', { name: 'Apply suggestion' })).toHaveCount(0)
  await reference.getByRole('button', { name: 'Choose another finding' }).click()
  await expect(page.getByRole('button', { name: /appears twice in a row/ })).toBeVisible()
  const requests = await page.evaluate(
    () =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
        (call) => call.command === 'ai_http',
      ).length,
  )
  expect(requests).toBe(initialRequests + 2)
})

test('edited feedback survives save/restart; clicks do not recapture it and a later re-review persists without another save', async ({
  page,
}) => {
  const cardFor = (target: Page, reviewer: string) =>
    target
      .locator('.finding-group')
      .filter({ has: target.getByRole('heading', { name: new RegExp(`^${reviewer}`) }) })
      .getByRole('button', { name: /Unclear referent hides the point/ })
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await runReviewers(page, ['Clarity', 'Redundancy'])
  await expect(cardFor(page, 'Redundancy')).toBeVisible()
  await cardFor(page, 'Clarity').click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.locator('p').filter({ hasText: 'This is unclear.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Extra prose.')
  await expect(reference.locator('.revision-state')).toHaveText('Review context changed')
  for (let i = 0; i < 4; i++) {
    await page.locator('.editor-scroll [data-finding]').first().click()
    await page.locator('.editor-scroll [data-finding]').last().click()
    await editor.locator('p').last().click()
    await expect(reference.locator('.revision-quote')).toHaveText('This is unclear.')
    await expect(reference.locator('.revision-state')).toHaveText('Review context changed')
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const reopened = await restartFixture(page)
  const card = cardFor(reopened, 'Clarity')
  await expect(cardFor(reopened, 'Redundancy')).toBeVisible()
  await expect(card).toBeVisible()
  await card.click()
  await expect(
    reopened.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeDisabled()
  await reopened.getByRole('button', { name: 'Revise', exact: true }).click()
  const restoredReference = reopened.locator('.revision-pane')
  await expect(restoredReference.locator('.revision-state')).toHaveText('Review context changed')
  expect(
    await reopened.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (call) => call.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
  await restoredReference.getByRole('button', { name: 'Re-review paragraph' }).click()
  await expect(restoredReference.locator('.revision-state')).toHaveText('Passage still matches')
  await expect(restoredReference.getByRole('button', { name: 'Re-review paragraph' })).toBeEnabled()
  // The saved draft did not change; no extra Save is required to retain a new review.
  const reviewedRestart = await restartFixture(reopened)
  await expect(cardFor(reviewedRestart, 'Clarity')).toBeVisible()
  await cardFor(reviewedRestart, 'Clarity').click()
  await expect(
    reviewedRestart.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeEnabled()
  // Re-reviewing Clarity must not discard another reviewer's previous feedback.
  await cardFor(reviewedRestart, 'Redundancy').click()
  await expect(
    reviewedRestart.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeDisabled()
  expect(
    await reviewedRestart.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (call) => call.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
})

test('unaffected AI feedback stays applicable after unrelated editing, saving and restarting', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    files: {
      'essay.md':
        'The the plan has merit.\n\nThis is unclear.\n\nNearby context.\n\nUnrelated final paragraph.\n',
    },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await runReviewers(page, ['Clarity'])
  await expect(page.getByRole('button', { name: /Unclear referent hides the point/ })).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' More unrelated prose.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const reopened = await restartFixture(page)
  await reopened.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await expect(
    reopened.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeEnabled()
  await reopened.getByRole('button', { name: 'Revise', exact: true }).click()
  await expect(reopened.locator('.revision-state')).toHaveText('Passage still matches')
  expect(
    await reopened.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (call) => call.command === 'ai_http',
        ).length,
    ),
  ).toBe(0)
})

test('revision mode changes its pin only explicitly and adapts to a narrow dock', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await runReviewers(page, ['Clarity'])
  await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  await expect(reference.locator('.revision-quote')).toHaveText('This is unclear.')
  // Ordinary editor clicks never change the reference, even on unrelated feedback.
  await page.locator('.editor-scroll [data-finding][title="“The” appears twice in a row."]').click()
  await expect(reference.locator('.revision-quote')).toHaveText('This is unclear.')
  await reference.getByRole('button', { name: 'Choose another finding' }).click()
  await page.getByRole('button', { name: /“The” appears twice in a row/ }).click()
  await page.getByRole('button', { name: 'New reference', exact: true }).click()
  await expect(reference.locator('.revision-quote')).toHaveText('The the')
  await expect(reference.locator('.revision-message')).toHaveText('“The” appears twice in a row.')
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  // A narrow window turns the side pane into a collapsible bottom dock.
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect(page.locator('.workspace.revision-compact')).toBeVisible()
  await expect(reference.locator('.revision-resize')).toBeVisible()
  // The dock must fill the single-column workspace, not an overridden first column.
  await expect
    .poll(async () => {
      const dock = await reference.boundingBox()
      const workspace = await page.locator('.workspace').boundingBox()
      return dock && workspace ? Math.abs(dock.width - workspace.width) : Infinity
    })
    .toBeLessThan(2)
  const separator = reference.getByRole('separator')
  await separator.focus()
  await separator.press('End')
  await expect(separator).toHaveAttribute(
    'aria-valuenow',
    (await separator.getAttribute('aria-valuemax')) ?? '',
  )
  await separator.press('Home')
  await expect(separator).toHaveAttribute(
    'aria-valuenow',
    (await separator.getAttribute('aria-valuemin')) ?? '',
  )
  const toggle = reference.locator('.revision-toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(reference.locator('.revision-content')).toBeHidden()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(reference.locator('.revision-content')).toBeVisible()
  // Choosing another finding closes the reference and restores the analysis pane.
  await reference.getByRole('button', { name: 'Choose another finding' }).click()
  await expect(reference).toHaveCount(0)
  await expect(page.locator('.analysis-pane')).toBeVisible()
})

test('profile switches and Undo keep old genre findings flagged until a fresh rerun', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByLabel('Writing profile').selectOption('essay')
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('findings ·')
  await page.getByLabel('Filter by analyzer').selectOption('clarity')
  await page.getByRole('button', { name: /Unclear referent hides the point/ }).click()
  await page.getByRole('button', { name: 'Apply suggestion' }).click()
  await page.getByLabel('Writing profile').selectOption('technical')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByLabel('Filter by analyzer').selectOption('all')
  await expect(page.getByText('Needs a rerun for this profile')).toHaveCount(2)
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('findings ·')
  await expect(page.getByText('Needs a rerun for this profile')).toHaveCount(0)
})

test('profile changes keep shared findings and flag genre-specific reviews for rerun', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(page.getByLabel('Writing profile')).toHaveValue('general')
  await page.getByLabel('Writing profile').selectOption('essay')
  await expect(page.getByLabel('Writing profile')).toHaveValue('essay')
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.locator('.analysis-status')).toContainText('findings ·')
  // Essay → General prose: shared reviewers keep their findings; Development and
  // Structure now use different genre guidance, so they are flagged for a rerun.
  await page.getByLabel('Writing profile').selectOption('general')
  await expect(page.locator('.analysis-status')).toContainText('Shared reviews kept')
  await expect(page.getByText('Needs a rerun for this profile')).toHaveCount(2)
  // General prose → Professional email: those reviewers are disabled outright.
  await page.getByLabel('Writing profile').selectOption('email')
  await expect(page.getByText('Reviewer disabled in this profile')).toHaveCount(2)
  await page.getByLabel('Writing profile').selectOption('essay')
  await expect(page.getByText('Reviewer disabled in this profile')).toHaveCount(0)
  await expect(page.getByText('Needs a rerun for this profile')).toHaveCount(0)
  // Shared reviewers remain applicable under any profile.
  await page.getByLabel('Filter by analyzer').selectOption('clarity')
  const clarityCard = page.getByRole('button', { name: /Unclear referent hides the point/ })
  await expect(clarityCard).toHaveCount(1)
  await clarityCard.click()
  await expect(page.getByRole('button', { name: 'Apply suggestion' })).toBeEnabled()
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
    .getByRole('checkbox', { name: /^Harper\b/ })
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
  await expect(reopened.locator('.analysis-status')).toContainText('Saved feedback')
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

test('Analysis groups automatic review under Harper and separates the cache action', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: 'Analysis', exact: true }).click()
  const harper = dialog.getByRole('region', { name: 'Harper analyzer settings', exact: true })
  const automatic = harper.getByRole('checkbox', { name: 'Automatically review with Harper' })
  await expect(automatic).not.toBeChecked()
  await expect(
    dialog.getByRole('checkbox', { name: 'Automatically review with Harper' }),
  ).toHaveCount(1)
  const cache = dialog.getByRole('button', { name: 'Clear analysis cache', exact: true })
  await cache.scrollIntoViewIfNeeded()
  const [managerBox, cacheBox] = await Promise.all([
    dialog.locator('.analyzer-manager').boundingBox(),
    cache.boundingBox(),
  ])
  expect(managerBox).not.toBeNull()
  expect(cacheBox).not.toBeNull()
  expect(cacheBox!.y - (managerBox!.y + managerBox!.height)).toBeGreaterThanOrEqual(24)
  await automatic.check()
  await expect(harper.getByRole('checkbox', { name: /^Harper\b/ })).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Analyzers', exact: true }).click()
  await expect(automatic).toBeChecked()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await fixtureCallCount(page, 'save_settings')).toBe(0)
})

test('Analyzers settings align metadata, fields and actions under the analyzer name', async ({
  page,
}) => {
  const settings = defaultSettings()
  settings.analyzers.harper.enabled = true
  await installDesktopFixture(page, { settings })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: 'Analyzers', exact: true }).click()
  const edges = async (region: string, parts: Record<string, string>) => {
    const block = dialog.getByRole('region', { name: region, exact: true })
    await block.scrollIntoViewIfNeeded()
    const checkbox = (await block.locator('input[type="checkbox"]').first().boundingBox())!
    const boxes = await Promise.all(
      Object.entries(parts).map(
        async ([key, selector]) => [key, await block.locator(selector).boundingBox()] as const,
      ),
    )
    const left = new Map<string, number>()
    for (const [key, box] of boxes) {
      expect(box, key).not.toBeNull()
      left.set(key, box!.x)
    }
    // The checkbox stays at the section edge; everything below it shares one edge.
    expect(
      [...new Set(left.values())],
      [...left].map(([k, v]) => `${k}=${v}`).join(' '),
    ).toHaveLength(1)
    expect([...left.values()][0]).toBeGreaterThan(checkbox.x)
    return left
  }
  await edges('Clarity analyzer settings', {
    description: 'p',
    origin: 'small >> nth=0',
    backend: '.small-field >> nth=0',
    model: '.small-field >> nth=1',
    effective: 'small >> nth=1',
    actions: '.management-actions',
  })
  await edges('Harper analyzer settings', {
    description: 'p >> nth=0',
    origin: 'small',
    automatic: '.analyzer-auto-review',
  })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await fixtureCallCount(page, 'save_settings')).toBe(0)
})

test('automatic Harper defaults off, explicit selection works, and the independent preference persists across restart', async ({
  page,
}) => {
  const settings = defaultSettings()
  settings.analyzers.harper.enabled = true
  await installDesktopFixture(page, {
    settings,
    files: { 'essay.md': 'The the draft. She could of finished the report.\n' },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(page.getByRole('button', { name: /“The” appears twice in a row/ })).toBeVisible()
  expect(await fixtureCallCount(page, 'harper_review')).toBe(0)
  await page.getByRole('button', { name: 'Analyze document', exact: true }).click()
  await expect(page.locator('.analysis-status')).toContainText('cached reviews')
  expect(await fixtureCallCount(page, 'harper_review')).toBe(0)
  await page.getByLabel('Filter by analyzer').selectOption('harper')
  await page
    .locator('.analysis-empty')
    .getByRole('button', { name: 'Analyze document', exact: true })
    .click()
  await expect(page.getByRole('button', { name: /Use could have/ })).toBeVisible()
  await expect(page.locator('.analysis-status')).toContainText('cached reviews')
  expect(await fixtureCallCount(page, 'harper_review')).toBe(1)
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  const toggle = page.getByRole('checkbox', { name: 'Automatically review with Harper' })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await page.getByRole('button', { name: 'Save settings' }).click()
  const before = await fixtureCallCount(page, 'harper_review')
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Extra prose.')
  await expect.poll(() => fixtureCallCount(page, 'harper_review')).toBeGreaterThan(before)
  await expect(page.getByRole('button', { name: /Use could have/ })).not.toContainText(
    'Previous review',
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const reopened = await restartFixture(page)
  await expect(reopened.getByRole('button', { name: /Use could have/ })).toBeVisible()
  await reopened.getByRole('button', { name: 'Open settings' }).click()
  await reopened.getByRole('button', { name: 'Analysis', exact: true }).click()
  await expect(
    reopened.getByRole('checkbox', { name: 'Automatically review with Harper' }),
  ).toBeChecked()
  await reopened.getByRole('checkbox', { name: 'Automatically review with Harper' }).uncheck()
  await reopened.getByRole('button', { name: 'Save settings' }).click()
  const offCalls = await fixtureCallCount(reopened, 'harper_review')
  const repeated = reopened.locator(
    '.editor-scroll [data-finding][title="“The” appears twice in a row."]',
  )
  await expect(repeated).toBeVisible()
  const previousId = await repeated.getAttribute('data-finding')
  await reopened.getByRole('textbox', { name: 'Document writing editor' }).click()
  await reopened.keyboard.press('Control+End')
  await reopened.keyboard.type(' Automatic Harper is off.')
  await expect.poll(() => repeated.getAttribute('data-finding')).not.toBe(previousId)
  expect(await fixtureCallCount(reopened, 'harper_review')).toBe(offCalls)
  await expect(reopened.getByRole('button', { name: /Use could have/ })).toContainText(
    'Previous review',
  )
  await runReviewers(reopened, ['Harper'], 'document', true)
  await expect.poll(() => fixtureCallCount(reopened, 'harper_review')).toBe(offCalls + 1)
  await expect(reopened.getByRole('button', { name: /Use could have/ })).not.toContainText(
    'Previous review',
  )
  await reopened.getByRole('button', { name: /Use could have/ }).click()
  await expect(
    reopened.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeEnabled()
})

test('closing and reopening a regenerated Harper warning resumes its original reference until explicit Re-review', async ({
  page,
}) => {
  const settings = defaultSettings()
  settings.analyzers.harper.enabled = true
  settings.analysis.autoHarper = true
  await installDesktopFixture(page, {
    settings,
    files: { 'essay.md': 'She could of finished the report.\n\nUnrelated context.\n' },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('button', { name: /Use could have/ }).click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  await reference.getByRole('button', { name: 'Jump to draft' }).click()
  await expect(page.locator('.ProseMirror-focused')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.type(' ')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await reference.getByRole('button', { name: 'Close revision reference' }).click()
  await expect(reference).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume revision', exact: true })).toBeVisible()
  // The automatic recheck returns a NEW finding over the changed quote.
  const warning = page.getByRole('button', { name: /Use could have/ })
  await expect(warning).toBeVisible()
  await page.locator('.editor-scroll [data-finding][title="Use could have."]').click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  await expect(reference.locator('.revision-quote')).toHaveText('could of')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await expect(reference.getByRole('button', { name: 'Jump to draft' })).toBeDisabled()
  await expect(
    reference.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Exit revision mode', exact: true }).click()
  await page.getByRole('textbox', { name: 'Document writing editor' }).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' More context while the panel is closed.')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Automatically review with Harper' }).uncheck()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.getByRole('button', { name: 'Resume revision', exact: true }).click()
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  const manualCalls = await fixtureCallCount(page, 'harper_review')
  await reference.getByRole('button', { name: 'Re-review paragraph' }).click()
  await expect(reference.locator('.revision-state')).toHaveText('Passage still matches')
  expect(await reference.locator('.revision-quote').textContent()).not.toBe('could of')
  expect(await fixtureCallCount(page, 'harper_review')).toBe(manualCalls + 1)
  await expect(
    reference.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeEnabled()
  expect(await fixtureCallCount(page, 'ai_http')).toBe(0)
})

test('Repeated word also resumes the old local reference and keeps it after its live finding disappears', async ({
  page,
}) => {
  await installDesktopFixture(page, { files: { 'essay.md': 'The the plan has merit.\n' } })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const warning = page.getByRole('button', { name: /“The” appears twice in a row/ })
  await warning.click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  await reference.getByRole('button', { name: 'Jump to draft' }).click()
  await expect(page.locator('.ProseMirror-focused')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.type(' ')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await reference.getByRole('button', { name: 'Close revision reference' }).click()
  await warning.click()
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  expect(await reference.locator('.revision-quote').textContent()).toBe('The the')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await expect(
    reference.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Exit revision mode', exact: true }).click()
  await page.getByRole('textbox', { name: 'Document writing editor' }).click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+Delete')
  await expect(warning).toHaveCount(0)
  await page.getByRole('button', { name: 'Resume revision', exact: true }).click()
  expect(await reference.locator('.revision-quote').textContent()).toBe('The the')
  await expect(reference.locator('.revision-state')).toHaveText('Edited since reference')
  await reference.getByRole('button', { name: 'Re-review paragraph' }).click()
  await expect(reference.locator('.revision-state')).toHaveText('No issues detected')
  await expect(
    reference.getByRole('button', { name: 'Apply suggestion', exact: true }),
  ).toHaveCount(0)
  expect(await fixtureCallCount(page, 'ai_http')).toBe(0)
})

test('Harper findings share inline review, suggestion choice and normal Undo/Redo without AI or code linting', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    files: {
      'essay.md':
        'She **could of** finished the report.\n\n```text\nShe could of finished in code.\n```\n',
    },
    harperExplanation: 'Use could have.',
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click()
  await page
    .getByRole('region', { name: 'Harper analyzer settings', exact: true })
    .getByRole('checkbox', { name: /^Harper\b/ })
    .check()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await runReviewers(page, ['Harper'])
  await expect(page.getByRole('button', { name: /Use could have/ })).toHaveCount(1)
  await expect(page.locator('.diagnostic')).toHaveCount(1)
  await page.getByRole('button', { name: /Use could have/ }).click()
  await page.getByLabel('Suggested replacement').selectOption('1')
  await page.getByRole('button', { name: 'Revise', exact: true }).click()
  const reference = page.locator('.revision-pane')
  await expect(reference.locator('.revision-message')).toHaveText('Use could have.')
  await expect(reference.locator('.revision-explanation')).toHaveCount(0)
  await expect(reference.getByLabel('Suggested replacement')).toHaveValue('1')
  await reference.getByRole('button', { name: 'Apply suggestion', exact: true }).click()
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

test('Harper reviews prose around inline code and never underlines the code span', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    files: { 'essay.md': 'Use `could of` in code and she could of finished the report.\n' },
    harperExplanation: 'Use could have.',
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click()
  await page
    .getByRole('region', { name: 'Harper analyzer settings', exact: true })
    .getByRole('checkbox', { name: /^Harper\b/ })
    .check()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await runReviewers(page, ['Harper'])
  // The code span is masked at identical length, so only the prose occurrence is linted.
  await expect(page.getByRole('button', { name: /Use could have/ })).toHaveCount(1)
  const underline = page.locator('.editor-scroll .diagnostic')
  await expect(underline).toHaveCount(1)
  await expect(underline).toHaveText('could of')
  await expect(page.locator('.tiptap code')).toHaveText('could of')
  await expect(page.locator('.tiptap code .diagnostic')).toHaveCount(0)
  await page.getByRole('button', { name: /Use could have/ }).click()
  await page.getByRole('button', { name: 'Apply suggestion', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { files: Record<string, string> } }).fixture.files[
          'essay.md'
        ],
    ),
  ).toBe('Use `could of` in code and she could have finished the report.\n')
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

async function patchFixture(
  page: import('@playwright/test').Page,
  values: Record<string, unknown>,
) {
  await page.evaluate(
    (values) => Object.assign((window as unknown as { fixture: object }).fixture, values),
    values,
  )
}
async function closeFixture(page: import('@playwright/test').Page) {
  await page.evaluate(() =>
    (window as unknown as { fixture: { requestClose: () => void } }).fixture.requestClose(),
  )
}
test('stabilization: copy/save/close locks preserve the draft and original; failed leave-save never switches', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    files: {
      'essay.md': '# Essay\n\nOriginal writing.\n',
      'other.md': '# Other\n\nOther writing.\n',
    },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Unsaved author text.')
  await page.getByLabel('Document actions').click()
  await page.getByRole('button', { name: 'Save a copy…' }).click()
  const copy = page.getByRole('dialog', { name: 'Save a copy', exact: true })
  await expect(copy).toBeVisible()
  await page.keyboard.press('Control+s')
  await closeFixture(page)
  await expect(copy).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'save_document',
        ).length,
    ),
  ).toBe(0)
  await copy.getByRole('button', { name: 'Cancel', exact: true }).click()
  await closeFixture(page)
  await closeFixture(page)
  const unsaved = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
  await expect(unsaved).toHaveCount(1)
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(
    await page.evaluate(() =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.some((c) =>
        c.command.includes('destroy'),
      ),
    ),
  ).toBe(false)
  await patchFixture(page, { failSaves: true })
  await page.getByRole('button', { name: 'other', exact: true }).click()
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('permission denied')
  await expect(editor).toContainText('Unsaved author text.')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { files: Record<string, string> } }).fixture.files[
          'essay.md'
        ],
    ),
  ).toBe('# Essay\n\nOriginal writing.\n')
  await patchFixture(page, { failSaves: false, saveDelayMs: 200 })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await closeFixture(page)
  await expect(page.getByRole('alert')).toContainText('before closing')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { fixture: { files: Record<string, string> } }).fixture.files[
            'essay.md'
          ],
      ),
    )
    .toContain('Unsaved author text.')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' More edits.')
  await page.evaluate(() => {
    ;(window as unknown as { fixture: { files: Record<string, string> } }).fixture.files[
      'essay.md'
    ] = 'External revision.\n'
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('CONFLICT')
  await expect(editor).toContainText('More edits.')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { files: Record<string, string> } }).fixture.files[
          'essay.md'
        ],
    ),
  ).toBe('External revision.\n')
})
test('stabilization: deleting the active document cancels inference rather than leaving hidden requests', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await patchFixture(page, { pauseReviews: true })
  await runReviewers(page, ['Clarity'])
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { fixture: { reviewConcurrency: { active: number } } }).fixture
            .reviewConcurrency.active,
      ),
    )
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Actions for essay.md' }).click()
  await page
    .getByRole('dialog', { name: 'File actions' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: 'Document writing editor' })).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { fixture: { reviewConcurrency: { active: number } } }).fixture
            .reviewConcurrency.active,
      ),
    )
    .toBe(0)
  await expect(page.locator('.analysis-status')).toHaveText('Ready when you are.')
  expect(
    await page.evaluate(() =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.some(
        (c) => c.command === 'cancel_request',
      ),
    ),
  ).toBe(true)
})
test('stabilization: keyboard Save cannot race a pending project open', async ({ page }) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Deliberately discarded text.')
  await patchFixture(page, { openDelayMs: 1000 })
  await page.getByRole('button', { name: 'Open another folder' }).click()
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Discard', exact: true })
    .click()
  await page.keyboard.press('Control+s')
  await expect(editor).toHaveAttribute('contenteditable', 'false')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.filter(
          (c) => c.command === 'save_document',
        ).length,
    ),
  ).toBe(0)
  await expect(editor).toHaveCount(0)
})
test('stabilization: invalid settings never change keys; pending key updates freeze backend editing', async ({
  page,
}) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByLabel('Server URL').fill('invalid-url')
  await page.locator('.advanced summary').click()
  await page.locator('input[type=password]').fill('test-private-key')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
  expect(
    await page.evaluate(() =>
      (window as unknown as { fixture: { calls: { command: string }[] } }).fixture.calls.some(
        (c) => c.command === 'set_api_key',
      ),
    ),
  ).toBe(false)
  await page.getByLabel('Server URL').fill('http://localhost:8080')
  await page.getByRole('button', { name: 'Backends', exact: true }).click()
  await page.getByRole('button', { name: 'Add backend', exact: true }).click()
  await page.locator('.management-editor details summary').click()
  await page.getByLabel('Backend API key', { exact: true }).fill('isolated-test-key')
  await patchFixture(page, { keyDelayMs: 300 })
  await page.getByRole('button', { name: 'Store backend key' }).click()
  await expect(page.getByLabel('Backend name', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Profiles', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeEnabled()
  await expect(page.getByRole('alert')).toContainText('session-only')
})
test('stabilization: same-name reviewers remain separate and removed profile membership clears findings/filters', async ({
  page,
}) => {
  await installDesktopFixture(page, {
    settings: {
      version: 2,
      customAnalyzers: [
        {
          id: 'other-clarity',
          name: 'Clarity',
          description: '',
          instructions: 'Review unclear references.',
          enabled: true,
          scope: 'paragraph',
          severity: 'warning',
        },
      ],
      customProfiles: [
        {
          id: 'review-only',
          name: 'Review only',
          description: '',
          enabled: ['clarity', 'other-clarity'],
        },
      ],
      general: { defaultProfile: 'review-only' },
    },
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open a writing folder' }).click()
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await page.getByRole('contentinfo').getByRole('button', { name: 'Analyze document' }).click()
  await expect(page.locator('.finding-group')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'Clarity (clarity)' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Clarity (other-clarity)' })).toBeVisible()
  await page.getByLabel('Filter by analyzer').selectOption('other-clarity')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Profiles', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Review only', exact: true }).click()
  await page
    .getByRole('region', { name: 'Custom profile editor' })
    .getByRole('checkbox')
    .last()
    .uncheck()
  await page.getByRole('button', { name: 'Keep profile changes' }).click()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.locator('.finding-card')).toHaveCount(0) // Filtered reviewer was removed from membership.
  await page.getByLabel('Filter by analyzer').selectOption('all')
  await expect(page.locator('.finding-card')).toHaveCount(1)
  await page.getByLabel('Filter by analyzer').selectOption('other-clarity')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click()
  await page.getByRole('button', { name: 'Delete Clarity', exact: true }).click()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByLabel('Filter by analyzer')).toHaveValue('all')
  await expect(page.locator('.finding-card')).toHaveCount(1)
})
test('recovery: an unsaved snapshot is offered, deferring keeps it, and restoring cannot overwrite a changed file', async ({
  page,
}) => {
  const disk = 'Draft as it is on disk.\n'
  const recovered = 'The paragraph that was never saved.\n'
  await installDesktopFixture(page, {
    files: { 'essay.md': disk },
    recovery: recoverySeed('/writing', 'essay.md', recovered, disk),
  })
  await page.goto('/')
  await openEssay(page)
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await expect(editor).toContainText('Draft as it is on disk.')
  const dialog = page.getByRole('dialog', { name: 'Recovered writing' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('essay.md')
  await expect(dialog).toContainText('about a minute ago')
  await dialog.getByRole('button', { name: 'Not now' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(editor).toContainText('Draft as it is on disk.')
  expect(await fixtureRecovery(page)).toHaveLength(1)
  // Deferring hides the prompt without discarding the snapshot: reopening offers it again.
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Restore into the editor' }).click()
  await expect(editor).toContainText('The paragraph that was never saved.')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  // The file changed elsewhere after the snapshot was captured.
  await writeFixtureFile(page, 'essay.md', 'Someone else rewrote this file.\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('CONFLICT')
  expect(await fixtureFile(page, 'essay.md')).toBe('Someone else rewrote this file.\n')
  await expect(editor).toContainText('The paragraph that was never saved.')
})
test('recovery: discarding a snapshot removes it for good', async ({ page }) => {
  const disk = 'Draft as it is on disk.\n'
  await installDesktopFixture(page, {
    files: { 'essay.md': disk },
    recovery: recoverySeed('/writing', 'essay.md', 'Unsaved paragraph.\n', disk),
  })
  await page.goto('/')
  await openEssay(page)
  const dialog = page.getByRole('dialog', { name: 'Recovered writing' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Discard snapshot' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await fixtureRecovery(page)).toHaveLength(0)
  await page.getByRole('button', { name: 'essay', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})
test('recovery: a snapshot that already matches the file is dropped without a prompt', async ({
  page,
}) => {
  const disk = 'Draft as it is on disk.\n'
  await installDesktopFixture(page, {
    files: { 'essay.md': disk },
    recovery: recoverySeed('/writing', 'essay.md', disk, disk),
  })
  await page.goto('/')
  await openEssay(page)
  await expect(page.getByRole('dialog', { name: 'Recovered writing' })).toHaveCount(0)
  await expect.poll(async () => (await fixtureRecovery(page)).length, { timeout: 4_000 }).toBe(0)
  expect(await fixtureCallCount(page, 'clear_recovery')).toBe(1)
})
test('recovery: typing checkpoints the draft and a successful Save clears it', async ({ page }) => {
  const disk =
    '# A better report\n\nThe the plan has merit.\n\nThis is unclear.\n\nA separate paragraph gives the reader context.\n'
  await installDesktopFixture(page, { files: { 'essay.md': disk } })
  await page.goto('/')
  await openEssay(page)
  // Opening a clean document never writes a checkpoint.
  expect(await fixtureCallCount(page, 'write_recovery')).toBe(0)
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.click()
  await editor.press('Control+End')
  await page.keyboard.type(' A new sentence written without saving.')
  await expect.poll(async () => (await fixtureRecovery(page)).length, { timeout: 9_000 }).toBe(1)
  const [record] = await fixtureRecovery(page)
  expect(record.documentPath).toBe('essay.md')
  expect(record.text).toContain('A new sentence written without saving.')
  // The snapshot remembers the file as it was, which is what makes a later Save conflict.
  expect(record.diskHash).toBe(sha256(disk))
  expect(record.textHash).toBe(sha256(record.text))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  expect(await fixtureRecovery(page)).toHaveLength(0)
})
test('recovery: a restart offers the checkpoint that typing produced', async ({ page }) => {
  await installDesktopFixture(page)
  await page.goto('/')
  await openEssay(page)
  const editor = page.getByRole('textbox', { name: 'Document writing editor' })
  await editor.click()
  await editor.press('Control+End')
  await page.keyboard.type(' A sentence written just before the app closed.')
  await expect.poll(async () => (await fixtureRecovery(page)).length, { timeout: 9_000 }).toBe(1)
  const restarted = await restartFixture(page)
  const restartedEditor = restarted.getByRole('textbox', { name: 'Document writing editor' })
  // The file on disk never changed, so the reopened document shows the saved bytes first.
  await expect(restartedEditor).toContainText('A separate paragraph gives the reader context.')
  const dialog = restarted.getByRole('dialog', { name: 'Recovered writing' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Restore into the editor' }).click()
  await expect(restartedEditor).toContainText('A sentence written just before the app closed.')
  await expect(restarted.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await restarted.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(restarted.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const saved = await restarted.evaluate(
    () => (window as unknown as { fixture: { files: Record<string, string> } }).fixture.files,
  )
  expect(saved['essay.md']).toContain('A sentence written just before the app closed.')
})
test('recovery: renaming a document keeps its snapshot attached to the new path', async ({
  page,
}) => {
  const disk = 'Draft as it is on disk.\n'
  await installDesktopFixture(page, {
    files: { 'essay.md': disk },
    recovery: recoverySeed('/writing', 'essay.md', 'Unsaved paragraph.\n', disk),
  })
  await page.goto('/')
  await openEssay(page)
  const dialog = page.getByRole('dialog', { name: 'Recovered writing' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Not now' }).click()
  await page.getByRole('button', { name: 'Actions for essay.md' }).click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename', exact: true })
  await rename.getByRole('textbox').fill('kept.md')
  await rename.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.document-breadcrumb')).toContainText('kept.md')
  await expect
    .poll(async () => (await fixtureRecovery(page))[0]?.documentPath, { timeout: 4_000 })
    .toBe('kept.md')
  await page.getByRole('button', { name: 'kept', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Recovered writing' })).toBeVisible()
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
