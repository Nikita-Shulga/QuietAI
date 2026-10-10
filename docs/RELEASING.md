# Building and publishing Quiet AI

Use Python 3 and .NET 10 SDK. scripts/build.py downloads pinned Electron archives, checks published SHA-256 values, builds the self-contained local monitor, includes licenses, rebrands the app, and packages a ZIP. Use a fresh output directory.

Windows builds can set --rcedit to a local official Electron rcedit executable; otherwise the pinned v2.0.0 binary is downloaded on Windows. macOS builds use built-in codesign. Cross-building Mac from Windows requires --rcodesign pointing to an official apple-codesign executable, and permission to create local framework symlinks. The rcodesign path argument is local tooling only; it is not included in the app.

Mac app bundles preserve framework symlinks and executable permissions, set Quiet AI names and identifiers on main/helper bundles, copy the architecture-specific monitor runtime, and apply ad hoc signing. Signing runs with a relative entitlements path so a Windows drive colon is not interpreted as a signing scope.

Ad hoc signatures enable local code loading; they do not provide Developer ID trust or notarization. A public Mac stable release needs a Mac launch check plus signing/notarization using the owner's Apple credentials. No signing keys are bundled. Do not claim the Windows-produced Mac preview has been executed on macOS.

Before publishing, check the actual packaged executable, folder discovery, provider integration, default/minimum-size layouts, idle confirmation, timer controls, countdown cancellation, and relevant operating-system permissions on each advertised platform. Keep real shutdown/sleep actions out of unattended automated validation. Build artifacts alone do not establish this behavior.

Source/public screenshots must contain illustrative sessions, no private paths or transcripts. Archive the complete source including .github and .gitignore, and all runtime redistribution notices. Provide SHA-256 values and the specific validation performed.

`.github/workflows/build.yml` builds all four architectures on every push and pull request. Pushing a tag such as `v4.2.0` also creates a GitHub Release with the four ZIPs and `SHA256SUMS.txt`, using the workflow's own token; no other secrets are needed. The release job refuses a tag that doesn't match the version in `scripts/build.py` and `desktop/package.json`. Developer ID signing and notarization remain owner actions.

## Shipping an update

Installed copies check the repository's latest GitHub Release (Settings → About → Updates, and quietly every 6 hours). The repository must be public. The build stamps `updateRepo` into the packaged `package.json` from `GITHUB_REPOSITORY` (or `--repo owner/name` for local builds); a build without it shows updates as unavailable.

1. Bump `VERSION` in `scripts/build.py` and `version` in `desktop/package.json` (e.g. `4.2.1`), and add a `## Quiet AI 4.2.1` section to `CHANGELOG.md` — it becomes the release notes.
2. Commit and push.
3. Create and push the tag `v4.2.1`. In GitHub Desktop: History → right-click the commit → Create Tag…, then Push origin. Don't draft the release by hand on github.com; the workflow creates it from the tag.
4. When the workflow finishes, the release appears with all four ZIPs, and every installed copy offers the update.

Don't rename the assets: the app looks for `QuietAI-<version>-<win|mac>-<x64|arm64>.zip` and verifies it against `SHA256SUMS.txt` before installing. On Windows the update replaces the files in the app's folder and restarts it; on macOS it replaces `Quiet AI.app` (which must not be running from a translocated Downloads location — move it to Applications first). If the folder isn't writable, the app opens the release page instead.