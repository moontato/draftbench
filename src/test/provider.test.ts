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
