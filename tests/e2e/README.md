# End-to-end tests

Runs the real desktop app (real `main.js`, `preload.js`, `renderer.js`) in Electron with two test doubles:

- `stubs/fake-agent.js` replaces the .NET monitor. It speaks the same JSON-lines protocol and returns scripted snapshots.
- `stubs/power.js` replaces `power.js`. It records the requested action. **No sleep, shutdown or restart is ever performed.**

A temporary home folder with `.codex/sessions` and `.claude` is created, so automatic discovery is tested too. The app is copied to a temporary folder; the repository is not modified.

Manual-review checks use real main/renderer/IPC with native menu and warning selections instrumented: Cancel default, explicit confirmation, visible Restore, keyboard menu, unchanged rescans, and new-activity rediscovery. The actual OS warning/menu appearance still requires native visual QA.

Covered: startup and discovery, window buttons (including that no drag region covers them), Settings, themes (System/Light/Dark, persistence, layout), language (English by default, switching to Russian re-renders the window and tray without a restart, no clipped text), connecting/disconnecting Claude Code while the monitor is busy, install errors, folder choice and "Use automatic", Find folders again, provider switches, status summary, every plan menu, Enter/Esc, the agent plan (waiting → confirming → countdown → action, reset on new activity, last-second cancellation, cancel), timer mode, keep-awake, the tray (Windows/Linux) or menu bar (macOS: status line, close keeps it in the menu bar, Dock reopens it), minimize, the armed-quit and close confirmations, close, and settings surviving a restart.

## Run (Linux or macOS)

Needs Node 18+, `playwright` (Node package), and an Electron 44.7.0 binary.

```sh
QUIETAI_ELECTRON=/path/to/electron node tests/e2e/run-tests.js          # macOS: .../Electron.app/Contents/MacOS/Electron
xvfb-run -a node tests/e2e/run-tests.js                                  # headless Linux; add --no-sandbox is already passed
```

Screenshots and `results.json` are written to `$QA_OUT` (default: a `quietai-e2e` folder in the temp directory). The fake monitor is a Node script with a shebang, so this harness does not run on Windows as-is; the Windows-specific parts (writer locks, Store icons, PowerShell power actions, hook installer) still need a manual check on Windows.
