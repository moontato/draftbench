# Draftbench v0.2.1 stabilization

This is a patch release on v0.2.0 (`d229e76`), with no new product capabilities, dependencies, frameworks or persistence schema versions. The writer-first workflow, Markdown authority, custom/built-in reviewers, profiles, named backends, Harper, caching, saved reviews/history and reviewed Undo/Redo remain intact.

## Focused audit and disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| P0 | Save shortcuts ignored an active file operation; Save a copy acquired its lock only after a prompt. Closing/repeated close events could race writes/prompts or strand an unsaved confirmation. | Fixed: reserve locks before prompting, reject conflicting saves/closes, deduplicate leave/close handling, and allow only the explicit save-before-leave path through a file lock. Failed saves retain the buffer and block the switch. |
| P0 | Late project metadata IPC was applied to the currently active native root, potentially copying private quotes/history into another project. | Fixed: frontend pins metadata to the expected canonical project; native rejects mismatched reads/writes before creating sidecars. Prior analysis is flushed before a project switch. |
| P1 | Deleting the active document did not cancel inference, leaving requests running after the UI lost its Cancel action. | Fixed: cancel active/queued analysis and reset progress/session state on successful deletion. |
| P1 | Settings validated only budgets before mutating keys; async key operations could apply stale drafts after a backend switch. | Fixed: validate all settings before Save changes any key; lock editing/navigation/close while storing keys, guard duplicate operations, cancel obsolete tests and ignore stale key-presence checks. Session-only warnings survive both save success and failure. |
| P1 | A malformed unrelated option could make startup abandon valid custom reviewers/profiles/backends. Missing alias fields could pick the generic default server/model; missing defaults at the 20-backend limit exceeded the schema cap. | Fixed: repair individual existing option fields with warnings while preserving valid configuration. Recover alias fields from the saved Default backend. If safe routing cannot be recovered, disable affected inherited AI rather than silently send prose to another server; retain all 20 valid backends. Startup repair does not auto-overwrite the original. |
| P2 | Repeated typing debounces could launch multiple uncancellable native Harper workers. | Fixed: reuse the existing queue for one shared grammar CPU lane across automatic/manual work; cancelled queued calls never reach IPC. In-flight work may finish but cannot publish stale results. |
| P2 | Editing profile membership left active AI findings from excluded reviewers. | Fixed: filter retained findings through resolved profile membership as well as version/configuration/enablement. |
| P2 | Modal focus enumeration omitted textareas; stacked dialogs competed for keyboard events. | Fixed: include enabled textareas and let only the topmost modal handle Tab/Escape. |
| P2 | Display-name grouping merged distinct same-name reviewers; unavailable filters persisted. Same-name reviewers also collapsed progress counts. | Fixed: use stable IDs for groups/progress, disambiguate duplicate labels only, reset unavailable filters, and expose selected/disclosure state accessibly. Group accumulation is linear rather than repeatedly copying growing arrays. |

No identified blocking P0/P1 finding remains in this audit. This is not a guarantee against every hostile concurrent filesystem mutation, OS crash or unsupported platform scenario.

## Verification

Baseline before implementation: **137 TypeScript tests**, **24 UI workflows**, **14 Rust tests**, typecheck/lint/format and native debug build passed. The first baseline build command timed out; retry completed. One real-server test remained intentionally skipped.

Final results:

- **143 TypeScript tests passed**, one opt-in real-server test skipped.
- **29 Playwright workflows passed**, including all original 24. The test-only bridge now honors disk conflicts/failed writes and native dialog confirmation behavior instead of blindly succeeding.
- **17 Rust tests passed**, including expected-project enforcement, pre-cancellation, no redirect forwarding, bounded responses and non-echoing errors.
- Typecheck, ESLint, Prettier, Rust formatting and `git diff --check` passed.
- Evaluation dry-run: **12 cases × one target**, no HTTP requests.
- npm audit: zero reported vulnerabilities.
- **v0.2.1 Linux debug and optimized release builds passed**; Debian package built at `src-tauri/target/release/bundle/deb/Draftbench_0.2.1_amd64.deb` (approximately **8.08 MiB**).
- Actual bundled **WebKit/native smoke passed against both debug and optimized release**, using disposable projects/config and two local mock servers. It verified Markdown CRUD/conflicts/path safety, recent-folder restart/reopen, legacy settings migration, long-input budgets/cache, custom reviewers/profile, isolated credentials, global peak **3** and backend peaks **1/2**, and real Harper Unicode/code-block handling/bold-preserving Apply/Undo without HTTP.
- New native smoke deliberately switches to another project and attempts old-project metadata reads/writes: both are refused and **no `.draftbench` directory is created in the wrong project**.

A transient rustdoc artifact-resolution failure required a full retry, which passed. One combined verification command timed out; the complete UI suite was subsequently run separately and passed. These are recorded rather than treated as platform certification. Production chunk/annotation warnings remain nonfatal.

The Harper regression uses deferred native work, proving one invocation in flight and removal of an aborted queued call; it is not a typing/throughput benchmark on every OS or document size. The save/close/failed-leave regressions are browser workflows with an explicit test bridge. Native smoke exercises actual WebKit/IPC/filesystem/network/Harper, but does not certify physical OS-window shutdown gestures or real keychain persistence.

## Compatibility and remaining concerns

- Settings/project/analysis schemas stay at their existing versions; supported v1/v2 data remains readable. Stable document/analyzer/profile/backend IDs and the old credential slot are unchanged. No prompts or Markdown conversion rules were redesigned.
- Normal external changes, permissions, failed writes and unsupported Markdown remain protected by existing safe-write/read-only/conversion safeguards. Full hostile filesystem TOCTOU protection and crash recovery remain deferred; no destructive automatic recovery was added.
- Native Harper cannot be forcibly interrupted mid-lint. Its queued resource usage is now bounded; running results are still cancellation/freshness-gated. Existing plain-block/inline-code, dialect and user-dictionary limitations are unchanged, not new features in this release.
- Real inference quality/throughput, live Tailscale connectivity and a normal unlocked OS-keychain were not available for re-verification. The existing localhost/LAN/Tailscale HTTP/HTTPS path and native timeout/concurrency behavior are preserved and mock-native tested.
- macOS/Windows builds, signing/notarization and broader accessibility/performance certification remain unverified here. Do not infer them from Linux or browser tests.
- The session controller remains sizeable; further decomposition is deferred until a concrete correctness or maintenance need justifies it. No speculative architecture rewrite was performed.

Application versions are synchronized to **0.2.1** across npm, Tauri, Cargo and root lockfiles. Release artifacts, reports, private metadata, plans and credentials are not committed. See [README](../README.md) for installation and [contributor notes](contributing.md) for contracts and migrations.
