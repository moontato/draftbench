# Contributing to Draftbench v0.2

## Product boundary

**Write → Analyze → Inspect → Decide → Fix.** The document is authoritative; AI reviews, never authors automatically. Do not add chat, autocomplete, agents, RAG, executable plugins, sync, managed inference or model downloads. Local rules debounce; semantic analysis is manual. Every replacement needs explicit review and normal Undo/Redo. Never silently truncate prose or fuzzily attach a saved finding.

## Application seams

- `src/app/App.tsx`: composition only; `WorkspaceView.tsx` renders the existing writer-first workspace.
- `useWorkspaceSession.ts`: active project/document identity, dirty/close/switch prompts, protected filesystem actions and safe saves, editor snapshots and metadata restoration. One editor remains active.
- `useSettingsState.ts`: native settings load, repair warnings and awaited clean migration. Editing settings/restoring document profiles waits for startup readiness; StrictMode-abandoned loads cannot overwrite the active settings.
- `useRecentProjects.ts`: asynchronous MRU loading, direct opening and removal; stale startup loads cannot erase newer actions.
- `useLocalAnalysis.ts`: cancellable local-only debounce and conservative freshness gates.
- `reviewRun.ts`: manual reviewer selection, immutable run-start settings, lifecycle/cancellation, ordered aggregation, history and successful-review capture. It does not own JSX.
- `analyzers/runner.ts`: common scope planning, source budgets, cache and mapping. `jobs.ts` owns a single global/per-resource queue across reviewers and paragraph units.
- `settings/model.ts`: validated effective backend/model resolution and inference identity. `definitions.ts`, `AnalyzerManager`, `ProfileManager` and `BackendManager` own declarative definitions and their editing UI.
- `analyzers/registry.ts`: built-ins + Harper + configuration-driven reviewers; `llm/custom.ts` reuses `llm/semantic.ts`, not a separate response protocol.
- `diagnostics/`: shared exact-quote mapping, freshness, findings inspector and reviewed fixes. `editor/diagnostics.ts` applies a fresh, single-block plain-text change without dropping source marks or merging it into preceding typing.
- Native `storage.rs` owns root-scoped Markdown and atomic/conflict-safe writes; `network.rs` owns HTTP/limits/cancellation/credential references; `grammar.rs` adapts the pinned embedded Harper engine to common issues and UTF-16 offsets.
- `src/eval/` and `scripts/eval.ts` are an opt-in developer path. There is no evaluator service in the desktop application.

The session hook remains an integration controller; this refactor deliberately did not rewrite document/file semantics or duplicate them into a second state machine.

## Adding a reviewer

For a task that fits AI review, prefer **Settings → Analyzers**: stable ID/name/description, enablement, supported scope, instructions and severity. Duplicate a built-in to reuse its task instructions. Add the definition to a custom profile, or run it individually. It inherits backend/model unless explicitly overridden. Definition changes derive a new analyzer version; display backend names are excluded from inference identity. No code, dynamic imports or executable plugin hooks are accepted from settings.

For a compiled built-in, implement `Analyzer` in `analyzers/types.ts`, register it, and add default/profile entries. Deterministic issues can supply trusted local offsets; AI offsets are never trusted. Return exact source quotes, supported severities and optional safe replacements/alternatives. Do not bypass `runAnalyzer`, provider injection, budgets, cache, mapping, freshness or reviewed Apply. Changing rule/prompt/protocol interpretation requires a version change and regression tests. A different full-document structure recommendation is not permission to rewrite multiple blocks.

Test empty results, malformed output, repeated/nonunique quotes, Unicode, scope bounds, context changes, edits while running, cancellation, cache/force rerun, saved restoration and normal Undo/Redo. Native local rules must never call a provider or network transport. Harper shares one cancellable frontend CPU lane across manual/debounced calls; obsolete queued work never reaches native IPC.

## Routing and bounded work

Default backend → backend default model; analyzer backend/model overrides win. Profiles only choose membership. Native credential references are validated and backend-specific; an explicit reference cannot fall back to the old key. Explicit no-key requests retain a distinct inference identity from the implicit legacy credential slot. The legacy reference remains `openai-compatible`; new IDs use `backend:<stable-id>`, with UUID-backed IDs for newly created servers. Credentials are outside settings and project metadata. A credential generation change invalidates prior analysis.

The shared queue reserves global and backend capacity together. Saturated backend waiters do not hold global slots; another runnable backend can bypass them. Normalized aliases share the stricter resource cap. Abort removes queued requests, signals active requests and drains work before completing history. Failure in one reviewer does not cancel others. Cache/local work uses no AI slots. Settings, document/profile changes and editor freshness gates prevent late results from attaching to changed input.

Migrated single-backend setups retain the old same-model scheduling/global limit, including mixed-model sequential fallback. Multiple backends or explicitly disabling that compatibility policy enables modern resource caps. This preserves old behavior rather than quietly reducing an existing three-job single-server setup to a newly introduced two-job cap. Actual limits are recorded in new history entries.

## Migrations and persistence

- **Settings v1 → v2:** original `ai` options and credential generation migrate to backend ID `default`, name `Default`, with the unchanged `openai-compatible` credential reference. Existing analyzer model overrides, editor preferences, default profile, parallel jobs and input budgets are retained. `settings.ai` remains the authoritative compatibility alias for that stable backend; `backendEditing.ts` synchronizes edits in the old AI and new Backend tabs. New backends own independent options. Harper is globally disabled on upgrade and on fresh defaults.
- **Settings load:** bad/duplicate custom definitions, backend entries and analyzer options are isolated entry-by-entry. Missing backend overrides disable that analyzer rather than silently redirecting prose. Unknown profile memberships are removed with warnings. A missing default retains the legacy endpoint; a missing profile falls back to General prose. Clean legacy migration is atomically saved and awaited. Repairs are **not** auto-written over the damaged original: review then explicitly save settings. Strict saves reject invalid definitions/URLs/IDs/limits **before** changing keys. v0.2.1 also repairs individual existing option fields without dropping valid custom/backend/profile entries, uses the saved Default endpoint as alias fallback, and disables affected inherited AI routing when a default cannot safely be recovered.
- **Project/analysis sidecars:** new writes use version 2; readers accept versions 1/2. Markdown remains authoritative. Document IDs, rename continuity, save-copy isolation and recent-project storage are unchanged. Metadata IPC carries the expected canonical project root; native rejects late reads/writes belonging to a different project. A removed profile does not mint a new document ID.
- **Cache/reviews/history:** compatible v1 inference hashes are preserved by omitting display backend metadata and the unchanged legacy credential reference. Custom reviewer versions, prompt/scope inputs, endpoint/model/options/credential reference/generation and relevant profile membership participate in identity. Saved reviews/history export v2 and import v1/2. New provenance includes backend/resource limits and custom profile names; missing legacy fields remain unknown. Components import independently so a damaged cache does not erase valid review/history data.
- Exact saved-review matching still checks bytes/serialization/structured content/configuration/profile and AI input budgets. Rebind block indices and validated quotes onto fresh session IDs, never replay absolute ranges. Failed/partial/cancelled/stale reviews are not saved. Existing bounded cache/review/history limits remain in force. Recent folders remain a separate version-1 app-config file.

Unknown future versions are not treated as compatible. Sidecars are disposable, but corrupt settings originals are retained for deliberate recovery. Commit sources, fixtures, documentation, resources and lockfiles—not `.draftbench`, keys, evaluation reports or build products.

## Evaluation

```sh
npm run eval -- --dry-run
npm run eval -- --url http://localhost:8080 --model served-model
npm run eval -- --settings /path/to/settings.json --backend default --backend backend-ID --jobs 4
```

Edit `eval/corpus.json` or supply `--corpus`. Cases have `id`, `profile`, `source`, `analyzer`, descriptive `expectedBehavior`, optional `expectedQuote` and `expectNoFindings`. The initial corpus has 12 positive/clean cases for all four semantic built-ins. Custom reviewer IDs resolve from supplied settings. Explicit target backend/models override normal per-analyzer routing for a controlled comparison. The plain-text case adapter recognizes paragraph boundaries/ATX headings, not full editor Markdown.

Reports contain raw responses and written source under ignored `eval/results/`; `--output` chooses another private location. Structured validity, exact quotes and successful mapping are distinct metrics. Clean-case false positives and missed expected findings/quote matches are proxies, not semantic grades. Inspect the output and compare it with the human expectations. Malformed/server failures remain visible, not clean-case passes. Latency includes pipeline/queue work; individual HTTP attempts are also recorded. `Ctrl-C` cancels queued/active work.

Keys come only from `DRAFTBENCH_EVAL_API_KEY` or `DRAFTBENCH_EVAL_KEYS` (JSON keyed by backend ID). No OS-key lookup, credential fallback between servers, redirects, unbounded responses or automatic endpoint invocation. Exact supplied key strings are redacted from reports; keep reports private regardless. This Node transport exercises the production provider/format fallback/analyzer/mapping pipeline, not Rust HTTP. Ordinary CI runs only inference-free tests and a dry-run.

## Development checks

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run eval -- --dry-run
npm run test:ui
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --debug --no-bundle
```

Playwright starts an isolated Vite server on **1431**, never reusing the desktop dev server on 1420 or stale transformed assets. Tests inject an explicitly test-only native bridge; production has no browser networking permissions. Rust tests include actual Harper and local mock HTTP. `scripts/native-smoke.py` separately drives actual WebKit/IPC/native HTTP with disposable config/projects, two mock servers and session-only test keys. See [verification](verification.md) and the README for launching it safely. Do not test with a user's app-config directory or documents.

## Intentional limitations

Harper uses curated American English/plain block text, excludes fenced code, spelling and repetition, and is not a configurable dialect/user-dictionary engine yet. Mark-level inline-code exclusion needs further editor metadata work. Native grammar work cannot be forcibly interrupted mid-lint; cancellation suppresses publication and stale fixes. Upstream Apache-2.0 attribution ships in `src-tauri/resources`.

Actual inference quality, model contexts/tokenizers, live Tailscale reachability, server throughput, OS-keychain persistence and macOS/Windows builds/signing require their own acceptance passes. No token/context discovery or automatic essay chunking is claimed. Prioritize these, broader Markdown fidelity, accessibility and targeted controller decomposition over excluded product features.
