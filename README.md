# Draftbench

**Static analysis for writing.** A FOSS desktop writing environment for essays, technical prose, reports, and professional emails.

Write → Analyze → Inspect → Decide → Fix. You remain the author. AI is a reviewer, not a chat interface or an automatic rewriter.

Draftbench v0.2.1 is built with **Tauri 2, React, TypeScript, and TipTap/ProseMirror**. Documents are ordinary local Markdown files. Inference uses native Rust HTTP—not browser networking—so plain-HTTP localhost, LAN, and Tailscale servers do not need CORS configuration.

v0.2.1 is a stabilization release: safer save/copy/close sequencing, project-pinned metadata, non-destructive configuration repair, validated/locked credential operations, bounded Harper work, and focused diagnostic/accessibility polish. No new product capabilities or schema changes. See [stabilization findings and verification](docs/stabilization-v021.md).

## What works

- Native folder picker and Markdown project tree; create documents/folders, rename, delete files or empty folders, save, save a copy, and reload.
- Startup recent-project list: reopen one of your five most recently opened folders directly, without navigating the folder picker.
- Comfortable rich-text prose editing: paragraphs, headings, lists, links, emphasis, quotes, inline code, code blocks, and hard breaks.
- Collapsible document/analysis panes and focus mode.
- Inline diagnostic underlines plus a central Analysis/Problems panel: group by analyzer, severity, or passage; filter by analyzer/severity/category; inspect explanations; jump to text; dismiss/reset findings.
- A small History button at the top of the Analysis pane shows the document's previous manual runs, reviewer/model provenance, scope, finding counts, cache reuse, and outcomes.
- Resizable, collapsible finding review with an explicit original/proposed-text diff. Apply is a normal editor history operation; Undo does not remove the author's preceding typing.
- **Clarity**, **Ambiguous reference**, **Redundancy**, and **Structure** AI reviewers; a deterministic **Repeated word** check runs locally after a short debounce.
- Analyze document (all enabled reviewers), selection, current paragraph, or one analyzer. Cancellation, per-analyzer errors, size limits, and stale-result rejection.
- Configuration-driven custom AI reviewers: editable instructions, stable IDs, scope, severity and enablement, using the same exact-quote diagnostics and reviewed fixes as built-ins.
- Named OpenAI-compatible backends with independent credentials/options, default backend/model inheritance, per-analyzer overrides, connection tests, and shared global/per-server concurrency limits.
- Embedded offline **Harper** English grammar/style review; no API key, network, runtime management or downloads. Optional and disabled globally by default, including upgrades.
- Built-in and editable custom writing profiles, local review caching, automatic exact-match saved-review restoration, versioned settings, safe writes, and conflict detection on save.
- Opt-in analyzer/model evaluation CLI with an editable nonfiction corpus and protocol/mapping/latency/false-positive reports.
- No accounts, telemetry, cloud sync, inference runtime, model downloads, chat, autocomplete, or mandatory cloud services.

## Development and desktop builds

Requirements:

- Node.js **24 LTS** and npm.
- A current **stable Rust** toolchain (`rustup`, `cargo`, and `rustc`), installed via [rustup](https://rustup.rs/).
- [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

On Debian/Ubuntu, install the native build dependencies:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Then:

```sh
npm ci
npm run tauri dev                 # Actual desktop application
```

If Tauri reports that `cargo metadata` cannot be found, ensure Rust is installed and Cargo is on your shell's PATH. In **fish**, run `fish_add_path "$HOME/.cargo/bin"`; in **bash/zsh**, run `source "$HOME/.cargo/env"`. The latter is a POSIX script and cannot be sourced in fish. Check `cargo --version`, then retry.

Build an installable Linux package:

```sh
npm run tauri build
# src-tauri/target/release/bundle/deb/Draftbench_0.2.1_amd64.deb
# Executable: src-tauri/target/release/draftbench
```

The checked-in bundle target is Debian. On Windows/macOS, install their Tauri prerequisites and choose a platform bundle explicitly, for example:

```sh
npm run tauri build -- --bundles nsis   # Windows
npm run tauri build -- --bundles dmg    # macOS
```

Windows/macOS builds and signing are **not verified** in this environment. Linux native compilation, packaging, and a headless desktop smoke test have been verified. Packages are unsigned.

### Automated release builds

Pushing a stable tag such as `v0.2.1` triggers `.github/workflows/release.yml`: checked Linux x86_64 **Debian + AppImage** builds and a macOS **Universal DMG** (Apple Silicon + Intel). The tag must match the application version. All checks/builds must pass before installers and `SHA256SUMS` are published to [GitHub Releases](https://github.com/moontato/draftbench/releases).

macOS installers are ad-hoc signed only, **not Developer ID signed/notarized**; no Apple secrets are required. GitHub-hosted macOS packaging/publication remains unverified until the first successful tag run. See [release instructions](docs/releases.md) for setup, tagging, retries and limitations.

### Installing or updating on macOS

Build on a Mac with Node.js 24 LTS, stable Rust, and Apple's command-line tools (`xcode-select --install`). The checked-in bundle configuration explicitly includes `icons/icon.icns` for the app icon. To update a source checkout and generate a fresh installer:

```sh
git pull --ff-only
npm ci
npm run tauri build -- --bundles dmg
```

The generated installer is in `src-tauri/target/release/bundle/dmg/`. Build on Apple Silicon for an Apple Silicon app, or Intel for an Intel app. Quit the old Draftbench app, open the new DMG, drag **Draftbench.app** into **Applications**, and choose **Replace**. Eject the DMG and launch `/Applications/Draftbench.app`, not a copy left on the mounted installer. Check **Settings → General** for the new version. Updating source files alone does not update an installed app; there is no automatic updater.

Replacing the app preserves your Markdown files, `.draftbench/` project data, and app-config settings/recent projects because the application identifier stays the same. These locally built packages are not signed/notarized for distribution; if macOS blocks a build you trust, use **System Settings → Privacy & Security → Open Anyway**.

If a generic/old icon remains after replacing the app, it may be cached in the Dock/Finder. Remove its Dock shortcut and launch the Applications copy again, then choose Keep in Dock; logging out/in may also refresh it. To check whether the installed app actually contains its icon:

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' /Applications/Draftbench.app/Contents/Info.plist
ls /Applications/Draftbench.app/Contents/Resources/*.icns
```

The plist should name an icon resource that exists in `Contents/Resources`. If it is absent, rebuild from the updated configuration rather than deleting system-wide caches. macOS packaging/icon rendering remains unverified from this Linux environment.

`npm run dev` is frontend tooling only. Its browser preview deliberately disables filesystem actions and identifies that native features require Tauri. It is not a hosted application or an alternate storage implementation.

## First writing session

1. Open a normal folder containing Markdown files, or create an empty folder using your OS and open it.
2. Create/open a document. `examples/nonfiction/` is a small sample project; its essay intentionally contains a repeated word and passages to review.
3. Write normally using the prose toolbar. Save with **Ctrl+S / Cmd+S**.
4. Configure your AI server in **Settings → AI**, or use the offline repeated-word check without AI.
5. Choose **Analyze document**, **Analyze selection**, or a specific reviewer from **Run analyzer**. Current-paragraph analysis is also in that menu. Document-only reviewers are skipped for selection/paragraph runs; run them explicitly on the document instead.
6. Click an underline or finding to inspect its passage and explanation. Review the diff before **Apply suggestion**, or **Dismiss** it. The editor's Undo/Redo includes applied fixes.

On startup, **Recent projects** shows up to five previously opened folders, most recent first, with names and paths. Click one to reopen the project directly; no folder picker or automatic opening is involved. Only successful folder opens update the list, and canonical paths avoid duplicate aliases. Missing/offline/inaccessible folders are checked only when clicked, report an error, and remain removable using the entry's × button. Removing a recent entry never deletes the folder or its documents. Your current project/editor remain intact if an attempted recent folder cannot be opened. The list starts filling as folders are opened in this version.

The **Review finding** section can be collapsed using its heading chevron without dismissing or forgetting the selected finding. Expand it again, or click a finding card to inspect it. Drag the divider above the section to adjust its height; the focused divider also supports Up/Down and Home/End keys. The section shrinks automatically in shorter windows, leaving room for the finding cards. Height is retained while the pane stays open, including across collapse/expand.

Successful manual reviews save automatically. Reopening an unchanged document restores the saved findings without contacting the model, labeled **Saved review** with the last run's scope and timestamp. The document, writing profile, analyzer versions, and relevant effective analysis settings must match exactly; otherwise, no saved findings are restored. Older cache-only sidecars become eligible after the next successful review. Dismissals remain session-only.

Use the **History** icon beside the analyzer-settings button at the top of the right pane to see previous manual runs, newest first. It records time, scope, profile, force-rerun flag, each reviewer's version/model/server/options, accepted finding counts, and completion/warning/failure/cancellation outcomes. Completed reviewers also show cache hits and review-request counts; incomplete reviewers do not claim reliable request totals. Runs on earlier document content are marked accordingly. Opening history does not restore suggestions or modify the editor. Automatic local checks and saved-review restoration are not logged as new runs. For documents with a saved review but no run log, History recovers a clearly labeled **Recovered saved review** entry with the stored date, scope, profile, reviewers, and finding counts. This snapshot is not a reconstructed list of every earlier run: original model settings, request counts, duration, and force-rerun status were not saved and are not guessed. Older request caches alone cannot reconstruct a document's past runs; the empty-state message explains this distinction.

History persists across restarts and follows document renames; copies have separate identities/history. It retains at most 50 runs per document, 300 per project, and approximately 500 KB total. An unfinished persisted run is labeled Interrupted on reopen, not successful. This is a bounded activity log, not a full archive of past findings.

The installed/source build's version is shown in **Settings → General** (currently **v0.2.1**). The UI reads the package version; release metadata and lockfiles are kept in sync and regression-tested. v0.2 introduces settings/project/analysis metadata version 2 while accepting and migrating supported version-1 data. See [migration details](docs/contributing.md#migrations-and-persistence).

Notifications automatically disappear after eight seconds; the close button remains available for earlier dismissal.

Renames preserve document identity/profile. Deletion is permanent and confirmed; directories must be empty. There is no autosave in v0.1. Unsaved changes prompt on document/project changes and window close. Save checks for external changes; conflicts do not overwrite the other file. Reload explicitly or save a copy.

## Connect llama.cpp `llama-server`

Draftbench is the **client**. Use a server you already run; it does not need a GGUF path, tokenizer, GPU configuration, context size, or llama.cpp command-line options.

### On this computer

In **Settings → AI**:

```text
Provider:         OpenAI-Compatible / llama.cpp
Server URL:       http://localhost:8080
Default Model ID: qwen3-8b
```

Click **Test Connection**, then **Save settings**. The Model ID must match the ID/alias your server actually exposes; `qwen3-8b` is an example, not a model Draftbench installs. A server already configured with that alias works directly.

Root URLs and API bases ending in `/v1` both work:

```text
http://localhost:8080
http://localhost:8080/v1
```

The provider uses standard `/v1/models` (optional) and `/v1/chat/completions`. It also works with compatible LM Studio, vLLM, Ollama `/v1`, and explicitly configured remote servers.

### On another Tailscale node

```text
Server URL:       http://100.80.40.20:8080
Default Model ID: qwen3-8b
```

Or:

```text
Server URL:       http://gpu-box.tailnet-name.ts.net:8080
Default Model ID: qwen3-8b
```

LAN addresses such as `http://192.168.1.20:8080` and private/public HTTPS endpoints work the same way. The server must listen on an accessible interface; its firewall and Tailscale ACLs must allow the connection. **No browser CORS or local-network permission changes are needed.**

HTTP is intentional for local/private-network servers. It is not encrypted outside a protected transport such as Tailscale. HTTPS uses normal OS-trusted certificates; there is no disable-TLS-verification switch. Native requests use direct connections (environment HTTP proxies are disabled) and do not follow redirects, to avoid forwarding writing or credentials to another destination.

### Connection testing and troubleshooting

Test Connection optionally discovers models, then sends a tiny completion with **no document text** using the manually configured model. Missing discovery does not prevent a successful completion test. Discovered IDs are offered in the default-model field; you can always type one yourself.

Failures distinguish unreachable/DNS/TLS, timeout, authentication, unsupported endpoint, explicitly unavailable model, malformed response, rate limit, and server errors. An ambiguous server 404 is reported as ambiguous rather than guessed. Reasoning models may consume the test output budget; accepted truncated tests are explained, not incorrectly reported as network failures.

Advanced fields include an API key, timeout (up to **30 minutes / 1,800 seconds**), temperature, and output-token limit (up to **32,768 tokens**). Defaults remain two minutes and 2,048 tokens. Long-running/verbose reasoning models may need more output tokens or a longer timeout. Server runtime configuration remains the server operator's responsibility.

### Thinking/reasoning responses

Draftbench parses only the **final answer** as review JSON. Separate `reasoning_content` / `reasoning` fields are ignored, not displayed or cached as findings. For compatible servers that put reasoning into `message.content`, fully closed leading `<think>…</think>` blocks are removed before strict JSON parsing. Literal tags inside the final JSON are left alone. Unfinished reasoning, missing final answers, arbitrary prose mixed with JSON, and `finish_reason: "length"` reviews are rejected; no partial findings are applied.

The client sends the standard `max_tokens` parameter. On typical local compatible servers this budget covers **reasoning plus the final answer**, not just the review JSON; exact accounting is server-dependent. Increasing the cap does not enlarge the server's context window. Reasoning is neither disabled nor given a separate budget by Draftbench, and token-usage statistics are not currently displayed. Nonstandard reasoning wrappers are not guessed at.

Connection testing uses a deliberately small 256-token budget. A truncated test can confirm that the endpoint accepted the model, with an explicit warning; this is not treated as a successful writing review.

## Model inheritance and analyzer controls

One global default applies to every AI analyzer. Blank analyzer overrides mean **Default**:

```text
Global:               server http://100.80.40.20:8080, model qwen3-8b
Clarity:              Default → qwen3-8b
Ambiguous reference:  Default → qwen3-8b
Redundancy:            qwen3-14b → qwen3-14b
Structure:            Default → qwen3-8b
```

Set overrides in **Settings → Analysis**. You never re-enter the URL for each analyzer. Overriding a model does not download it or switch a single-model server automatically; that ID must be available on the configured server.

### Input budgets

**Settings → Analysis** provides two independent per-request source-text budgets:

- **Paragraph/context input budget:** Clarity paragraphs and Ambiguous reference paragraphs plus neighboring context. Default **12,000 characters**.
- **Document input budget:** Redundancy and Structure whole-document inputs, including code context. Default **48,000 characters**.

Each accepts an integer from **1,000–1,000,000 characters**. Older settings receive the existing defaults; Restore defaults resets both. Counts use JavaScript string length (UTF-16 units), not words or model tokens, and exclude prompt/JSON overhead. Increasing a budget allows the complete source input to be sent; it does not enlarge a model's context window, change output-token settings, or split an essay into sections. Choose budgets that leave room for instructions and the requested output in your server's context window. Large inputs, especially with parallel jobs, may increase latency and RAM/VRAM use.

Oversized AI units are skipped before cache lookup or inference, with a warning showing the actual input size, configured budget, and Settings path. No text is silently truncated. Local rules are unaffected. Budget changes cancel an active run and clear active AI findings; rerun analysis explicitly. Exact-input request-cache entries remain reusable when the new budget permits them, but automatic restoration of saved reviews containing AI reviews requires matching budgets. Older saved reviews remain eligible under the original defaults. History records new runs' budgets and preserves unknown budget metadata for older records.

### Parallel review jobs

**Settings → Analysis → Parallel AI jobs** sets a global per-run limit of **1–8 simultaneous AI review requests**; the default is **1 (sequential)**, including when loading older settings. It is shared across reviewers and paragraph jobs, not multiplied per reviewer. A single paragraph-oriented reviewer can use multiple jobs when reviewing a document. Local rules do not use AI request slots, and cache hits require no inference slot.

Migrated single-backend setups retain v0.1's same-model policy and existing global cap: mixed-model runs stay sequential. In **Settings → Backends**, add another backend or disable **Preserve v0.1 single-backend/single-model scheduling** to use global **and** per-server bounds. Per-backend limits default to **2**; start with a global limit of **4** for two servers supporting two requests each. Aliases for one normalized server share the stricter cap. A blocked server never occupies a global slot needed by another server. Effective configurations and limits are captured at run start; changing settings cancels the run. History records actual global/resource bounds, without inventing missing legacy metadata.

Start with **2** if your inference server supports concurrent requests. For llama.cpp, configure the server's supported parallel-slot setting (commonly `--parallel` / `-np`) separately; Draftbench does not configure slots or load models. Higher concurrency can increase KV-cache/RAM/VRAM pressure and is not guaranteed to improve speed if the server serializes requests internally. Timeouts begin when requests are sent, not while waiting for a Draftbench job slot.

Cancel stops queued work and cancels all active review requests. In-flight jobs are drained before the run is completed; one reviewer's failure does not stop other reviewers. Exact mapping, stale-result checks, and reviewed fixes remain unchanged. Scheduling does not alter analyzer prompts or cache/saved-review identity, so changing only the job limit does not invalidate reusable reviews.

Effective configuration is resolved once and shared by requests, provenance, freshness checks, and cache keys. Changing a model invalidates only that analyzer's applicable cache. Timeout/temperature/output-budget changes also change cache identity. Backend display-name changes do not change inference identity; endpoint/model/options/credential changes do. Custom prompt/scope changes version the reviewer and invalidate incompatible results.

Profiles are analyzer presets, not hidden credential or model overrides:

| Profile | Enabled by preset |
| --- | --- |
| General prose | Repeated word, Harper, Clarity, Ambiguous reference, Redundancy |
| Technical writing | All six built-in analyzers |
| Essay | All six built-in analyzers |
| Professional email | Repeated word, Harper, Clarity, Ambiguous reference, Redundancy |

Global disable switches apply on top of presets; **Harper is initially disabled globally**. Choose Essay or Technical writing to include Structure. **Settings → Profiles** creates, duplicates, renames, edits and deletes custom presets, with built-in/custom reviewer membership and a default-profile choice. Built-in profiles remain available and read-only. Documents persist their chosen profile ID. Removing a profile safely falls back to General prose without replacing document identity. Profiles never alter backend credentials or model choices.

### Custom AI reviewers

In **Settings → Analyzers**, create a reviewer with a unique lowercase ID, name/description, scope (**paragraph**, **paragraph + context**, **selection only**, or **document**), task instructions and default severity. Keep analyzer changes, then **Save settings**. IDs are stable after creation; duplicate a built-in or custom AI reviewer to start from an existing task. Built-in prompts are read-only. Enable/disable, edit or delete custom definitions; deleted membership/override references are cleaned up.

Example task: “For professional emails, flag requests whose action or deadline is genuinely unclear. Return no findings for a direct, unambiguous request.” This is configuration, **not executable plugin code**. Draftbench supplies the diagnostic schema, exact-quote requirements and reviewer-not-author policy. Custom findings use ordinary inline underlines, filtering/grouping, provenance, dismissal, reviewed Apply and Undo/Redo. Structural/cross-block suggestions remain report-only.

Run a custom reviewer individually from **Run analyzer**, or add it to a custom profile. Selection-only reviewers require a selection and never silently review the whole document. Paragraph/document input budgets and scope guards apply just as they do to built-ins.

### Named backends and routing

**Settings → Backends** manages named servers, default model, timeout/temperature/output settings, per-server concurrency and keys. For example, configure **Local Fast** at `http://localhost:8080` and **GPU Box** at your reachable Tailscale address. Choose a default backend; in **Analyzers**, blank backend/model overrides inherit that backend and its model. Explicit overrides can route Clarity locally and Structure to GPU Box. Effective server/model is shown before running and in finding/history provenance.

Connection tests use a minimal completion, not document prose; model discovery is optional. Model IDs must actually be served. Keys are independently stored under backend-specific OS credential references and never fall back to another server's key. Session-only fallback remains visible. Removing a backend requires reassigning analyzer overrides first; it does not delete unrelated OS credentials. New backend IDs do not reuse deleted credential slots.

The original **AI** tab is retained for the migrated Default backend. It is not a second, competing inference configuration.

### Offline Harper

Enable **Harper** in Analyzers (or Analysis), with a profile that includes it. It runs after the local-check debounce and can also be run manually at document/paragraph/selection scope. The pinned Rust engine is compiled into the application and needs no connection. American-English curated grammar/style checks are used; spelling is left to native spellcheck and repetition to Repeated word. Fenced code blocks are excluded. Findings, alternative replacement choices, provenance, cache/restoration and reviewed fixes use the common pipeline; no suggestion is applied automatically.

Unicode scalar offsets from Harper are explicitly converted to editor UTF-16 offsets and exact-checked. Paragraph text is plain text; mark-level inline-code exclusion, dialect choices and user dictionaries remain follow-ups. A cancelled native grammar worker may finish in the background, but cannot publish stale results. Upstream Harper is Apache-2.0 licensed; its [license](src-tauri/resources/harper-LICENSE.txt) and [notice](src-tauri/resources/harper-NOTICE.txt) ship with desktop bundles.

### Opt-in analyzer/model evaluation

Normal tests never contact an inference endpoint. The developer CLI runs only when invoked explicitly:

```sh
npm run eval -- --dry-run
npm run eval -- --url http://localhost:8080 --model served-model
npm run eval -- --url http://localhost:8080 --models model-a,model-b --jobs 2
npm run eval -- --settings /path/to/settings.json --backend default --backend backend-ID
```

Use `--corpus path` to edit/replace `eval/corpus.json`, `--output directory` for reports, and `--help` for all options. The initial 12 cases cover clarity, references, redundancy and structure, with clean negative cases; cases record ID, profile, source, analyzer, expected behavior and optional expected quote. A custom analyzer ID uses its saved definition. Explicit targets compare the selected backend/model, rather than silently inheriting individual analyzer routing.

`DRAFTBENCH_EVAL_API_KEY` supplies the Default key; `DRAFTBENCH_EVAL_KEYS` is a JSON object mapping backend IDs to keys for multiple servers. The CLI does **not** read OS credentials. Do not put keys in corpus/settings files or command-line arguments.

Timestamped JSON/Markdown reports under ignored `eval/results/` include structured-output validity, malformed responses, exact-quote validity, mapping success, finding/negative-case false-positive counts, missed expected issues, expected-quote/case-pass proxies, latency and raw responses/HTTP attempts. These are **not semantic quality scores**: read outputs against the written expectations. The case adapter supports plain paragraphs and ATX headings, not the full editor Markdown model. Reports contain corpus prose and model output; keep them private. This Node-fetch evaluator shares the production reviewer/provider/mapping pipeline, but is not native-transport certification.

## Storage and privacy

```text
my-project/
  essay.md
  notes.md
  .draftbench/
    project.json             Document IDs and profile presets
    analysis.json            Bounded cache, saved reviews, and manual-run history
```

Markdown is the source of truth. Project sidecars are optional and recoverable. File saves use a same-directory temporary file, flush, and atomic rename, retaining existing permissions where possible. A failed save keeps the dirty editor buffer. External changes are checked on save; no background filesystem watcher is implemented.

Settings live in Tauri's OS app-config directory (for example `~/.config/org.draftbench.desktop/settings.json` on Linux). Recent project names, canonical paths, and last-opened timestamps live separately in `recent-projects.json` in that same app-config directory, not inside a writing project. The list is local and unencrypted; it contains no document text or API keys. If it cannot be saved, a warning is shown but opening/writing still works (the current session can retain a recent entry).

API keys use independent backend references in the OS credential store—Secret Service on Linux, Keychain on macOS, Credential Manager on Windows. Settings version 2 migrates the original key reference unchanged; no key text enters JSON. If secure storage is unavailable, Draftbench warns and uses a **session-only** key; there is no plaintext fallback. Key changes apply when testing or saving and clear cached reviews, even if you later cancel other settings changes.

**Analysis caches contain quotes/replacement text from your documents.** They are ordinary local sidecar files, not encrypted. Use **Settings → Analysis → Clear analysis cache** to remove cached reviews, saved findings, and the run history when needed; avoid publishing `.draftbench/analysis.json` if your writing is private. Keys and authorization headers never enter project files, settings JSON, or cache keys.

Document text is sent only when you manually analyze it, and only to the endpoint you explicitly configure. No public AI URL is built in. There is no telemetry. Server errors are classified without echoing prompts or credentials into notifications/logs. Remote Markdown images/HTML are not loaded as resources.

### Markdown fidelity

Supported documents serialize with normalized formatting, not byte-for-byte identity. Frontmatter, UTF-8 BOMs, and newline style are preserved. Supported elements include paragraphs, headings, lists, links, emphasis, quotes, inline/fenced code, and hard breaks.

Tables, raw HTML, images, task lists, and footnotes trigger **read-only protection**. The original stays untouched. Saving a **converted copy** is explicit and may omit unsupported structures; inspect the copy and retain the original. v0.1 is not a lossless editor for every Markdown dialect.

## Architecture and diagnostics

```text
src/
  app/            Desktop shell and document-session orchestration
  editor/         TipTap editor, stable session block IDs, decorations, history fixes
  documents/      Markdown import/export and fidelity guards
  diagnostics/    Common types, quote/range mapping, freshness, Problems UI
  analyzers/      Interface, scope runner, cache, deterministic/semantic implementations
  ai/             Provider interface and generic OpenAI-compatible implementation
  profiles/       Built-in/custom analyzer presets
  settings/       Versioned definitions, migration, effective routing, management UI
  eval/           Opt-in corpus runner, metrics and bounded Node transport
  storage/        Typed native command bridge
  ui/             Shared dialog/focus handling and styling
src-tauri/src/
  lib.rs          Narrow IPC commands and desktop state
  storage.rs      Root-scoped files, safe writes, hashing, project tree
  network.rs      reqwest HTTP, isolated credentials, cancellation, limits
  grammar.rs      Embedded Harper adapter, UTF-16 offsets and suggestions
```

`App.tsx` now composes `WorkspaceView`; `useWorkspaceSession` coordinates the active project/document without owning rendering. `useSettingsState`, `useRecentProjects` and `useLocalAnalysis` isolate startup/migration, MRU state and local debounce. `reviewRun.ts` owns the manual run lifecycle; `analyzers/jobs.ts` owns shared global/resource slots. All engines go through `runner.ts`, mapping/freshness, cache and saved-review contracts. See [contributor architecture/migration notes](docs/contributing.md).

An analyzer receives an immutable snapshot, structured blocks, a planned scope/context unit, effective configuration, an optional prior state, and (for AI) a provider. It returns structured issues. Zod validation, exact-quote mapping, cache handling, and freshness checks are shared infrastructure.

Diagnostics carry analyzer/version, stable finding identity, category/severity, explanation, block/range reference, optional fix/confidence, revision/content/context fingerprints, and engine/server/model provenance. Code blocks are never diagnostic targets by default; references and document-level reviewers can include them as bounded context.

**Block persistence is intentionally simple:** IDs are stable within an editing session, including ordinary edits and split/paste operations. Changed source/context invalidates findings immediately. Live results from old documents/configurations cannot attach to a new session. Reloads create fresh block IDs and clear active findings/dismissals; a validated saved review can then be restored only for the exact document bytes, editor serialization, structured content, profile, and relevant analyzer configurations. Stored block indices and application-validated quote offsets are resolved against the new session, and dependency fingerprints are rebuilt. A mismatch rejects the whole saved review—there is no fuzzy reattachment or replay of absolute editor ranges.

One latest successful review per document is retained, bounded to 50 documents / approximately 500 KB, with up to 1,000 findings per review. Failed, canceled, partially malformed, or document-changed runs do not replace it. Reviews of unsaved text become reopenable only after saving that exact content. A normal save may normalize formatting while retaining the matching review. Clear analysis cache removes request-cache entries, saved reviews, and run history; all are disposable, not an archival history.

On an explicit later run, request-cache hits still require identical structured target/context inputs and configuration; cached target indices are remapped to that exact request and quotes are resolved again.

AI results request JSON-schema output, fall back narrowly to JSON-object/plain JSON instructions for unsupported API features, validate the envelope and each issue, and reject unknown blocks, nonunique quotes, or out-of-scope passages. One reviewer failure does not crash the others. No silent rewrite or arbitrary-prose extraction is used.

The cache includes analyzer/prompt version, effective endpoint/model/options, credential generation, scope, target content/type hashes, and relevant context hashes. Empty successful reviews are cached; failures/partially malformed results are not. Paragraph-independent entries survive unrelated edits. Cache size is bounded (300 entries / approximately 2 MB). **Force rerun all** bypasses hits. A model changed behind the same server/model ID is not detectable; force a rerun.

## Implement another analyzer

1. Implement `Analyzer` from `src/analyzers/types.ts`; declare version, engine, preferred scope, and supported scopes.
2. Return `issues` with a block ID and exact quote. Deterministic analyzers may additionally supply a trusted `offset` for identical repeated quotes; AI offsets are never trusted.
3. Register it in `src/analyzers/registry.ts`, add its default entry to `src/settings/model.ts` if desired, and include it in the appropriate profile presets.
4. For a semantic reviewer, use the provider passed in its context and the shared `validateResult` / schema; do not call browser networking or implement your own settings inheritance.
5. Add mocked behavior, mapping, scope, cache, and stale-result tests. No editor/Problems special cases are necessary. Registered deterministic analyzers automatically run after the local-check debounce.

Example deterministic analyzer:

```ts
import type { Analyzer } from './types'

export const longParagraph: Analyzer = {
  id: 'long-paragraph', version: '1', name: 'Long paragraph',
  description: 'An informational paragraph-length check, not a clarity judgment.',
  engine: 'deterministic', preferredScope: 'paragraph',
  scopes: ['selection', 'block', 'document'],
  async analyze({ unit }) {
    return {
      warnings: [],
      issues: unit.targets.filter(b => b.text.split(/\s+/).length > 200).map(b => ({
        block_id: b.id, quote: b.text, category: 'length', severity: 'info',
        message: 'This paragraph has more than 200 words.',
        explanation: 'Consider whether a paragraph break would help; length alone is not a problem.',
      })),
    }
  },
}
```

Use a new analyzer version when prompts, rules, schema, or meaningful configuration interpretation changes, to invalidate the corresponding cache.

## Tests and verification

Normal tests do **not** require a running inference server:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

TypeScript tests exercise JSON validation, all four mocked reviewers, model inheritance/overrides, exact quote and Unicode/mark/hard-break mapping, stable block lifecycle, stale/context invalidation, selection/block/document scope, limits, cancellation, cache hits/invalidation, Markdown round trips, accepted fixes, and undo boundaries. Rust tests cover filesystem boundaries/safe writes and a native mock HTTP server with classified failures.

Frontend workflow automation uses an **explicitly test-only native bridge** (never bundled into the product):

```sh
npx playwright install --with-deps chromium
npm run test:ui
```

Linux real-webview/native smoke test, separate from the mocked frontend test:

```sh
sudo apt-get install -y webkit2gtk-driver xvfb xauth
cargo install tauri-driver --locked
npm run tauri build -- --debug
# Terminal 1 (a normal graphical session can omit dbus-run-session/Xvfb):
# A clean disposable config is required; this test now writes recent-project metadata.
SMOKE_CONFIG=$(mktemp -d)
XDG_CONFIG_HOME="$SMOKE_CONFIG" dbus-run-session -- xvfb-run -a tauri-driver --native-driver /usr/bin/WebKitWebDriver --port 4444
# After stopping the driver, remove the disposable $SMOKE_CONFIG directory.
# Terminal 2:
python3 scripts/native-smoke.py
```

This launches the bundled desktop and checks real IPC, scoped Markdown CRUD/conflicts, native HTTP without CORS, and recent-folder reopening after restart. It migrates legacy settings, reviews a 50,000-plus-character document with persisted budgets, then runs custom reviewers/profile through **two** native mock servers: global peak **3**, backend peaks **1/2**, isolated keys and inference-free reruns. Real embedded Harper Unicode mapping, fenced-code exclusion, bold-preserving Apply and Undo are tested with no HTTP. It does not prove model quality or real llama.cpp compatibility.

Optional real-server check (sends only a short test fixture to this explicitly configured endpoint):

```sh
DRAFTBENCH_AI_BASE_URL=http://localhost:8080 \
DRAFTBENCH_AI_MODEL=qwen3-8b npm test -- src/test/realServer.test.ts
# Optional DRAFTBENCH_AI_API_KEY for an authenticated server.
```

The real-server test is skipped without `DRAFTBENCH_AI_BASE_URL`. Actual llama.cpp model inference and a reachable Tailscale deployment were **not available for verification here**. See `docs/verification.md` for the recorded checks and remaining manual steps.

## Known limits and next steps

- One active document editor; no multi-document tabs, background file watcher, autosave, or fuzzy block restoration. Dismissals last for the current editing session and reset on document switch/reload; settings, profiles, and analysis caches persist.
- Single-block plain-text fixes; broader structural changes remain report-only. Unsupported Markdown needs a converted copy.
- Configurable paragraph/context and document input budgets (defaults 12,000 / 48,000 characters), with visible warnings rather than truncation. No automatic section/chunk review, summarization/RAG/embeddings, tokenizer-based budgeting, or context-window discovery yet.
- Semantic analysis is manual. False positives and imperfect replacements remain possible; confidence is the model's estimate, not calibrated probability.
- Local HTTP connections and Linux packages were verified; real model responses, private-network deployment, OS credential-store persistence, other OS builds, and signing need suitable environments.
- No proxy configuration UI. Native requests deliberately bypass environment proxies and reject redirects.
- Versioned v1→v2 migration and entry-level settings repair, not advanced production crash recovery. Symlink documents/folders are excluded; hostile concurrent filesystem changes/locking are not comprehensively hardened.
- Cache cannot detect model weights silently replaced behind the same ID.

Next: real llama.cpp/Tailscale acceptance testing, broader Markdown fidelity, section-aware long-document review, terminology/acronym/email-request checks, stronger desktop accessibility automation, and external-change handling. Keep the author-first workflow and avoid speculative plugin/agent infrastructure.

## License

Draftbench application code: MIT, see `LICENSE`. Dependencies retain their own licenses; embedded Harper is Apache-2.0 with bundled license/attribution in `src-tauri/resources/`. TipTap/ProseMirror, Tauri, React and the other selected components are open-source; no paid editor service or proprietary analyzer runtime is used.
