import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { OpenAICompatibleProvider } from '../src/ai/providers/openai'
import { defaultSettings, loadSettings, backendConfig } from '../src/settings/model'
import {
  attachLabels,
  corpusSchema,
  evalLabelsSchema,
  evaluateCorpus,
  filterCorpus,
  markdownReport,
  summarize,
  type EvalLabel,
  type EvalTarget,
} from '../src/eval/harness'
import { evaluationTransport, type HttpAttempt } from '../src/eval/transport'

const list = (value?: string) =>
  value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) ?? []
function integers(value: string | undefined, max: number, flag: string): number[] {
  const values = list(value)
  if (!values.length) return []
  const parsed = values.map(Number)
  if (parsed.some((n) => !Number.isInteger(n) || n < 1 || n > max))
    throw new Error(`${flag} must be a comma-separated list of integers from 1–${max}.`)
  return [...new Set(parsed)]
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      settings: { type: 'string' },
      corpus: { type: 'string', default: 'eval/corpus.json' },
      labels: { type: 'string', default: 'eval/labels.json' },
      output: { type: 'string', default: 'eval/results' },
      backend: { type: 'string', multiple: true },
      models: { type: 'string' },
      url: { type: 'string' },
      model: { type: 'string' },
      jobs: { type: 'string' },
      sweep: { type: 'string' },
      repeat: { type: 'string' },
      analyzer: { type: 'string' },
      profile: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Draftbench eval (opt-in; requires your own server)\n\nnpm run eval -- --url http://localhost:8080 --model served-model\nnpm run eval -- --settings /path/to/settings.json --backend default --backend backend-ID\n\nOptions: --corpus path --labels path --models model-a,model-b --jobs 1..8 --sweep 1,2,4 --repeat 1..5 --analyzer clarity,structure --profile general,technical --output directory --dry-run\n--repeat runs every case again for the same target so latency and verdicts are reported as median/p95 plus stable/flaky cases instead of a single-run claim. --sweep repeats the whole run at each review-unit limit to expose queue pressure. --analyzer/--profile only select corpus cases; nothing else changes. Custom-reviewer cases need a settings file that defines them (see eval/eval-settings.json).\nLabels: eval/labels.json records human judgements about the cases themselves. Labels are never sent to a model; they only annotate the report.\nKeys: DRAFTBENCH_EVAL_API_KEY for --url/default; DRAFTBENCH_EVAL_KEYS JSON keyed by backend ID for multiple servers. No OS key lookup in this developer CLI.\nReports contain corpus prose and raw model outputs; keep them private. Case-pass counts are proxies, not semantic quality scores.',
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
  const repeats = values.repeat ? Number(values.repeat) : 1
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5)
    throw new Error('--repeat must be an integer from 1–5.')
  const sweeps = integers(values.sweep, 8, '--sweep')
  if (values.sweep && !sweeps.length) throw new Error('--sweep needs at least one job limit.')
  if (!values.sweep && values.jobs) sweeps.push(settings.analysis.parallelJobs)
  if (!sweeps.length) sweeps.push(settings.analysis.parallelJobs)
  const corpus = corpusSchema.parse(JSON.parse(await readFile(values.corpus!, 'utf8')))
  const analyzers = list(values.analyzer),
    profiles = list(values.profile),
    cases = filterCorpus(corpus, analyzers, profiles)
  if (!cases.length)
    throw new Error(
      '--analyzer/--profile selected no corpus cases. Available analyzers: ' +
        [...new Set(corpus.map((c) => c.analyzer))].join(', ') +
        '. Available profiles: ' +
        [...new Set(corpus.map((c) => c.profile))].join(', ') +
        '.',
    )
  let labels: Map<string, EvalLabel> | undefined
  if (await exists(values.labels!)) {
    const parsed = evalLabelsSchema.parse(JSON.parse(await readFile(values.labels!, 'utf8')))
    // Labels are validated against the whole corpus; filtering only narrows what is attached.
    labels = attachLabels(corpus, parsed)
    const missing = cases.filter((test) => !labels!.has(test.id)).length
    if (missing)
      console.warn(
        `${missing} of ${cases.length} selected cases have no human label in ${values.labels}; their expected behavior is unreviewed.`,
      )
  }
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
  const labeled = cases.filter((test) => labels?.has(test.id)).length
  if (values['dry-run']) {
    console.log(
      `Prepared ${cases.length} of ${corpus.length} cases × ${targets.length} backend/model targets × ${sweeps.join('/')} job limit(s) × ${repeats} repeat(s). No HTTP requests sent.${labels ? ` Human labels attached to ${labeled} selected case(s).` : ' No human-label sidecar loaded.'}`,
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
  const runs = []
  const reports: { parallelJobs: number; markdown: string }[] = []
  for (const parallelJobs of sweeps) {
    const runSettings = { ...settings, analysis: { ...settings.analysis, parallelJobs } }
    const run = await evaluateCorpus(cases, targets, runSettings, provider, controller.signal, {
      repeats,
      labels,
    })
    const markdown = markdownReport(run.results, run.jobs)
    runs.push({
      parallelJobs,
      queue: run.queue,
      summary: summarize(run.results, run.jobs),
      results: run.results,
    })
    reports.push({ parallelJobs, markdown })
    console.log(markdown)
    if (controller.signal.aborted) break
  }
  process.removeListener('SIGINT', cancel)
  const report = {
    version: 2,
    createdAt: new Date().toISOString(),
    totalWallLatencyMs: performance.now() - began,
    repeats,
    corpusCases: cases.length,
    humanLabeledCases: labeled,
    runs,
    httpAttempts: attempts,
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
  const stripTitle = (text: string) => text.replace(/^# Draftbench analyzer evaluation\n+/, '')
  const markdown = redact(
    reports.length > 1
      ? `# Draftbench analyzer evaluation — ${reports.length} parallel-limit sweeps (${sweeps.join(', ')} review units; ${repeats} repeat${repeats === 1 ? '' : 's'} per case)\n\n` +
          reports
            .map(
              (report) =>
                `## ${report.parallelJobs} review unit${report.parallelJobs === 1 ? '' : 's'} in parallel\n\n` +
                stripTitle(report.markdown),
            )
            .join('\n')
      : (reports[0]?.markdown ?? markdownReport([])),
  )
  const output = resolve(values.output!),
    name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  await mkdir(output, { recursive: true })
  await writeFile(join(output, `${name}.json`), json + '\n')
  await writeFile(join(output, `${name}.md`), markdown)
  console.log(`Reports: ${join(output, name)}.{json,md}`)
  if (controller.signal.aborted) process.exitCode = 130
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Evaluation failed.')
  process.exitCode = 1
})
