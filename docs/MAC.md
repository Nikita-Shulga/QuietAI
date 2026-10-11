# Quiet AI for Mac

## Choose the package

- Apple Silicon (M-series): `QuietAI-<version>-mac-arm64.zip`.
- Intel: `QuietAI-<version>-mac-x64.zip`.
- Requires macOS 14 or later. The runtime and monitor are bundled.

Extract with Archive Utility so framework symlinks and executable permissions are retained. Move **Quiet AI.app** to Applications, then open it. Keep it in Applications: in-app updates replace the app where it is, and macOS runs apps opened straight from Downloads from a read-only location.

These preview bundles are built by GitHub Actions on macOS and signed ad hoc for local execution. They are not notarized or signed with an Apple Developer ID certificate. If macOS blocks the first launch, use the per-app **System Settings → Privacy & Security → Open Anyway** control after attempting to open this download. Do not disable Gatekeeper globally. Apple's explanation is [Open apps safely on your Mac](https://support.apple.com/en-us/102445).

## Sources

The GUI may not inherit variables exported in a terminal shell. Discovery checks its environment, `launchctl` values, your `.codex/sessions` and `.claude` folders, and standard application data candidates. Set an explicit folder in Settings for a custom shell-only profile. Detected providers start selected. Connect Claude once, then restart/resume its Code sessions.

Codex writer ownership is inspected read-only with the system `lsof` tool. The selected sessions directory needs a sibling `thread-writer-locks` directory from a compatible Codex installation. If file access or lock reporting is unavailable, Quiet AI shows unknown status and waits. It does not infer completion from file age or silence.

The Claude collector is a bundled executable copied to `~/Library/Application Support/Quiet AI/monitor/integration/agent`. No Python or shell JSON utility is required for hooks. Settings are backed up before hook changes. Only compatible local native Claude Code sessions emitting these hooks are visible.

## Actions

Sleep and Display sleep use macOS power commands. Display sleep leaves apps running and does not guarantee a locked screen. Shut down and Restart use System Events. macOS may ask for Automation permission, and unsaved work may delay an action. Permission rejection is displayed by the app. Enable only permissions the selected action needs.

## Menu bar

Quiet AI keeps an icon in the menu bar. Click it for the plan status, **Open Quiet AI**, **Stop plan** (or **Cancel countdown**) and **Quit Quiet AI**. With **Settings → Appearance → Minimize to menu bar** on (the default), closing or minimizing the window keeps Quiet AI running there; click its Dock icon or choose Open Quiet AI to bring the window back. Quitting while a plan is armed always asks first.

## Current validation status

Tested on an Apple silicon Mac (macOS 15.5) with the arm64 build:

- Opening the app, automatic discovery, provider icons, light/dark themes.
- A live Codex chat and a live Claude Code session each going 0 → 1 → 0.
- Start/Stop, Esc, minimize and close to the menu bar, reopening, the armed-quit prompt.
- A timer plan running through the countdown banner, Cancel, and completion, with the power action replaced by a recorder. Real sleep/shut down/restart was not triggered.
- Main-process tests: `node --test tests/desktop/*.test.cjs`.

Not yet verified on real hardware: the Intel (x64) build, the menu-bar popup clicked by hand, notification permission denial, multiple displays, and **Update now** installing a new version on a Mac.
