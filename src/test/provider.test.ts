import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider, normalizeServer, type Transport } from '../ai/providers/openai'
import { ProviderError } from '../ai/types'
import { defaultSettings } from '../settings/model'
const config = defaultSettings().ai
const request = { system: 'Review only.', user: 'Document.', schema: { type: 'object' } }
const completion = (content = '{"issues":[]}') => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
})
describe('OpenAI-compatible provider', () => {
  it('supports local, Tailscale, LAN, HTTPS and API bases; rejects embedded secrets', () => {
    for (const server of [
      'http://localhost:8080',
      'http://100.80.40.20:8080',
      'http://gpu.tailnet.ts.net:8080',
      'http://192.168.1.3:8080',
      'https://example.org/v1',
    ])
      expect(normalizeServer(server)).toBe(server)
    expect(normalizeServer('http://localhost:8080/v1/')).toBe('http://localhost:8080/v1')
    expect(() => normalizeServer('ftp://server')).toThrow()
    expect(() => normalizeServer('http://secret@host')).toThrow()
  })
  it('uses global and override model IDs in actual structured requests', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue(completion())
    const provider = new OpenAICompatibleProvider(transport)
    await provider.completeStructured(request, config, new AbortController().signal)
    expect(transport.mock.calls[0][0].body).toMatchObject({
      model: 'qwen3-8b',
      response_format: { type: 'json_schema' },
    })
    await provider.completeStructured(
      request,
      { ...config, model: 'qwen3-14b' },
      new AbortController().signal,
    )
    expect(transport.mock.calls[1][0].body).toMatchObject({ model: 'qwen3-14b' })
  })
  it('falls back only for explicit unsupported structured formats', async () => {
    const transport = vi
      .fn<Transport>()
      .mockRejectedValueOnce(new ProviderError('format_unsupported', 'unsupported'))
      .mockRejectedValueOnce(new ProviderError('format_unsupported', 'unsupported'))
      .mockResolvedValue(completion())
    const provider = new OpenAICompatibleProvider(transport)
    await expect(
      provider.completeStructured(request, config, new AbortController().signal),
    ).resolves.toEqual({ issues: [] })
    expect(transport).toHaveBeenCalledTimes(3)
    expect(transport.mock.calls[1][0].body).toMatchObject({
      response_format: { type: 'json_object' },
    })
    expect(transport.mock.calls[2][0].body).not.toHaveProperty('response_format')
    await provider.completeStructured(request, config, new AbortController().signal)
    expect(transport).toHaveBeenCalledTimes(4) // Capability remembered, not retried.
  })
  it('does not downgrade a format fallback when an older concurrent response arrives late', async () => {
    let finish!: (value: unknown) => void
    const slow = new Promise<unknown>((resolve) => {
      finish = resolve
    })
    const transport = vi
      .fn<Transport>()
      .mockImplementationOnce(() => slow)
      .mockRejectedValueOnce(new ProviderError('format_unsupported', 'unsupported'))
      .mockResolvedValue(completion())
    const provider = new OpenAICompatibleProvider(transport)
    const signal = new AbortController().signal
    const first = provider.completeStructured(request, config, signal)
    await provider.completeStructured(request, config, signal)
    finish(completion())
    await first
    await provider.completeStructured(request, config, signal)
    expect(transport.mock.calls.at(-1)?.[0].body).toMatchObject({
      response_format: { type: 'json_object' },
    })
  })
  it('works without model discovery and does not send prose in connection tests', async () => {
    const transport = vi
      .fn<Transport>()
      .mockRejectedValueOnce(new ProviderError('unsupported', 'No models route'))
      .mockResolvedValue(completion('OK'))
    const result = await new OpenAICompatibleProvider(transport).testConnection(config)
    expect(result.message).toContain('Connected')
    expect(result.models).toHaveLength(0)
    expect(JSON.stringify(transport.mock.calls[1][0].body)).not.toContain('Document.')
  })
  it('requires a successful completion, not just a model list', async () => {
    const transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce({ data: [{ id: 'qwen3-8b' }] })
      .mockRejectedValueOnce(new ProviderError('model', 'Model unavailable', 404))
    await expect(
      new OpenAICompatibleProvider(transport).testConnection(config),
    ).rejects.toMatchObject({ kind: 'model' })
  })
  it('propagates classified connection failures without format retries', async () => {
    for (const kind of [
      'unreachable',
      'timeout',
      'authentication',
      'unsupported',
      'model',
      'malformed',
    ] as const) {
      const transport = vi
        .fn<Transport>()
        .mockRejectedValue(new ProviderError(kind, `Failure: ${kind}`))
      await expect(
        new OpenAICompatibleProvider(transport).completeStructured(
          request,
          config,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind })
      expect(transport).toHaveBeenCalledTimes(1)
    }
  })
  it('forwards the expanded timeout and output token limits', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue(completion())
    await new OpenAICompatibleProvider(transport).completeStructured(
      request,
      { ...config, timeoutMs: 1_800_000, maxTokens: 32768 },
      new AbortController().signal,
    )
    expect(transport.mock.calls[0][0].timeoutMs).toBe(1_800_000)
    expect(transport.mock.calls[0][0].body).toMatchObject({ max_tokens: 32768 })
  })
  it('uses only final content when reasoning is returned in separate fields', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"issues":[]}',
            reasoning_content: '{"issues":["not a finding"]}',
            reasoning: 'Private thoughts.',
          },
          finish_reason: 'stop',
        },
      ],
    })
    await expect(
      new OpenAICompatibleProvider(transport).completeStructured(
        request,
        config,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ issues: [] })
  })
  it('accepts fully closed leading thinking blocks followed by JSON, including fenced JSON', async () => {
    for (const content of [
      '<think>Review the passage carefully.</think>\n{"issues":[]}',
      '<think>First.</think> <think>Second.</think>\n```json\n{"issues":[]}\n```',
      JSON.stringify({ issues: [{ quote: '<think>literal source text</think>' }] }),
    ]) {
      const transport = vi.fn<Transport>().mockResolvedValue(completion(content))
      const result = await new OpenAICompatibleProvider(transport).completeStructured(
        request,
        config,
        new AbortController().signal,
      )
      expect(result).toEqual(content.startsWith('<think>') ? { issues: [] } : JSON.parse(content))
    }
  })
  it('does not use reasoning as a final answer or salvage incomplete thinking/arbitrary prose', async () => {
    for (const raw of [
      { choices: [{ message: { reasoning_content: '{"issues":[]}' }, finish_reason: 'stop' }] },
      completion('<think>Unfinished {"issues":[]}'),
      completion('<think>Finished thinking.</think>'),
      completion('<think>Finished.</think>Here is my review: {"issues":[]}'),
      completion('Undelimited thinking about the passage. {"issues":[]}'),
      {
        choices: [
          {
            message: { content: '{"issues":[]}', reasoning_content: 'Thinking.' },
            finish_reason: 'length',
          },
        ],
      },
    ]) {
      await expect(
        new OpenAICompatibleProvider(vi.fn<Transport>().mockResolvedValue(raw)).completeStructured(
          request,
          config,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: 'malformed' })
    }
  })
  it('explains a tiny connection-test budget being consumed by reasoning', async () => {
    const transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        choices: [
          {
            message: { content: null, reasoning_content: 'Still thinking.' },
            finish_reason: 'length',
          },
        ],
      })
    const result = await new OpenAICompatibleProvider(transport).testConnection(config)
    expect(result.message).toContain('Connected')
    expect(result.message).toContain('token limit')
  })
  it('rejects malformed JSON, prose, invalid envelopes, and truncation', async () => {
    for (const raw of [
      completion('not JSON'),
      { choices: [] },
      completion('Here are your issues: {"issues":[]}'),
      { choices: [{ message: { content: '{}' }, finish_reason: 'length' }] },
    ]) {
      const transport = vi.fn<Transport>().mockResolvedValue(raw)
      await expect(
        new OpenAICompatibleProvider(transport).completeStructured(
          request,
          config,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: 'malformed' })
    }
  })
})
