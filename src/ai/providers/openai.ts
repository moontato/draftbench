import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { ProviderError, type AIProvider, type StructuredRequest, type FailureKind } from '../types'
import type { EffectiveConfig } from '../../settings/model'
export interface NativeRequest {
  id: string
  serverUrl: string
  route: 'models' | 'chat/completions'
  body?: unknown
  timeoutMs: number
}
export type Transport = (request: NativeRequest, signal?: AbortSignal) => Promise<unknown>
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        // Separate reasoning_content/reasoning fields are deliberately not used as answers.
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
})
function finalContent(raw: string | null | undefined): string {
  let content = (raw ?? '').trim()
  // Some compatible servers put thinking in content instead of a separate field.
  // Strip only explicit leading, closed blocks; never search prose for a JSON object.
  while (content.startsWith('<think>')) {
    const end = content.indexOf('</think>', '<think>'.length)
    if (end < 0)
      throw new ProviderError(
        'malformed',
        'Model returned unfinished reasoning. Increase output tokens or analyze a smaller passage.',
      )
    content = content.slice(end + '</think>'.length).trimStart()
  }
  if (!content)
    throw new ProviderError(
      'malformed',
      'Model returned no final answer. Reasoning may have consumed the output budget; increase output tokens or analyze a smaller passage.',
    )
  return content
}

export const nativeTransport: Transport = async (request, signal) => {
  if (signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.')
  const cancel = () => {
    void invoke('cancel_request', { id: request.id }).catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await invoke('ai_http', { request })
    if (signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.')
    return result
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (error && typeof error === 'object' && 'kind' in error && 'message' in error) {
      throw new ProviderError(
        String(error.kind) as FailureKind,
        String(error.message),
        'status' in error ? Number(error.status) || undefined : undefined,
      )
    }
    throw new ProviderError(
      'network',
      'Native networking unavailable. Launch Draftbench through Tauri.',
    )
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
export function normalizeServer(server: string): string {
  let url: URL
  try {
    url = new URL(server.trim())
  } catch {
    throw new ProviderError('configuration', 'Enter a valid HTTP or HTTPS server URL.')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ProviderError(
      'configuration',
      'Use HTTP or HTTPS without embedded credentials, query, or fragment.',
    )
  return url.toString().replace(/\/+$/, '')
}
export class OpenAICompatibleProvider implements AIProvider {
  private formats = new Map<string, number>()
  constructor(private transport: Transport = nativeTransport) {}
  private call(
    config: EffectiveConfig,
    route: NativeRequest['route'],
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const serverUrl = normalizeServer(config.serverUrl)
    if (route === 'chat/completions' && !config.model.trim())
      throw new ProviderError('configuration', 'Enter a default Model ID. Discovery is optional.')
    return this.transport(
      { id: crypto.randomUUID(), serverUrl, route, body, timeoutMs: config.timeoutMs },
      signal,
    )
  }
  async listModels(config: EffectiveConfig, signal?: AbortSignal): Promise<string[]> {
    const result = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .safeParse(await this.call(config, 'models', undefined, signal))
    if (!result.success)
      throw new ProviderError(
        'malformed',
        'Model discovery returned malformed JSON. Manual Model ID entry still works.',
      )
    return result.data.data.map((m) => m.id)
  }
  async testConnection(config: EffectiveConfig, signal?: AbortSignal) {
    const models: string[] = []
    let discoveryNote = ''
    try {
      models.push(
        ...(await this.listModels(
          { ...config, timeoutMs: Math.min(config.timeoutMs, 5000) },
          signal,
        )),
      )
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'cancelled') throw error
      discoveryNote = ' Model discovery unavailable; manual Model ID works.'
    }
    const raw = await this.call(
      config,
      'chat/completions',
      {
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 256,
        temperature: 0,
      },
      signal,
    )
    const response = completionSchema.safeParse(raw)
    if (!response.success)
      throw new ProviderError('malformed', 'Completion endpoint returned a malformed response.')
    const choice = response.data.choices[0]
    if (choice.finish_reason !== 'length') finalContent(choice.message.content)
    const limitNote =
      choice.finish_reason === 'length'
        ? ' Test reached its token limit; the endpoint accepted the model. Reviews may need a larger output budget.'
        : ''
    return {
      message: `Connected. Model “${config.model}” accepted a completion.${discoveryNote}${limitNote}`,
      models,
    }
  }
  async completeStructured(
    request: StructuredRequest,
    config: EffectiveConfig,
    signal: AbortSignal,
  ): Promise<unknown> {
    const endpoint = normalizeServer(config.serverUrl)
    let format = this.formats.get(endpoint) ?? 0
    while (format <= 2) {
      const responseFormat =
        format === 0
          ? {
              type: 'json_schema',
              json_schema: { name: 'writing_review', strict: true, schema: request.schema },
            }
          : format === 1
            ? { type: 'json_object' }
            : undefined
      try {
        const raw = await this.call(
          config,
          'chat/completions',
          {
            model: config.model,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            ...(responseFormat ? { response_format: responseFormat } : {}),
          },
          signal,
        )
        // Concurrent responses must not downgrade a fallback learned by another job.
        this.formats.set(endpoint, Math.max(this.formats.get(endpoint) ?? 0, format))
        const response = completionSchema.safeParse(raw)
        if (!response.success)
          throw new ProviderError(
            'malformed',
            'The server returned an invalid completion envelope.',
          )
        const choice = response.data.choices[0]
        if (choice.finish_reason === 'length')
          throw new ProviderError(
            'malformed',
            'Review was truncated. Reasoning and the final answer may share the output budget; increase output tokens or analyze a smaller passage.',
          )
        let content = finalContent(choice.message.content)
        const fence = content.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
        if (fence) content = fence[1]
        try {
          return JSON.parse(content) as unknown
        } catch {
          throw new ProviderError(
            'malformed',
            'Analyzer returned malformed JSON; no findings from this response were applied.',
          )
        }
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'format_unsupported' && format < 2) {
          format++
          continue
        }
        throw error
      }
    }
    throw new ProviderError('unsupported', 'Structured completions unavailable.')
  }
}
