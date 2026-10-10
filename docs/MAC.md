# Quiet AI for Mac

## Choose the package

- Apple Silicon (M-series): `QuietAI-4.1.0-mac-arm64.zip`.
- Intel: `QuietAI-4.1.0-mac-x64.zip`.
- Requires macOS 14 or later. The runtime and monitor are bundled.

Extract with Archive Utility so framework symlinks and executable permissions are retained. Move **Quiet AI.app** to Applications, then open it.

These preview bundles are built by GitHub Actions on macOS and signed ad hoc for local execution. They are not notarized or signed with an Apple Developer ID certificate. If macOS blocks the first launch, use the per-app **System Settings → Privacy & Security → Open Anyway** control after attempting to open this download. Do not disable Gatekeeper globally. Apple's explanation is [Open apps safely on your Mac](https://support.apple.com/en-us/102445).

## Sources

The GUI may not inherit variables exported in a terminal shell. Discovery checks its environment, `launchctl` values, your `.codex/sessions` and `.claude` folders, and standard application data candidates. Set an explicit folder in Settings for a custom shell-only profile. Detected providers start selected. Connect Claude once, then restart/resume its Code sessions.

Codex writer ownership is inspected read-only with the system `lsof` tool. The selected sessions directory needs a sibling `thread-writer-locks` directory from a compatible Codex installation. If file access or lock reporting is unavailable, Quiet AI shows unknown status and waits. It does not infer completion from file age or silence.

The Claude collector is a bundled executable copied to `~/Library/Application Support/Quiet AI/monitor/integration/agent`. No Python or shell JSON utility is required for hooks. Settings are backed up before hook changes. Only compatible local native Claude Code sessions emitting these hooks are visible.

## Actions

Sleep and Display sleep use macOS power commands. Display sleep leaves apps running and does not guarantee a locked screen. Shut down and Restart use System Events. macOS may ask for Automation permission, and unsaved work may delay an action. Permission rejection is displayed by the app. Enable only permissions the selected action needs.

## Current validation status

Both architecture bundles are packaged by CI. Their app/helper names, local agent runtime, framework symlinks, executable modes, and ad hoc signatures were inspected during packaging. They have **not been launched on a Mac**. A Mac check should cover opening the app, automatic discovery, a live Codex chat, Claude hook loading, start/stop, cancellation, and the relevant OS permissions. Do not call this preview a stable Mac release until those checks have been completed.
