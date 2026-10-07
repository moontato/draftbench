# v0.1 verification and acceptance checklist

Recorded on **2026-10-07**, in a Debian 12 x86-64 build environment. This is an initial implementation, not a claim that every OS or inference server has been certified.

## Automated checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run format:check` | Passed |
| `npm test` | **40 passed**, one opt-in real-server test skipped |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **6 passed** |
| `npm run test:ui` | **5 passed** |
| `npm audit` | Zero reported vulnerabilities at verification time |
| `npm run tauri build` | Linux optimized executable and Debian package produced |
| `scripts/native-smoke.py` against release executable | Passed in the actual bundled WebKit desktop |

The production build has nonfatal dependency annotation/chunk-size warnings. The editor/React/schema bundle is approximately 926 KB uncompressed / 291 KB gzip. Assets ship locally; these warnings do not imply hosted resources or runtime downloads.

### What the tests establish

- Real TipTap/ProseMirror Markdown import/export, nested range mapping, marks, hard breaks, UTF-16/Unicode safety, stable session IDs, split/paste uniqueness, preservation of an original ID when a clone is pasted before it, material/type/context invalidation, and fixes isolated in normal Undo/Redo history.
- Deterministic repeated-word detection, including multiple identical occurrences and Unicode words, with trusted local offsets distinguished from untrusted AI offsets.
- Mocked review output for all four semantic analyzers; strict envelope/issue validation, invalid Unicode rejection, nonunique/unknown/out-of-scope quote rejection, scope planning, input limits, cancellation, empty-result caching, cache hits/invalidation, and code-as-context rather than a prose diagnostic target.
- Provider inheritance, per-analyzer outgoing model overrides, optional model discovery, minimal completion connection testing, compatible JSON-format fallback, and classified errors without a real inference server.
- UI write/analyze/inspect/apply/undo/save/dismiss workflow, Problems filters/grouping, focus mode, save-copy isolation, canceled dirty-document switches, session-key fallback warning visibility, and exclusion of credentials from persisted JSON.
- Rust safe writes, conflict detection, filesystem boundaries, symlink rejection, read-only protection, preservation of permissions, endpoint construction, and HTTP failure/cancellation scenarios using a native mock server.

### Native smoke test is not just a browser test

The release executable was launched through `tauri-driver` and WebKitWebDriver under D-Bus/Xvfb. The script verifies:

1. Actual bundled application renders, identifies itself as Tauri (not browser preview), and supplies `crypto.randomUUID` for session identities.
2. Real IPC opens a temporary ordinary project and saves/reads Markdown through Rust.
3. External-change conflicts and out-of-root paths are rejected.
4. Real folder/file creation, rename, listing, deletion, and nonempty-folder protection.
5. Native Rust HTTP retrieves models and performs a completion against a temporary mock compatible server **without CORS headers**.

The container's test-driver launcher used temporary WebKit compositor/sandbox environment overrides because the container cannot provide a normal desktop sandbox. These are **test-runner-only**, not application configuration; the production app does not disable its webview sandbox.

It explicitly selects an empty in-memory credential override; it does not read or change a user's OS credentials. No user documents are used. The full editing UI workflow is covered separately by Playwright with a clearly test-only injected native bridge.

## Not verified here

- **Actual llama.cpp model inference.** No server was available at `localhost:8080`. No inference runtime or model was provisioned/downloaded.
- **Actual Tailscale reachability.** URL support/native transport are implemented, but no reachable private inference node was provided.
- Semantic quality/precision of a real model and its reasoning/output-token behavior.
- OS credential-store persistence in a normal unlocked desktop/keychain environment. Session-only fallback behavior is implemented and mocked UI regression-tested.
- Windows/macOS compilation, packaging, signing/notarization, or desktop-specific accessibility behavior.
- Comprehensive long-document performance, hostile concurrent filesystem mutation, crash recovery, or every Markdown dialect.

Dismissals are intentionally session-only. A document switch/reload starts fresh identities and discards active findings/dismissals. Profiles/settings and exact-input analyzer caches persist. No fuzzy restoration is attempted.

## Required real-server acceptance pass

With your existing `llama-server`:

1. Start Draftbench using `npm run tauri dev` or the packaged app in a normal desktop session.
2. Configure `http://localhost:8080` and the **actual served model ID/alias** (for example `qwen3-8b`) in Settings → AI. Test Connection should complete without writing text being sent.
3. Open `examples/nonfiction/essay.md` (prefer a copy if you want to preserve the fixture), make a meaningful edit, and save.
4. Run **Clarity**. Inspect a real finding, its server/model provenance, quoted range, and explanation.
5. Review the original/proposed-text diff, apply a safe fix, Undo/Redo it, and save/reopen the document. Check the actual Markdown file in another editor.
6. Re-run unchanged input: expect cache reuse. Force rerun: expect a new model request.
7. Edit a passage during an in-flight run: affected/context-dependent results must not attach to changed text. Cancel a run and switch documents: no late result should attach to the other document.
8. Run an explicitly selected passage and current paragraph. No document-only review should silently run on the whole document in those modes.
9. Try the other reviewers. Choose Technical writing or Essay to enable Structure. Review quality rather than assuming every emitted issue is correct.
10. Change Redundancy's model override to another **actually available** model. Verify it requests that ID and leaves the other reviewers on the default. On a single-model server, an unavailable ID may fail; the client does not switch/download models.
11. Change the URL to your reachable Tailscale IP or hostname, such as `http://100.80.40.20:8080` or `http://gpu-box.tailnet-name.ts.net:8080`, and repeat the Clarity loop without enabling CORS.
12. Exercise unreachable address, bad authentication, unavailable model, slow completion, malformed output, and unsupported API features. Error messages must remain actionable without exposing writing or authorization data.

An additional opt-in protocol-level check is available:

```sh
DRAFTBENCH_AI_BASE_URL=http://localhost:8080 \
DRAFTBENCH_AI_MODEL=qwen3-8b npm test -- src/test/realServer.test.ts
```

That test uses a Node-fetch adapter and a short fixture, **not production native transport**. It complements rather than substitutes for the desktop acceptance pass.

## Artifacts

- Optimized Linux executable: `src-tauri/target/release/draftbench`
- Debian package: `src-tauri/target/release/bundle/deb/Draftbench_0.1.0_amd64.deb` (approximately 4.3 MB)
- Architecture/setup/extensions/limitations: `README.md`

Build artifacts are ignored by Git and reproducible from the checked-in lockfiles. No signing keys, API keys, user project files, or inference weights are included.
