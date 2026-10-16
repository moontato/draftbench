# Draftbench v0.2.8 stabilization

Baseline: **v0.2.7** (`84e11f0`, tag `v0.2.7`). v0.2.8 is a stabilization release: no new product
feature, no architecture rewrite, no new database, no cloud/account/plugin/chat/autocomplete work,
and no change to the inference protocol. Markdown tables, images and footnotes stay deferred to
v0.3.

## 1. Harper no longer lints inline code

Inline code is prose-shaped text that Harper reads as English, which produced underlines inside
code spans and advice about identifiers.

- `src/diagnostics/proseMask.ts` masks inline-code UTF-16 units with equal-length **spaces**
  before the paragraph reaches the native engine, so every returned offset still indexes the
  original text. Surrogate pairs are never split.
- A returned diagnostic that overlaps a masked range is **discarded**, never reattached to nearby
  prose. Accepted quotes are restored from the original block text. Skipped diagnostics are
  reported once as `Harper skipped N diagnostic(s) inside inline code.`
- `Block.codeRanges` and `Block.formatHash` were added. **`Block.hash` is unchanged**: adding code
  ranges to the block hash would have invalidated every saved review, feedback snapshot and
  analysis history on upgrade.
- `Analyzer.formatSensitive` (Harper only) makes the cache key, the finding, the saved-review
  restore check and the feedback-snapshot restore check all consider `formatHash`. Adding or
  removing inline code therefore expires the affected Harper findings and cache entries without
  touching AI reviewer identity (AI reviewers receive plain text either way).
- Persisted findings accept an optional `formatHash` matching `^([a-f0-9]{64})?$`, so older records
  without the field keep working.

## 2. Evaluation harness, corpus and honest benchmarking

- Corpus grew from 16 to **38 cases**: all five AI built-ins plus a custom `eval-reviewer`
  (`eval/eval-settings.json`), clean and issue cases per analyzer, multi-paragraph and long
  documents. Average source length 173 → 222 characters; longest 1,262.
- `eval/labels.json` is a human-label sidecar (38 entries: `expected`, `too-strict`,
  `too-lenient`, `unclear`). Labels annotate reports and are **never** sent to a model; the
  reviewer field is marked as an assistant draft awaiting author confirmation.
- `--repeat 1..5`, `--sweep 1,2,4`, `--analyzer`, `--profile`, `--labels`; report version 2 with
  per-sweep JSON/Markdown and a combined Markdown for multiple sweeps.
- `analyzers/jobs.ts` now records **queue wait per shared server resource**, reported separately
  from model latency, so a saturated queue is not mistaken for a slow model. Cases are classified
  stable or flaky across repeats.
- Benchmark examples now instruct reading the exact served model ID from `/v1/models` and using
  that ID in `--model`; llama-server names a model from GGUF metadata, so stale example IDs such as
  `qwen3-8b` were corrected. **No benchmark numbers are claimed**: this environment has no
  inference server, and results must come from the author's own runs.

## 3. Workspace controller decomposition

`useWorkspaceSession.ts` was 1,288 lines and owned findings/filter/decoration state, dirty state,
file/save locks, the save pipeline, metadata persistence, leave confirmation, and the whole
revision-capture lifecycle. It is now **874 lines** and composes four single-owner seams:

- `useFindingsView.ts` — findings, dismissals, filters, selection, the authoritative synchronous
  `findingsRef`, and the editor decoration effect.
- `useDocumentSave.ts` — dirty state, file/save locks, save / save a copy / conflict hashes,
  feedback capture at the correct frame, debounced analysis-metadata write, unsaved-changes
  confirmation, Ctrl/Cmd+S, and `onSaved` reporting.
- `useRevisionMode.ts` — retained capture, pane visibility, resume, explicit New reference,
  Re-review publication, reference-scoped Apply/Jump.
- `useCrashRecovery.ts` — see below.

The public return shape of `useWorkspaceSession` is unchanged, and the existing unit and browser
suites were used unchanged as the equivalence contract. `WorkspaceView.tsx` component splitting was
deliberately **not** done in this release: it is presentation-only, and the remaining session blocks
(`loadDocument`/`openProject`, review-run wiring) are entangled with the editor and review runner, so
extracting them would add indirection without reducing risk.

## 4. Crash recovery for unsaved writing

- Snapshots live in `recovery.json` inside Tauri's app-config directory, never inside the author's
  writing project. Bounded: 20 documents, ~2 MB total, 1 MB per document, oldest dropped first.
  Corrupt or unknown-version files are ignored, not applied, and every record is re-validated on
  read (self-consistent hashes, key derived from the record's own project/path, normalized path
  components).
- **Permissions are restrictive before content exists.** `storage::atomic_write_private` creates the
  temporary file with `0600` at creation time, enforces `0600` again before the first byte is
  written (creation mode is masked by the umask), never inherits looser permissions from an older
  copy, and verifies after the atomic rename that the final file is `0600` — a failed verification
  is an error, not a silent fallback. Ordinary `atomic_write` still preserves the permissions of the
  file it replaces, so documents, settings and sidecars behave exactly as before.
- Checkpoint policy: **3 s debounce**, never stacking pending writes, and a **maximum interval of
  30 s** so continuous typing that never pauses still gets a snapshot. Nothing is written while a
  document is clean, and read-only (unsupported Markdown) documents are never checkpointed. Storage
  failure is reported once, not per keystroke, and never affects the editor buffer.
- A record stores the draft text, its hash, and **the hash of the file as it was on disk when the
  snapshot was captured**. Restoring keeps that hash in the session, so the first Save after a
  restore **conflicts** rather than overwriting a file that changed elsewhere; the author then
  reloads or saves a copy. Recovery can never silently overwrite a document.
- On reopen: a snapshot that already matches the file is dropped silently; a differing one offers
  **Restore into the editor**, **Discard snapshot**, or **Not now** (Escape is the same and keeps
  the snapshot). Nothing is applied automatically. Restore rebuilds the session with a new token so
  the editor remounts, marks the draft dirty, and clears the feedback-restore intent because
  recovered text was never reviewed.
- A snapshot is spent by a successful Save, an explicit discard of unsaved changes, deleting the
  document or its folder, or switching projects after resolving the draft. A plain reload of the
  same clean document is **not** a discard. Renaming re-keys the snapshot to the new path.

## 5. Release pipeline hardening

- CI now runs `cargo fmt --check` before `cargo test` in the build matrix.
- The macOS job mounts the built DMG and asserts: the shipped binary contains **both** `arm64` and
  `x86_64` slices; the signature is **ad-hoc** (`Signature=adhoc`); `codesign --verify --deep
  --strict` passes. `spctl` output is printed informationally because an ad-hoc build is expected to
  be rejected by Gatekeeper — that is the documented **Open Anyway** path, not a failure.
- **Signing validation corrected.** `codesign` reports `TeamIdentifier=not set` for a legitimate
  ad-hoc build, so the previous check would have rejected a correct release. The workflow now reads
  the value and rejects only a real team identifier (any value other than `not set`, or a non-empty
  `TeamIdentifier` line), while still requiring `Signature=adhoc`. An unsigned build fails the
  `Signature=adhoc` requirement. No Apple Developer identity and no notarization are required or
  attempted.
  This validation logic was executed locally against stubbed `codesign`/`lipo`/`hdiutil`/`spctl`
  output for six cases: ad-hoc with `TeamIdentifier=not set` → accepted; ad-hoc with no
  `TeamIdentifier` line → accepted; Developer ID (`TeamIdentifier=H9MDYMS4Y7`) → rejected; unsigned
  → rejected; Intel-only slice → rejected; Apple Silicon-only slice → rejected.
- The publish job refuses to publish unless all three installers are present and checksums verify
  with `sha256sum --check SHA256SUMS`.
- Ad-hoc signing without Apple Developer credentials or notarization is unchanged.

## 6. Settings → Analyzers alignment

Metadata lines (`Built-in · paragraph + context`, `Effective: Default · <model>`), override fields and
analyzer action buttons now share one left edge under the analyzer name instead of some being
flush-left and others indented. Behavior is unchanged; a browser test asserts the shared edge and
that Cancel saves nothing.

## Regression matrix

| Change | Automated coverage | Native / manual |
| --- | --- | --- |
| Inline-code masking, offset preservation, surrogate safety | `src/test/proseMask.test.ts` | `scripts/native-smoke.py` asserts no `.diagnostic` lands inside `code` |
| Harper never underlines code, still reviews surrounding prose | browser test “Harper reviews prose around inline code and never underlines the code span” | native smoke grammar fixture |
| Formatting-only edit expires Harper finding/cache/feedback without changing `Block.hash` | `src/test/harper.test.ts`, `src/test/feedbackSnapshots.test.ts` | — |
| 38-case corpus, labels sidecar, custom-reviewer fixture, filter/repeat/sweep behavior, queue accounting | `src/test/eval.test.ts` | `npm run eval -- --dry-run`; real-model runs remain author-run |
| Queue wait separated from model latency, stable/flaky classification | `src/test/eval.test.ts`, `src/test/parallelAnalysis.test.ts` | mock-server harness check |
| Findings/filter/decoration seam | existing findings, filter and review-context suites unchanged | browser suite |
| Save/lock/metadata seam | existing save, conflict, copy, close-lock and feedback-capture suites unchanged | browser suite |
| Revision capture seam | `src/test/revisionReference.test.ts`, `src/test/workspaceReviewContext.test.ts`, revision browser tests | — |
| Recovery record shape, key derivation, validation, pruning, checkpoint policy | `src/test/recovery.test.ts` | Rust unit tests in `src-tauri/src/recovery.rs` (key/validation/pruning/0600/ignore-corrupt) |
| Offer, defer, discard, superseded-drop, checkpoint-on-typing, clear-on-Save, restart offer, rename re-key | six browser tests in `tests/ui/workflow.spec.ts` | native smoke: checkpoint → restart → Restore → Save conflict against an externally rewritten file → save a copy → cleared after Save |
| Restore cannot overwrite a file changed elsewhere | browser test asserts `CONFLICT` and that the file keeps the external content | native smoke asserts the same against a real file |
| macOS universal slices, ad-hoc signature (including `TeamIdentifier=not set`), checksums | release workflow steps, exercised locally against stubbed tool output in six accept/reject cases | manual checklist in [verification.md](verification.md) |
| Recovery temporary file is private before content lands; final file verified `0600`; ordinary writes still preserve permissions | Rust test `private_writes_are_restricted_before_content_lands` in `src-tauri/src/storage.rs` | `ls -l` check in the manual macOS checklist |
| Analyzers settings alignment | browser test “Analyzers settings align metadata, fields and actions under the analyzer name” | — |

## Verification

```sh
npm run typecheck        # clean
npm run lint             # clean
npm run format:check     # clean
npm test                 # 290 passed, 1 skipped (opt-in real-server test)
npm run test:ui          # 53 passed
npm run eval -- --dry-run   # 38 of 38 cases prepared, no HTTP
npm run build            # built; pre-existing single-chunk size warning remains
git diff --check         # clean
npx tsx scripts/check-release-tag.ts v0.2.8   # verified
npx vitest run src/test/version.test.ts src/test/releaseTag.test.ts   # 5 passed
```

Version metadata is synchronized at **0.2.8** across `package.json`, both root entries of
`package-lock.json`, `src-tauri/Cargo.toml`, the `draftbench` entry in `src-tauri/Cargo.lock`,
`src-tauri/tauri.conf.json`, `README.md` and the `docs/releases.md` tagging example. No dependency
versions were changed.

```sh
cargo fmt --check --manifest-path src-tauri/Cargo.toml   # clean
```

## Rust verification status

`cargo fmt --check` passes on the real manifest. **The full Tauri crate could not be compiled in
this environment**: `cargo test --locked --manifest-path src-tauri/Cargo.toml` fails in the build
script of `libdbus-sys` because `pkg-config` and the GTK/WebKit/DBus development packages are not
installed and the account has no root to install them. This is an environment limitation, not a code
result, and no native build, packaging or IPC behavior is claimed from it.

To verify the changed Rust code anyway, `src-tauri/src/storage.rs` and `src-tauri/src/recovery.rs`
were copied byte-for-byte (only the `#[tauri::command]` attribute lines and the `tauri` import path
replaced by a minimal shim) into a standalone crate with the same dependency versions:

```sh
cargo clippy --locked --all-targets -- -D warnings   # clean
cargo test --locked                                  # 11 passed
```

Those 11 tests are the real ones: 5 in `recovery.rs` (key stability/path specificity, forged or
oversized record rejection, count+byte pruning, private round trip with `0600` and per-document
clear, corrupt/unknown-version ignored) and 6 in `storage.rs`, including the new
`private_writes_are_restricted_before_content_lands`. One clippy finding was fixed in the process
(`sort_by` → `sort_by_key` in `prune`).

**Not covered by that harness:** the `#[tauri::command]` macro expansion, `generate_handler!`
registration of `recovery::load_recovery` / `write_recovery` / `clear_recovery`, real IPC dispatch,
and every other module of the crate. Those require the author's machine or CI.

## Not verified in this environment

- **No full native build here**: `cargo test --locked --manifest-path src-tauri/Cargo.toml` cannot
  run because `pkg-config`, `libdbus-1-dev` and the WebKit/GTK development packages are missing and
  cannot be installed without root. Run `cargo fmt --check`, `cargo clippy --locked -- -D warnings`
  and `cargo test --locked` on your own machine before tagging; CI runs `fmt` and `test`.
- **No inference server here**: no real-model evaluation report, latency table or quality claim.
  Harness behavior was verified against a disposable mock endpoint only.
- **No macOS host here**: DMG launch, Gatekeeper wording, upgrade over v0.2.7, Keychain persistence,
  Tailscale reachability and packaged crash recovery are verified only by the manual checklist.
- Recovery is a per-document crash net, not version history; Undo does not cross a restore, and
  **Reload from disk** remains the way back to the file. Recovery is desktop-only (the browser
  preview has no private app storage).
- Overlapping-findings presentation remains a design proposal, not implemented.
