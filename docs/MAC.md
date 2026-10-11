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

Quiet AI 4.2.3 was checked on an Apple silicon Mac (macOS 15.5):

- Both packages built from source with `scripts/build.py` (0 warnings), and their signatures pass `codesign --verify --deep --strict`. The arm64 app runs natively, and the x64 app runs under Rosetta.
- The packaged app, run on real data, finds the Codex and Claude folders automatically, shows both app icons, connects to Codex, and lists a running Claude Code session from its live status.
- End-to-end suite (`tests/e2e`, real app with a fake monitor and a recording power module): 148/148 on macOS. This includes the menu-bar icon and menu, closing to the menu bar, reopening from the Dock, the armed-quit prompt, the countdown banner, cancelling, and the action firing once.
- Main-process tests: `node --test tests/desktop/*.test.cjs`, 15/15.
- An earlier native session on the same Mac also covered a live Codex chat and a Claude Code session going 0 → 1 → 0, and a timer plan running to completion with the power action recorded instead of performed.

Not yet verified: a real sleep/shut down/restart triggered by Quiet AI, notification delivery from the signed app (macOS asks for permission on first use), multiple displays, an Intel Mac itself, and **Update now** installing a new version on a Mac.
