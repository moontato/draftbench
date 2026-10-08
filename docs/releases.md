# Tag-triggered releases

`.github/workflows/release.yml` builds and publishes installers when a **stable `vX.Y.Z` tag** is pushed. The tagged commit must contain the workflow and synchronized version metadata. No in-app updater is added.

## Assets

| Platform | Runner / target | Installer |
| --- | --- | --- |
| Linux x86_64 | Ubuntu 22.04 / `x86_64-unknown-linux-gnu` | `.deb` and `.AppImage` |
| macOS Apple Silicon + Intel | macOS 15 / `universal-apple-darwin` | One Universal `.dmg` |

Linux builds on Ubuntu 22.04 rather than 24.04 to avoid unnecessarily raising the glibc baseline. AppImages still need a compatible host; they are not a guarantee of support for every distribution. Linux ARM and Windows are not part of this release matrix.

macOS apps are **ad-hoc signed only**, not Developer ID signed or notarized. This supports Apple Silicon execution without Apple account secrets, but does not establish a trusted distribution identity or remove Gatekeeper warnings. For a build you trust, use **System Settings → Privacy & Security → Open Anyway** if needed. Do not disable Gatekeeper systemwide. Developer ID signing/notarization can be configured separately later.

For an AppImage, run `chmod +x Draftbench_*.AppImage` before launching. For macOS installation/update, quit the old app, open the DMG, and replace `/Applications/Draftbench.app`; see [README](../README.md#installing-or-updating-on-macos).

## Pipeline

1. Validate the tag against `package.json`; existing version tests also check npm lockfiles, Tauri, Cargo and Cargo.lock. Malformed, prerelease and mismatched tags stop before builds/publishing.
2. Run frontend typecheck/lint/format/tests, inference-free evaluation and browser workflows.
3. Run native Rust tests on each host, then build release installers with `npm ci` and locked Cargo dependencies. Both macOS Rust targets are installed for the universal build.
4. Check for every expected nonempty installer and retain workflow artifacts for seven days. One failed platform prevents publishing.
5. Download all installers, generate `SHA256SUMS`, create a draft GitHub Release, upload all assets, then publish it. If upload fails, a new release remains draft until a successful retry.

Only the final publishing job receives `contents: write`. GitHub supplies its short-lived `GITHUB_TOKEN`; no personal token or signing secrets are required. GitHub Actions must be enabled and repository/organization policies must permit the actions and publishing permission. Branch protection and tag rules should limit who can create release tags.

Concurrent runs for the same tag are serialized. Re-running a failed workflow retries the tagged commit; matching asset names are replaced using `gh release upload --clobber`. Do not move/recreate published tags. If repository release immutability is enabled, replacing published assets will be refused; use a new version/tag instead.

## Creating a release

Commit and push the workflow first. For future releases, update `package.json`, both root npm-lock version entries, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the Draftbench entry in `src-tauri/Cargo.lock` together. No automatic version rewriting happens in CI.

Example for the current version, **provided the tag does not already exist**:

```sh
npm test -- src/test/version.test.ts src/test/releaseTag.test.ts
npx tsx scripts/check-release-tag.ts v0.2.1
git push origin main
git tag -a v0.2.1 -m 'Draftbench v0.2.1'
git push origin v0.2.1
```

Watch **Actions → Release Draftbench**. When both platforms and publication succeed, downloads appear at [GitHub Releases](https://github.com/moontato/draftbench/releases). A tag that existed before the workflow was committed will not retroactively trigger it; normally release the next patch rather than deleting a published tag.

`SHA256SUMS` detects changed/corrupted downloads; it is not a detached publisher signature. For the complete downloaded installer set, Linux can use `sha256sum -c SHA256SUMS`, and macOS can use `shasum -a 256 -c SHA256SUMS`.

## Verification boundary

Local setup verification: **146 unit tests passed** (one opt-in real-server test skipped), typecheck/lint/format passed, matching/mismatched tag CLI checks behaved correctly, and `actionlint` accepted the workflow. Optimized Linux `.deb` and `.AppImage` bundles built successfully using locked Cargo arguments. The actual generated AppImage passed the full WebKit/native smoke suite, including safe Markdown operations, cross-project metadata refusal, two-server concurrency/isolated credentials, cache reuse and real Harper Apply/Undo.

GitHub-hosted Ubuntu 22.04/macOS packaging and actual upload/publication cannot be claimed until a tag run succeeds. Local Linux verification ran on this Debian environment. The workflow does not certify model quality, normal OS-keychain behavior, notarization or all host distributions.
