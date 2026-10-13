import { beforeEach, expect, it, vi } from 'vitest'
import { nativeTransport, OpenAICompatibleProvider, type Transport } from '../ai/providers/openai'
import { defaultSettings } from '../settings/model'

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ipc)
beforeEach(() => {
  ipc.invoke.mockReset()
})
const config = defaultSettings().ai
const review = { system: 'Review only.', user: 'Document.', schema: { type: 'object' } }
const completion = { choices: [{ message: { content: '{"issues":[]}' }, finish_reason: 'stop' }] }

it('keeps custom JSON-only transports buffered instead of breaking evaluation and integrations', async () => {
  const transport = vi.fn<Transport>().mockResolvedValue(completion)
  await expect(
    new OpenAICompatibleProvider(transport).completeStructured(
      review,
      config,
      new AbortController().signal,
    ),
  ).resolves.toEqual({ issues: [] })
  expect(transport.mock.calls[0][0].body).not.toHaveProperty('stream')
})
it('adds streaming only to completion IPC without mutating the caller or model-discovery requests', async () => {
  ipc.invoke.mockResolvedValue(completion)
  const body = { model: config.model, stream: false }
  await nativeTransport({
    id: 'completion',
    route: 'chat/completions',
    body,
    serverUrl: config.serverUrl,
    timeoutMs: config.timeoutMs,
  })
  expect(ipc.invoke).toHaveBeenLastCalledWith('ai_http', {
    request: expect.objectContaining({
      id: 'completion',
      body: { model: config.model, stream: true },
    }),
  })
  expect(body.stream).toBe(false)
  await nativeTransport({
    id: 'models',
    route: 'models',
    serverUrl: config.serverUrl,
    timeoutMs: config.timeoutMs,
  })
  expect(ipc.invoke).toHaveBeenLastCalledWith('ai_http', {
    request: expect.objectContaining({ id: 'models', route: 'models' }),
  })
  expect(ipc.invoke.mock.calls.at(-1)![1].request.body).toBeUndefined()
})
it('does not start native inference when already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    new OpenAICompatibleProvider().completeStructured(review, config, controller.signal),
  ).rejects.toMatchObject({ kind: 'cancelled' })
  expect(ipc.invoke).not.toHaveBeenCalled()
})
it('streams inference and cancels the exact active request without cancelling another job', async () => {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  ipc.invoke.mockImplementation(
    (
      command: string,
      args: { request?: { id: string; body: { stream: boolean } }; id?: string },
    ) => {
      if (command === 'ai_http') {
        expect(args.request!.body.stream).toBe(true)
        return new Promise((resolve, reject) => pending.set(args.request!.id, { resolve, reject }))
      }
      if (command === 'cancel_request') {
        pending.get(args.id!)!.reject({ kind: 'cancelled', message: 'Request cancelled.' })
        return Promise.resolve()
      }
      throw new Error(`Unexpected command: ${command}`)
    },
  )
  const provider = new OpenAICompatibleProvider()
  const cancelled = new AbortController(),
    other = new AbortController()
  const first = provider.completeStructured(review, config, cancelled.signal)
  const second = provider.completeStructured(review, config, other.signal)
  const [firstId, secondId] = [...pending.keys()]
  const rejected = expect(first).rejects.toMatchObject({ kind: 'cancelled' })
  cancelled.abort()
  await rejected
  expect(ipc.invoke.mock.calls.filter(([command]) => command === 'cancel_request')).toEqual([
    ['cancel_request', { id: firstId }],
  ])
  expect(other.signal.aborted).toBe(false)
  pending.get(secondId)!.resolve(completion)
  await expect(second).resolves.toEqual({ issues: [] })
  expect(ipc.invoke.mock.calls.filter(([command]) => command === 'ai_http')).toHaveLength(2)
})
it('rejects late results after abort and unregisters its listener instead of publishing or retrying', async () => {
  let finish!: (value: unknown) => void
  const controller = new AbortController()
  const removed = vi.spyOn(controller.signal, 'removeEventListener')
  ipc.invoke.mockImplementation((command: string) =>
    command === 'ai_http'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve(),
  )
  const result = new OpenAICompatibleProvider().completeStructured(
    review,
    config,
    controller.signal,
  )
  const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' })
  controller.abort()
  finish(completion)
  await rejected
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(ipc.invoke.mock.calls.filter(([command]) => command === 'ai_http')).toHaveLength(1)
  expect(ipc.invoke.mock.calls.filter(([command]) => command === 'cancel_request')).toHaveLength(1)
})
it('classifies transport errors arriving after abort as cancellation', async () => {
  let fail!: (error: unknown) => void
  ipc.invoke.mockImplementation((command: string) =>
    command === 'ai_http'
      ? new Promise((_, reject) => {
          fail = reject
        })
      : Promise.resolve(),
  )
  const controller = new AbortController()
  const result = nativeTransport(
    {
      id: 'active',
      route: 'chat/completions',
      serverUrl: config.serverUrl,
      timeoutMs: config.timeoutMs,
    },
    controller.signal,
  )
  const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' })
  controller.abort()
  fail({ kind: 'network', message: 'Socket closed.' })
  await rejected
})
