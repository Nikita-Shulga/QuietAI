# Contributing to Quiet AI

Thanks for wanting to help! Bug reports, ideas, docs fixes and code are all welcome.

## Ways to help

- **Report a bug.** Use the [bug report form](https://github.com/Nikita-Shulga/QuietAI/issues/new?template=bug_report.yml) and paste the status summary (Settings → About → Copy status summary).
- **Test on your setup.** Mac launches, Windows on ARM and unusual Claude Code or Codex setups are especially valuable. Tell us what worked and what didn't.
- **Improve the docs.** If something in the README or [docs/DETECTION.md](docs/DETECTION.md) confused you, a pull request that fixes it is a great first contribution.
- **Write code.** For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Getting set up

You need Python 3 and the .NET 10 SDK. There are no npm dependencies.

```sh
git clone https://github.com/Nikita-Shulga/QuietAI.git
cd QuietAI
python scripts/build.py win-x64          # a full, runnable package in .artifacts/releases/
electron desktop --preview               # UI only, with sample data (needs an Electron 44 binary)
```

## Where things live

The desktop UI is in `desktop`, the streaming monitor in `src/QuietAI.Core`, and its local stdio/collector entrypoint in `src/QuietAI.Agent`. Windows hooks are in `hooks`. `scripts/build.py` packages the app; `scripts/icons.py` renders the sunset mark and app icons without dependencies. See [docs/UI.md](docs/UI.md) for how the interface is put together (themes, provider icons, renderer/main commands), and [docs/DETECTION.md](docs/DETECTION.md) for how running work is detected.

## Ground rules

**Safety first.** Quiet AI can shut someone's computer down while their work is running. Detection changes must preserve identity pairing, concurrent/background work, unknown-state blocking, and the recent-clear-scan requirement at the final countdown. File age and silence do not establish completion. When in doubt, wait. Do not edit or lock Codex's writer files. Keep provider assumptions current in About and docs/DETECTION.md.

**Security.** The renderer is sandboxed with context isolation and no Node access. Keep operating-system actions in the trusted main process, and monitor I/O in the agent. Never pass arbitrary renderer strings into shell commands.

**Privacy.** Do not repoint controlled examples at real Claude settings, transcripts, or power actions. Screenshots in public source must use illustrative data: `--preview` mode shows sample chats, and `QUIETAI_CAPTURE_DELAY` with `--capture <file>` saves the window to a PNG. Use redacted status summaries in issues; private transcripts, cache paths, credentials, and personal settings should not be attached.

**Testing.** Run the end-to-end UI tests in `tests/e2e` before opening a pull request that touches `desktop/` (see its README). They use a fake monitor and a recording power module, so no real power action ever runs. Add a check for every behaviour you change. Windows-only parts (writer locks, Store icons, the window watcher, PowerShell power actions, the hook installer) still need a manual check on Windows.

**Honest claims.** Distinguish compilation, archive inspection, actual platform launches, visual review, and provider compatibility. Obtain a matching-platform launch before claiming something works there.

## Pull requests

- Keep each PR focused on one change, and describe how you checked it. The PR template has a short checklist.
- Update `CHANGELOG.md` for anything users will notice.
- Be patient: this project is maintained in spare time.

By contributing you agree that your work is released under the [MIT License](LICENSE), and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md). Publishing and signing with the repository owner's credentials are separate from producing local reviewable builds.
