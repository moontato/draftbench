import { ProviderError } from '../ai/types'
import type { NativeRequest, Transport } from '../ai/providers/openai'
export interface HttpAttempt {
  backendRef?: string
  server: string
  model?: string
  route: string
  latencyMs: number
  status?: number
  raw?: unknown
  error?: string
}
export function evaluationTransport(
  keys: Record<string, string>,
  attempts: HttpAttempt[],
): Transport {
  return async (request: NativeRequest, signal?: AbortSignal) => {
    const controller = new AbortController(),
      start = performance.now()
    const abort = () => controller.abort()
    if (signal?.aborted) throw new ProviderError('cancelled', 'Evaluation cancelled.')
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, request.timeoutMs)
    const attempt: HttpAttempt = {
      server: request.serverUrl,
      route: request.route,
      backendRef: request.credentialRef,
      latencyMs: 0,
      model:
        request.body && typeof request.body === 'object' && 'model' in request.body
          ? String(request.body.model)
          : undefined,
    }
    attempts.push(attempt)
    try {
      const base = request.serverUrl.replace(/\/+$/, ''),
        endpoint = `${base}${base.endsWith('/v1') ? '' : '/v1'}/${request.route}`
      const key = keys[request.credentialRef ?? 'openai-compatible']
      const response = await fetch(endpoint, {
        method: request.body ? 'POST' : 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      })
      attempt.status = response.status
      const reader = response.body?.getReader(),
        chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 2_000_000) {
            await reader.cancel()
            throw new ProviderError('malformed', 'Response exceeds the 2 MB limit.')
          }
          chunks.push(value)
        }
      }
      let raw: unknown
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new ProviderError('malformed', 'Server returned malformed JSON.')
      }
      if (!response.ok) {
        const detail =
          raw && typeof raw === 'object'
            ? String((raw as { error?: { message?: unknown } }).error?.message ?? '').toLowerCase()
            : ''
        const kind =
          response.status === 401 || response.status === 403
            ? 'authentication'
            : response.status === 400 &&
                (detail.includes('response_format') || detail.includes('json_schema'))
              ? 'format_unsupported'
              : response.status === 429
                ? 'rate_limit'
                : 'server'
        throw new ProviderError(
          kind,
          `Evaluation endpoint returned HTTP ${response.status}.`,
          response.status,
        )
      }
      attempt.raw = raw
      return raw
    } catch (error) {
      const safe =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'network',
              timedOut
                ? 'Evaluation request timed out.'
                : signal?.aborted
                  ? 'Evaluation cancelled.'
                  : 'Evaluation endpoint could not be reached.',
            )
      attempt.error = safe.message
      throw safe
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      attempt.latencyMs = performance.now() - start
    }
  }
}
