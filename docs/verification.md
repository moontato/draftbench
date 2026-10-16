# v0.2 verification and acceptance checklist

**Archived v0.2.0 record. v0.2.1 audit and fixes:** [stabilization-v021.md](stabilization-v021.md). **Current release work and regression matrix:** [stabilization-v028.md](stabilization-v028.md).

Recorded **2026-10-07** in Debian 12 x86-64. This is an in-place upgrade of v0.1.5, not a replacement application or certification of every OS/server.

## Baseline and current checks

Before refactoring: **100 unit tests**, **21 Playwright workflows**, **11 Rust tests** passed; one explicitly opt-in real-server test skipped. The mechanical orchestration extraction retained that regression suite before new features were added.

| Check | v0.2 result |
| --- | --- |
| TypeScript typecheck, ESLint, Prettier | Passed, including evaluation CLI |
| `npm test` | **137 passed**, one real-server test skipped |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **14 passed**; main/doc targets have no tests |
| `npm run test:ui` | **24 passed**, including all 21 old workflows |
| `npm run eval -- --dry-run` | 12 cases × one target, no HTTP |
| Evaluation CLI against a disposable local mock endpoint | JSON/Markdown reports generated for all 12 cases; protocol validity 100%, expected empty-response misses separately reported |
| `npm audit` | Zero reported vulnerabilities |
| `npm run tauri build -- --debug --no-bundle` | **v0.2.0** native debug executable built |
| `npm run tauri build -- --bundles deb` | **v0.2.0** optimized executable and Debian package built (8.08 MiB) |
| `scripts/native-smoke.py` | Passed against **both debug and optimized release** through actual bundled WebKit, IPC, Rust HTTP and embedded Harper |

Rustdoc encountered a transient missing-dependency artifact error during one build; a subsequent complete locked test run passed. Playwright now owns a separate server on 1431: an already-running desktop dev server had served stale empty CSS and caused misleading layout failures. Tests no longer reuse that server or its transformed assets. Production dependency annotation/chunk-size warnings are nonfatal; assets ship locally.

## Coverage

Existing tests still cover supported Markdown import/export/fidelity protection, frontmatter/newline/BOM preservation, stable editor block IDs, split/paste uniqueness, UTF-16/Unicode and mark/hard-break mapping, conservative context invalidation, reviewed fixes and normal isolated Undo/Redo. Filesystem coverage includes root/symlink boundaries, atomic writes, stale-hash conflicts, failed saves, read-only protection, permissions, copies, rename identity and nonempty-folder deletion. Recents, timed notifications, focus mode, inspector resizing/collapse and version synchronization remain regression-tested.

New tests cover:

- Settings v1 migration without losing original AI options, credential generation, model overrides, budgets or parallel cap; entry-level corruption/duplicate/reference isolation; stable/reserved IDs; strict URL/definition validation; intact built-in profiles and custom membership.
- StrictMode startup/migration ordering, no abandoned-load overwrite, readiness before restoring document profiles or editing settings, and no automatic overwrite of settings requiring repair/read-error recovery.
- Custom prompts/versioning through the production schema/mapping/cache/saved-review pipeline, custom profile/backend provenance, exact restoration and invalidation after incompatible definition/configuration changes.
- Effective backend/model inheritance, independent credential references and explicit no-key cache identity, global/per-backend bounds and overlap, resource aliasing, fairness, queue cancellation/draining, failure isolation and preserved legacy single-server scheduling.
- Embedded Harper protocol/offset validation, astral Unicode, fenced-code exclusion, selection-relative offsets, local cache/restoration, suggestions, source marks, explicit Apply and Undo/Redo. Native Rust tests execute the actual curated linter.
- Editable evaluation corpus validation and malformed output/network distinctions; exact quotes versus mapped findings, clean-case false positives, expected-quote proxies and latency; production provider fallback with isolated keys against mock transports. No real inference is required.
- UI creation/editing/duplication/deletion/validation of reviewers and profiles; two backend routing/limits; restart/restored reviews/fixes; isolated damaged entries; Harper inline findings/alternative choices/Undo/Redo without AI.

Input/output limits, force rerun, strict reasoning/envelope parsing, cache gating before inference, stale results during editing, reviewer error isolation, cancellation on document switch, exact saved restoration, normalized-save rebinding and metadata-only history remain covered. Legacy recovered history does not invent unknown provenance or replay findings.

## Actual native smoke, not just a browser mock

`scripts/native-smoke.py` drives the **v0.2.0 debug and optimized release executables** with `tauri-driver`/WebKitWebDriver under D-Bus/Xvfb. It uses disposable config/projects and explicit session-only keys, never user documents or OS keys.

1. Bundled UI identifies itself as Tauri, supplies session UUIDs and performs real native Markdown CRUD, conflict checks, path protection and empty-folder safety.
2. Native HTTP model/completion requests work without CORS headers; recents persist/deduplicate, failed opens preserve them and removal never deletes documents.
3. Restart/direct recent-folder reopen loads real files. Legacy settings migrate to v2 with the unchanged three-job cap and **64,000 / 120,000-character** budgets.
4. A 50,000-plus-character review sends **13** requests at peak **3**; rerun uses **19** cached units with no new HTTP.
5. Persisted custom paragraph reviewers/profile then route across **two actual native mock servers** using distinct ephemeral keys. Each server verifies its Authorization header. **12** requests total; global peak **3**, backend peaks **1** and **2**, six requests each. Rerun uses **12** cached units without HTTP.
6. Real embedded Harper IPC returns deterministic findings with exact UTF-16 quotes after an emoji. Real UI review preserves bold `has` → `have`, normal Undo restores `has`, fenced code stays unchanged and no HTTP is sent. Disk Markdown remains unchanged until an explicit save.

Container-only WebKit compositor/sandbox overrides were confined to the driver launcher, not app configuration. This verifies integration and bounds, not real-model quality, context capacity or throughput.

## Not verified / intentional limits

- No real llama.cpp/other model endpoint was provided; no real-model evaluation report, precision claim or throughput benchmark is available.
- No live Tailscale/private inference node was reachable for acceptance.
- Normal unlocked OS-keychain persistence, macOS/Windows compilation, packaging/signing/notarization and cross-platform accessibility need their own environments. The user previously confirmed the v0.1.3 macOS icon fix; that is not automated v0.2 packaging verification.
- Broad long-document performance, hostile concurrent filesystem mutation and every Markdown dialect are not certified. Crash recovery for unsaved writing is implemented and covered by Playwright plus the native smoke run (checkpoint, restart offer, Restore, conflict against an externally changed file, save a copy, clear on Save), but its behavior in a packaged macOS app is verified only by the manual checklist below. No tokenizer/context discovery or automatic essay chunking exists.
- Harper is curated American English/plain block text; mark-level inline-code exclusion, dialect controls and user dictionaries remain follow-ups. Cancellation suppresses late native results rather than forcibly stopping a running linter worker.

## Manual acceptance with your servers

1. Rebuild/install v0.2.0, preserving the stable application ID; check General version and original settings/recents/profile/document IDs after upgrade.
2. Configure named Local Fast/GPU Box backends at actual HTTP/HTTPS localhost/Tailscale URLs, actual served model IDs and independent credentials. Test Connection uses no document prose. Blank overrides inherit the selected default; explicit overrides route only their analyzer.
3. Create/duplicate a custom email-request reviewer and profile. Analyze a paragraph/selection/document as supported; inspect exact quotes, provenance and source/proposal diffs. Apply, Undo/Redo, save/reopen; unchanged saved review must restore without inference. Edit text/prompt/scope/backend/model/profile and confirm incompatible results do not restore.
4. Enable Harper in a participating profile; disconnect all servers. Confirm grammar findings, suggestion choice, Unicode and reviewed fixes; fenced code is not targeted. Disable it and confirm findings disappear.
5. Set a global/per-backend cap that the servers support. Observe actual requests/slot usage and RAM/VRAM, cancel queued/active work, and edit/switch documents mid-run. No late finding/fix may attach to changed text; failed reviewers must not stop independent ones. Legacy single-server mixed-model fallback must remain sequential while compatibility mode is on.
6. Run `npm run eval -- --dry-run`, then explicitly target each real backend/model using a private output directory. Inspect structured/mapping failures separately from human quality, false positives, missed expectations and latency. Do not treat case-pass proxies as semantic scores or publish raw reports containing private prose.
7. Repeat unsupported features, unreachable/bad-auth/unavailable-model/slow/malformed/format-fallback cases, and macOS/Windows build/keychain/accessibility checks in their native environments.

Optional single-server protocol check remains:

```sh
DRAFTBENCH_AI_BASE_URL=http://localhost:8080 \
DRAFTBENCH_AI_MODEL=served-model npm test -- src/test/realServer.test.ts
```

This Node-fetch fixture is not production native transport. See [README](../README.md) for build/smoke setup and [contributor notes](contributing.md) for architecture/migrations.

## macOS acceptance (manual, Apple Silicon)

Applies to the **current** release (the tables above are the archived v0.2.0 record). CI can only prove artifact properties for the macOS build: the release workflow mounts the DMG and asserts that the shipped binary contains both `arm64` and `x86_64` slices, that the signature is **ad-hoc** — accepting `TeamIdentifier=not set` and rejecting a real Developer team ID — and that `codesign --verify --deep --strict` passes. Launching, upgrading and using the app requires a Mac.

Run these on an Apple Silicon Mac with your real documents and servers. Report each item as pass/fail with what you saw.

1. **Checksum and install.** Download `Draftbench_0.2.8_universal.dmg` and `SHA256SUMS`, then `shasum -a 256 -c SHA256SUMS`. Expect the checksum line to end in `: OK`.
2. **Gatekeeper.** Open the DMG and drag Draftbench to Applications. Because the build is ad-hoc signed and not notarized, expect a warning rather than a clean launch; use **Privacy & Security → Open Anyway**. Record the exact wording — a change here means the signing policy changed.
3. **Upgrade over v0.2.7.** Install over the existing app without deleting anything. Confirm: the About/version shows 0.2.8; your recent projects, settings, backends/models, custom reviewers, profiles, document profiles and saved reviews are intact; opening a previously analyzed document restores its previous feedback **without sending any AI request** (watch the server log for zero requests).
4. **Automatic Harper is a separate switch.** After the upgrade, **Settings → Analysis → Automatically review with Harper** must be off. Type in a document and confirm Harper does not run on its own while **Repeated word** still does. Then run **Run reviewers → Harper** explicitly and confirm it works with automatic mode off, and that enabling automatic mode persists across a quit/relaunch.
5. **Harper and inline code.** In a paragraph containing `` `They has` `` and a fenced block, Harper must underline prose only — never the code span. Confirm no underline lands inside `<code>` visually and that prose around it is still reviewed.
6. **Filters govern the underlines.** In the Analysis pane choose one analyzer and confirm the editor shows underlines only for that reviewer; then set severity/category filters and confirm the same. Enable **Show dismissed** and confirm dismissed findings are listed but never underlined. Use “hidden by filters · Show all” to reset.
7. **Revision mode continuity.** Revise a Harper finding, edit the quoted sentence (the reference must say **Edited since reference**), close the pane, and reopen the same finding: it must resume the original capture rather than adopt the freshly regenerated warning. Confirm **Re-review** is the only action that replaces the captured advice, and that a different finding offers **New reference** instead of silently replacing the pin.
8. **Crash recovery.** Type a new sentence, wait ~4 seconds, then force-quit Draftbench (Force Quit, or `kill -9` on the process). Relaunch and open the same document: Draftbench must show the file as it is on disk and offer **Restore into the editor / Discard snapshot / Not now**. Choose **Not now** first and confirm the snapshot is offered again on reopen. Then **Restore**, and confirm the recovered sentence is in the editor and marked unsaved.
9. **Recovery must not overwrite.** With the recovered text still unsaved, change that file from another editor (or `printf` a different line into it). Click **Save** in Draftbench: it must report a conflict, leave the other editor's content untouched, and offer **Reload from disk** or **Save a copy**. Confirm on disk that the file still contains the external change and that a copy you saved contains the recovered text.
10. **Recovery storage.** `ls -l ~/Library/Application\ Support/org.draftbench.desktop/recovery.json` must show `-rw-------` (0600), and no `recovery.json` may appear inside your writing project. After a successful Save the file must be gone or empty for that document. If Draftbench reports `Could not protect recovery data`, capture the exact message — it means the private-write verification failed on your filesystem.
11. **Keychain.** Configure a backend key, quit and relaunch: the key must still be available (Test Connection succeeds without re-entering it). With the key deleted from Keychain, confirm the session-only warning appears and no plaintext key is written to settings.
12. **Tailscale node.** With a remote `llama-server` over Tailscale, run a document review, then cancel mid-generation and confirm the server stops generating (watch its log) rather than only the client discarding the result.
13. **Settings → Analyzers layout.** Confirm each analyzer's description, origin line, override fields, “Effective:” line and action buttons share one left edge under the analyzer name, and that Cancel saves nothing.
14. **No silent network.** With all backends unreachable, confirm ordinary editing, pane toggling, profile changes, reopening documents and revision-mode actions never produce AI requests; only explicit reviewer runs do.

## Artifacts

- Current native-verified debug executable: `src-tauri/target/debug/draftbench` (**v0.2.0**).
- Current optimized native-smoke-tested executable: `src-tauri/target/release/draftbench` (**v0.2.0**).
- Built Debian package: `src-tauri/target/release/bundle/deb/Draftbench_0.2.0_amd64.deb` (**8.08 MiB**). Package contents were inspected to confirm Harper's license/notice; installation into a normal host desktop was not performed.
- Source version **0.2.0** is synchronized across npm, Tauri, Cargo and root lockfiles. Desktop bundles include Harper's Apache-2.0 license/notice.
- Build products, `.draftbench`, secrets, plans and evaluation reports are ignored, not committed release assets.
