# Contributing to Quiet AI

The desktop UI is in `desktop`, the streaming monitor in `src/QuietAI.Core`, and its local stdio/collector entrypoint in `src/QuietAI.Agent`. Windows hooks are in `hooks`. `scripts/build.py` packages the app; `scripts/icons.py` renders the sunset mark and app icons without dependencies. See [docs/UI.md](docs/UI.md) for how the interface is put together (themes, provider icons, renderer/main commands).

Use .NET 10 and Python 3 for builds. The UI has no npm dependencies. The renderer is sandboxed with context isolation and no Node access. Keep operating-system actions in the trusted main process, and monitor I/O in the agent. Never pass arbitrary renderer strings into shell commands.

Detection changes must preserve identity pairing, concurrent/background work, unknown-state blocking, and the recent-clear-scan requirement at the final countdown. File age and silence do not establish completion. Do not edit or lock Codex's writer files. Keep provider assumptions current in About and docs/DETECTION.md.

Do not repoint controlled examples at real Claude settings, transcripts, or power actions. Screenshots in public source must use illustrative data. Distinguish compilation, archive inspection, actual platform launches, visual review, and provider compatibility. Obtain a matching-platform launch before claiming it works there.

Run the end-to-end UI tests in `tests/e2e` before opening a pull request that touches `desktop/` (see its README). They use a fake monitor and a recording power module, so no real power action ever runs. Add a check for every behaviour you change. Windows-only parts (writer locks, Store icons, the window watcher, PowerShell power actions, the hook installer) still need a manual check on Windows.

Use redacted status summaries for issues; private transcripts, cache paths, credentials, and personal settings should not be attached. Publishing and signing with a repository owner's credentials are separate from producing local reviewable builds.
