# Draftbench

**Static analysis for writing.** A FOSS desktop writing environment for essays, technical prose, reports, and professional emails.

Write → Analyze → Inspect → Decide → Fix. You remain the author. AI is a reviewer, not a chat interface or an automatic rewriter.

Draftbench v0.1.1 is built with **Tauri 2, React, TypeScript, and TipTap/ProseMirror**. Documents are ordinary local Markdown files. Inference uses native Rust HTTP—not browser networking—so plain-HTTP localhost, LAN, and Tailscale servers do not need CORS configuration.

## What works

- Native folder picker and Markdown project tree; create documents/folders, rename, delete files or empty folders, save, save a copy, and reload.
- Comfortable rich-text prose editing: paragraphs, headings, lists, links, emphasis, quotes, inline code, code blocks, and hard breaks.
- Collapsible document/analysis panes and focus mode.
- Inline diagnostic underlines plus a central Analysis/Problems panel: group by analyzer, severity, or passage; filter by analyzer/severity/category; inspect explanations; jump to text; dismiss/reset findings.
- A small History button at the top of the Analysis pane shows the document's previous manual runs, reviewer/model provenance, scope, finding counts, cache reuse, and outcomes.
- Resizable, collapsible finding review with an explicit original/proposed-text diff. Apply is a normal editor history operation; Undo does not remove the author's preceding typing.
- **Clarity**, **Ambiguous reference**, **Redundancy**, and **Structure** AI reviewers; a deterministic **Repeated word** check runs locally after a short debounce.
- Analyze document (all enabled reviewers), selection, current paragraph, or one analyzer. Cancellation, per-analyzer errors, size limits, and stale-result rejection.
- OpenAI-compatible provider; easy llama.cpp setup, optional model discovery, manual model IDs, global model inheritance, and per-analyzer model overrides.
- Writing profiles, local review caching, automatic exact-match saved-review restoration, versioned settings, safe writes, and conflict detection on save.
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
# src-tauri/target/release/bundle/deb/Draftbench_0.1.1_amd64.deb
# Executable: src-tauri/target/release/draftbench
```

The checked-in bundle target is Debian. On Windows/macOS, install their Tauri prerequisites and choose a platform bundle explicitly, for example:

```sh
npm run tauri build -- --bundles nsis   # Windows
npm run tauri build -- --bundles dmg    # macOS
```

Windows/macOS builds and signing are **not verified** in this environment. Linux native compilation, packaging, and a headless desktop smoke test have been verified. Packages are unsigned.

`npm run dev` is frontend tooling only. Its browser preview deliberately disables filesystem actions and identifies that native features require Tauri. It is not a hosted application or an alternate storage implementation.

## First writing session

1. Open a normal folder containing Markdown files, or create an empty folder using your OS and open it.
2. Create/open a document. `examples/nonfiction/` is a small sample project; its essay intentionally contains a repeated word and passages to review.
3. Write normally using the prose toolbar. Save with **Ctrl+S / Cmd+S**.
4. Configure your AI server in **Settings → AI**, or use the offline repeated-word check without AI.
5. Choose **Analyze document**, **Analyze selection**, or a specific reviewer from **Run analyzer**. Current-paragraph analysis is also in that menu. Document-only reviewers are skipped for selection/paragraph runs; run them explicitly on the document instead.
6. Click an underline or finding to inspect its passage and explanation. Review the diff before **Apply suggestion**, or **Dismiss** it. The editor's Undo/Redo includes applied fixes.

The **Review finding** section can be collapsed using its heading chevron without dismissing or forgetting the selected finding. Expand it again, or click a finding card to inspect it. Drag the divider above the section to adjust its height; the focused divider also supports Up/Down and Home/End keys. The section shrinks automatically in shorter windows, leaving room for the finding cards. Height is retained while the pane stays open, including across collapse/expand.

Successful manual reviews save automatically. Reopening an unchanged document restores the saved findings without contacting the model, labeled **Saved review** with the last run's scope and timestamp. The document, writing profile, analyzer versions, and relevant effective analysis settings must match exactly; otherwise, no saved findings are restored. Older cache-only sidecars become eligible after the next successful review. Dismissals remain session-only.

Use the **History** icon beside the analyzer-settings button at the top of the right pane to see previous manual runs, newest first. It records time, scope, profile, force-rerun flag, each reviewer's version/model/server/options, accepted finding counts, and completion/warning/failure/cancellation outcomes. Completed reviewers also show cache hits and review-request counts; incomplete reviewers do not claim reliable request totals. Runs on earlier document content are marked accordingly. Opening history does not restore suggestions or modify the editor. Automatic local checks and saved-review restoration are not logged as new runs. For documents with a saved review but no run log, History recovers a clearly labeled **Recovered saved review** entry with the stored date, scope, profile, reviewers, and finding counts. This snapshot is not a reconstructed list of every earlier run: original model settings, request counts, duration, and force-rerun status were not saved and are not guessed. Older request caches alone cannot reconstruct a document's past runs; the empty-state message explains this distinction.

History persists across restarts and follows document renames; copies have separate identities/history. It retains at most 50 runs per document, 300 per project, and approximately 500 KB total. An unfinished persisted run is labeled Interrupted on reopen, not successful. This is a bounded activity log, not a full archive of past findings.

The installed/source build's version is shown in **Settings → General** (currently **v0.1.1**). The UI reads the package version; release metadata and lockfiles are kept in sync and regression-tested. Patch revisions increment this version without changing the settings or analysis-data schema versions.

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

Effective configuration is resolved once and shared by requests, provenance, freshness checks, and cache keys. Changing a model invalidates only that analyzer's applicable cache. Timeout/temperature/output-budget changes also change cache identity. The types can evolve to provider/server/prompt/scope overrides later without changing the editor or Problems panel.

Profiles are deliberately small analyzer presets:

| Profile | Enabled by preset |
| --- | --- |
| General prose | Repeated word, Clarity, Ambiguous reference, Redundancy |
| Technical writing | All five analyzers |
| Essay | All five analyzers |
| Professional email | Repeated word, Clarity, Ambiguous reference, Redundancy |

Global analyzer disable switches apply on top of these presets. Choose Essay or Technical writing to include Structure. Profiles are stored per document. Specialized acronym/deadline/request/tone checks are **future work**, not hidden v0.1 features.

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

Settings live in Tauri's OS app-config directory (for example `~/.config/org.draftbench.desktop/settings.json` on Linux). API keys use the OS credential store—Secret Service on Linux, Keychain on macOS, Credential Manager on Windows. If secure storage is unavailable, Draftbench warns and uses a **session-only** key; there is no plaintext fallback. Key changes apply when testing or saving and clear cached reviews, even if you later cancel other settings changes.

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
  profiles/       Analyzer presets
  settings/       Settings schema, inheritance, settings UI
  storage/        Typed native command bridge
  ui/             Shared dialog/focus handling and styling
src-tauri/src/
  lib.rs          Narrow IPC commands and desktop state
  storage.rs      Root-scoped files, safe writes, hashing, project tree
  network.rs      reqwest HTTP, cancellation, limits, failure classification
```

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
dbus-run-session -- xvfb-run -a tauri-driver --native-driver /usr/bin/WebKitWebDriver --port 4444
# Terminal 2:
python3 scripts/native-smoke.py
```

This launches the bundled desktop and checks real IPC, scoped Markdown save/load, conflict protection, and Rust HTTP against a mock compatible server without CORS headers. It does not prove model quality or real llama.cpp compatibility.

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
- Bounded paragraph/context inputs (12,000 characters) and document-level inputs (48,000 characters), with visible errors rather than truncation. No summarization/RAG/embeddings.
- Semantic analysis is manual. False positives and imperfect replacements remain possible; confidence is the model's estimate, not calibrated probability.
- Local HTTP connections and Linux packages were verified; real model responses, private-network deployment, OS credential-store persistence, other OS builds, and signing need suitable environments.
- No proxy configuration UI. Native requests deliberately bypass environment proxies and reject redirects.
- Basic schema-version recovery, not sophisticated migrations or advanced production crash recovery. Symlink documents/folders are excluded; hostile concurrent filesystem changes/locking are not comprehensively hardened.
- Cache cannot detect model weights silently replaced behind the same ID.

Next: real llama.cpp/Tailscale acceptance testing, broader Markdown fidelity, section-aware long-document review, terminology/acronym/email-request checks, stronger desktop accessibility automation, and external-change handling. Keep the author-first workflow and avoid speculative plugin/agent infrastructure.

## License

MIT. See `LICENSE`. TipTap/ProseMirror, Tauri, React, and the other selected components are open-source; Draftbench uses no paid editor services or proprietary analyzer runtime.
