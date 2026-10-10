# Quiet AI interface (4.1)

The desktop UI lives in `desktop/` and has no npm dependencies.

| File | Role |
| --- | --- |
| `index.html` | Markup for the main window and the Settings view. Strict CSP: scripts, styles and fonts from the app only; images from the app or `data:` URLs. |
| `style.css` | All visual design. Every colour is a CSS custom property on `:root`; the dark set is the default and `@media (prefers-color-scheme: light)` overrides it. Add new colours as tokens in **both** blocks. |
| `renderer.js` | Sandboxed renderer. Renders the `quiet:state` object, draws the activity strip on a `<canvas>`, opens the custom menus, handles Enter/Esc. It never touches Node or the filesystem. |
| `main.js` | Trusted main process: settings, scanning, the power plan, theme, provider icons, OS integration. |
| `fonts/` | Inter (SIL OFL, see `LICENSE-Inter.txt`), subset to Latin, Cyrillic and Greek. |
| `icon.*` | App icons rendered by `scripts/icons.py` (sunset mark). The same mark is drawn inline as SVG in `index.html`. |

## Layout

Main window (460 × 690, minimum 420 × 640):

1. **Status panel** — badge (`data-tone` on `#hero`: `preview`, `armed`, `confirm`, `countdown`, `timer`, `executing`, `attention`, `error`), per-provider counts with icons, headline, one-line plan summary, activity strip.
2. **Running** — one row per running user chat (provider icon, title, elapsed time from `startedUtc`). A red banner appears when a watched provider is not connected or work is unverified; it opens Settings.
3. **When it’s done** — trigger, action, quiet period or timer, time to cancel. Rows lock (become plain text) while a plan is active.
4. **Call to action** — Start monitoring / Start timer (Enter), Stop (Esc), Cancel in the final countdown (Esc).

Settings view (includes **Safety → Wait until I'm away**, setting `waitForAway`): opens below the title bar (the title bar's window buttons must stay clickable; do not add `-webkit-app-region: drag` to anything that can sit over them, even invisibly). Appearance (System / Light / Dark), Codex and Claude Code sources with their discovered folders, connect/disconnect Claude hooks, what is holding the plan, About.

## Countdown banner

`countdown.html/.css/.js`: when the final countdown starts, `showOverlays()` opens one small frameless banner per display (always on top at screen-saver level, not focusable, not in the taskbar) and beeps. It shows the time left and a Cancel button; it may only call `state` and `stop`. Banners close when the countdown ends or is cancelled.

## Tray

`createTray()` adds a notification-area icon (`icon.ico` on Windows). With `settings.minimizeToTray` (default on) the minimize button and taskbar minimize hide the window to the tray; the first time, a notification says where it went. The tooltip mirrors the plan status (`trayStatus()`); click toggles the window; the context menu has Open, Stop plan / Cancel countdown and Quit (Quit closes the window, so an armed plan still asks first). The countdown shows the window again, always on top.

## Activity strip

`renderer.js` keeps a `signal` mode: `working` (rippling bars, amplitude grows with the chat count), `quiet` (flat), `progress` (green fill while confirming), `countdown` (amber, shrinking), `timer` (ink, shrinking), `loading`. Colours come from the `--sig-*` tokens so both themes work; they are re-read when the system theme changes.

## Themes

`settings.theme` is `system`, `light` or `dark` (default `system`). `main.js` applies it with `nativeTheme.themeSource` and sends the resolved result as `state.dark`; the renderer sets `<html data-mode="light|dark">`, and the light tokens live under `:root[data-mode="light"]`. (Relying on the `prefers-color-scheme` media query alone did not follow `themeSource` on every platform.) The renderer sends `command('theme', {theme})`; this command is allowed while a plan is armed, unlike other setting changes.

## Provider icons

`main.js → findProviderIcons()` runs once after the window is created and adds `state.icons = {codex, claude}` as PNG data URLs (or `null`).

- **Windows:** `Get-AppxPackage` for `Claude*`, `OpenAI.Codex*`, `OpenAI.ChatGPT*`; reads `Square44x44Logo.targetsize-64_altform-unplated.png` (then other standard logo assets) from the package’s install location. Falls back to `app.getFileIcon` on classic installs (`%LOCALAPPDATA%\AnthropicClaude\claude.exe`, `%LOCALAPPDATA%\Programs\…`).
- **macOS:** `app.getFileIcon` on `/Applications/Claude.app`, `Codex.app` or `ChatGPT.app` (also `~/Applications`).
- Otherwise the renderer shows neutral “Cx” / “Cl” tiles. Third-party icons are never bundled.

## Renderer → main commands

`state`, `update` (validated settings), `theme`, `tray` (minimize-to-tray switch; allowed while armed), `website`, `arm`, `stop`, `discover`, `browse`, `install`, `remove`, `diagnostics`, `minimize`, `close` (asks for confirmation while a plan is armed). `maximize` still exists in `main.js` but the window is not maximizable and has no button for it.

## App window watcher (Windows)

`desktop/uia-watch.ps1` runs as a child process (`main.js → startWindowWatcher()`) and prints one JSON line every ~3 s with, per app: `windows`, `stops` (enabled buttons named “Stop…”/“Interrupt…”), `running` (Claude sidebar buttons “Running <title>”, only counted alongside a “Running” status marker) and `working` (status elements named “Running”/“Working”). `applyWindows()` turns that into running work and chat rows, counts a provider as connected through its window when the only problem was missing setup (no hook / no sessions folder), and adds an Uncertain item when the watcher is enabled but silent for more than 12 s (monotonic clock). Window changes bump the snapshot revision so the idle confirmation restarts. Tests use `QUIETAI_WINDOW_WATCHER` to substitute `tests/e2e/stubs/fake-window-watcher.js`. Chromium apps expose content to UI Automation only after the first request, so the first pass after an app starts can be empty.

## Claude connection states

`main.js → normalize()` turns the monitor's “waiting for the first real Claude hook event” into *connected, nothing running* (`claude.awaitingFirstEvent`). Claude Code sessions that were open before connecting are not visible until restarted; the app says so when connecting.

## Tests

`tests/e2e/run-tests.js` drives the real app; see `tests/e2e/README.md`.

## Previewing without the monitor

`electron desktop --preview` loads illustrative sessions and never schedules a power action. `--capture <file.png>` saves a screenshot and quits; use it for public screenshots, which must contain illustrative data only.
