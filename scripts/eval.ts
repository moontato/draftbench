import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { OpenAICompatibleProvider } from '../src/ai/providers/openai'
import { defaultSettings, loadSettings, backendConfig } from '../src/settings/model'
import {
  corpusSchema,
  evaluateCorpus,
  markdownReport,
  summarize,
  type EvalTarget,
} from '../src/eval/harness'
import { evaluationTransport, type HttpAttempt } from '../src/eval/transport'

async function main() {
  const { values } = parseArgs({
    options: {
      settings: { type: 'string' },
      corpus: { type: 'string', default: 'eval/corpus.json' },
      output: { type: 'string', default: 'eval/results' },
      backend: { type: 'string', multiple: true },
      models: { type: 'string' },
      url: { type: 'string' },
      model: { type: 'string' },
      jobs: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Draftbench eval (opt-in; requires your own server)\n\nnpm run eval -- --url http://localhost:8080 --model served-model\nnpm run eval -- --settings /path/to/settings.json --backend default --backend backend-ID\n\nOptions: --corpus path --models model-a,model-b --jobs 1..8 --output directory --dry-run\nKeys: DRAFTBENCH_EVAL_API_KEY for --url/default; DRAFTBENCH_EVAL_KEYS JSON keyed by backend ID for multiple servers. No OS key lookup in this developer CLI.\nReports contain corpus prose and raw model outputs; keep them private. Case-pass counts are proxies, not semantic quality scores.',
    )
    return
  }
  let settings = defaultSettings()
  if (values.settings) {
    const loaded = loadSettings(JSON.parse(await readFile(values.settings, 'utf8')))
    settings = loaded.settings
    for (const warning of loaded.warnings) console.warn(warning)
  }
  if (values.url) {
    settings.ai.serverUrl = values.url
    settings.defaultBackend = 'default'
    if (values.model) settings.ai.model = values.model
  }
  if (values.jobs) {
    const jobs = Number(values.jobs)
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8)
      throw new Error('--jobs must be an integer from 1–8.')
    settings.analysis.parallelJobs = jobs
  }
  const corpus = corpusSchema.parse(JSON.parse(await readFile(values.corpus!, 'utf8')))
  const ids = values.backend ?? [settings.defaultBackend]
  const targets: EvalTarget[] = ids.flatMap((id) => {
    const config = backendConfig(settings, id),
      name = settings.backends.find((b) => b.id === id)!.name
    const models = values.models
      ?.split(',')
      .map((m) => m.trim())
      .filter(Boolean) ?? [values.model ?? config.model]
    if (!models.length || models.some((m) => !m.trim()))
      throw new Error('Choose a nonempty served model ID.')
    return models.map((model) => ({ backend: name, config: { ...config, model } }))
  })
  if (values['dry-run']) {
    console.log(
      `Prepared ${corpus.length} cases × ${targets.length} backend/model targets. No HTTP requests sent.`,
    )
    return
  }
  let envKeys: Record<string, string>
  try {
    envKeys = z
      .record(z.string(), z.string())
      .parse(JSON.parse(process.env.DRAFTBENCH_EVAL_KEYS ?? '{}'))
  } catch {
    throw new Error('DRAFTBENCH_EVAL_KEYS must be valid JSON mapping backend IDs to string keys.')
  }
  const keys: Record<string, string> = {}
  for (const id of ids) {
    const config = backendConfig(settings, id)
    const key = envKeys[id] ?? (id === 'default' ? process.env.DRAFTBENCH_EVAL_API_KEY : undefined)
    if (key && config.credentialRef) keys[config.credentialRef] = key
  }
  const attempts: HttpAttempt[] = [],
    provider = new OpenAICompatibleProvider(evaluationTransport(keys, attempts))
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  const began = performance.now()
  const results = await evaluateCorpus(corpus, targets, settings, provider, controller.signal)
  process.removeListener('SIGINT', cancel)
  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    totalWallLatencyMs: performance.now() - began,
    summary: summarize(results),
    httpAttempts: attempts,
    results,
  }
  const secrets = Object.values(keys).filter(Boolean)
  const redact = (value: string) =>
    secrets.reduce(
      (text, key) =>
        text
          .split(key)
          .join('[REDACTED]')
          .split(JSON.stringify(key).slice(1, -1))
          .join('[REDACTED]'),
      value,
    )
  const json = JSON.stringify(
    report,
    (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value),
    2,
  )
  const markdown = redact(markdownReport(results))
  const output = resolve(values.output!),
    name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  await mkdir(output, { recursive: true })
  await writeFile(join(output, `${name}.json`), json + '\n')
  await writeFile(join(output, `${name}.md`), markdown)
  console.log(markdown)
  console.log(`Reports: ${join(output, name)}.{json,md}`)
  if (controller.signal.aborted) process.exitCode = 130
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Evaluation failed.')
  process.exitCode = 1
})
