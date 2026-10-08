# v0.2 verification and acceptance checklist

**Archived v0.2.0 record. Current v0.2.1 audit, fixes and verification:** [stabilization-v021.md](stabilization-v021.md).

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
- Broad long-document performance, hostile concurrent filesystem mutation/crash recovery and every Markdown dialect are not certified. No tokenizer/context discovery or automatic essay chunking exists.
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

## Artifacts

- Current native-verified debug executable: `src-tauri/target/debug/draftbench` (**v0.2.0**).
- Current optimized native-smoke-tested executable: `src-tauri/target/release/draftbench` (**v0.2.0**).
- Built Debian package: `src-tauri/target/release/bundle/deb/Draftbench_0.2.0_amd64.deb` (**8.08 MiB**). Package contents were inspected to confirm Harper's license/notice; installation into a normal host desktop was not performed.
- Source version **0.2.0** is synchronized across npm, Tauri, Cargo and root lockfiles. Desktop bundles include Harper's Apache-2.0 license/notice.
- Build products, `.draftbench`, secrets, plans and evaluation reports are ignored, not committed release assets.
