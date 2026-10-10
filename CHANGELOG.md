# Changelog

## Quiet AI 4.2.0

- Added in-app updates: Settings → About → Updates checks this project's GitHub Releases (quietly at start and every 6 hours, or on a click). Update now downloads this computer's package, checks it against the release's SHA256SUMS.txt, and restarts Quiet AI into the new version. Settings are kept. Updating is refused while a plan is armed. If the app's folder isn't writable, the download page opens instead.
- Pushing a version tag now publishes a GitHub Release with the Windows and Mac ZIPs and SHA256SUMS.txt.
- Claude Code tracking has a second, independent signal: the live status Claude Code keeps for each running session (busy / waiting / idle). A session that's busy or waiting for permission keeps the plan waiting even if a hook event was missed or the session started before the hook was connected. Files from crashed sessions are ignored.
- Claude chats now show their real names (as in the Claude app) instead of “Claude chat <id>”, and a chat seen both through the hook and in the Claude app window is no longer counted twice.

## Quiet AI 4.1.0

- Redesigned the interface: a compact window with a status panel (plan badge, per-provider counts, plain-language headline, live activity strip), a running-chat list with elapsed times, and a plan panel with desktop-style menus. Settings and About moved into a Settings view.
- Added light and dark themes. Follows the system by default; Settings → Appearance pins System, Light, or Dark, and can be changed while a plan runs.
- Shows the real Codex and Claude icons, read at startup from installed Microsoft Store packages, classic installs, or macOS app bundles. Neutral tiles otherwise.
- New sunset mark and app icon; bundled Inter typeface (SIL OFL) so the UI renders the same on every computer.
- Keeps the computer from idling to sleep while a plan is armed.
- The final countdown now brings the window forward, flashes the taskbar, and shows a notification.
- Closing the window while a plan is armed asks for confirmation first.
- Importing Codex Quiet settings keeps the previous Claude on/off choice instead of re-enabling Claude (an unconnected Claude kept agent plans waiting indefinitely).
- A second instance now exits before creating a window; the version is read from package.json; Enter/Esc keyboard shortcuts.
- Fixed: the close and minimize buttons did nothing on Windows. A hidden Settings header was an invisible window-drag area over the title bar; Settings now opens below the title bar, which stays usable.
- Fixed: Connect Claude Code appeared to do nothing. The button was disabled during every background scan, errors were drawn behind Settings, and after a successful install Claude still showed “not connected” until its first event. Connect now waits for the scan, shows progress and the result on top, and an installed hook with no Claude Code session yet counts as connected with nothing running.
- Fixed: the theme switch could overflow its highlight; picking Dark/Light now applies on every platform (the theme is driven by the main process instead of the browser media query).
- Fixed: messages stayed on screen and blocked the plan menus; errors could vanish within two seconds. Messages now time out on their own and are never cleared by a background scan.
- Settings shows each discovered folder with its status (“Found automatically”, “Chosen by you”, “Not found yet”); free-text path editing was replaced by Change…/Use automatic.
- Codex/Claude chips in the status panel are now plain status indicators with a hover description (they no longer open Settings).
- Fixed: the Codex icon was invisible in the light theme (white logo on white). Store-app logos now use the light- or dark-background variant matching the theme, and an all-white logo gets a dark tile.
- Added Settings → Claude Code → Test: checks that Quiet AI’s hook is in Claude Code’s settings and runs that hook once with a test event, reporting exactly what fails.
- Added app-window watching (Windows): Quiet AI now also tracks work shown in the Claude and Codex desktop apps — Chat, Cowork and Code, local or cloud — through Windows UI Automation. It reads only activity markers measured on a real PC: Claude’s “Stop response” button and its sidebar “Running <chat>” entries (listed by name), and Codex’s “Stop” button and “Working” markers. No hook is needed for this; the Claude Code hook remains optional for terminal sessions. If the watcher stops responding while enabled, the plan waits instead of assuming nothing runs. Settings → App windows shows what it sees and can turn it off.
- Won't act while you're using the computer: with **Settings → Safety → Wait until I'm away** (on by default) the final countdown starts only after the quiet period has also passed with no mouse or keyboard input, and any input during the countdown cancels it (the plan keeps waiting until you step away). Applies to timer plans too.
- Minimizing now hides Quiet AI to the system tray (Settings → Appearance → Minimize to tray, on by default). Hovering the tray icon shows the plan status; clicking it opens the window; right-click offers Open, Stop plan and Quit. The final countdown still pops up on top.
- The final countdown now floats above all other windows (without taking the keyboard) until it ends or is cancelled.
- Fixed: Codex chats that had finished could stay in “Running” for hours. When a Codex turn is interrupted, crashes or the app restarts mid-turn, Codex writes no completion record, and the turn looked live for as long as the Codex app kept that chat loaded. Such a turn now ends when a newer turn starts in the same chat, or — for Codex desktop app chats — when its log has been idle for 2 minutes and the Codex app has shown nothing working for a minute. Terminal/IDE Codex sessions are never retired by the app-window signal.
- The final countdown now shows a banner on top of everything on every screen (it doesn't take the keyboard), with a sound, the time left, and Cancel. Previously only the main window came forward, which was easy to miss on a multi-monitor setup or while it sat in the tray.
- “Away” now has its own time (Settings → Safety → Away means, default 10 minutes) instead of reusing the quiet period, which could be as short as 1 minute — long enough to be “away” while reading or watching something.
- Fixed: a plan could wait all night for a Codex turn that ended hours earlier. If a turn ended without a completion record and the chat later ran other turns that did finish, the monitor kept holding the old one, and only the Codex app window could clear it. Quiet AI now reads the end of the chat's log: once a later turn is recorded, the old one is over, whatever the app window shows.
- Added an activity log (`quietai-activity.log` next to the monitor's files): plan phases, what the plan is waiting on each minute, retired Codex turns, idle time, sleep/resume/lock events and gaps when the app didn't run. No chat content.
- Fixed: a command Codex was running (shown in the Codex app as “Running <command>”) could appear in the Running list as if it were a chat, e.g. `"C:\Users\…\codex-runtimes\…`. Only the Claude app's sidebar names chats; Codex command items now just count as Codex working.
- Fixed: a Claude chat that ran again later kept the elapsed time from its first run.
- Open-source release under the MIT license (© Nikita Shulga). Settings → About links to the author's website. GitHub Actions builds every platform and publishes a GitHub Release when a version tag is pushed.
- Added end-to-end tests (`tests/e2e`) that drive the real app with a fake monitor and a recording power module; 143 checks, no power action is ever performed.

## Quiet AI 4.0.0

- Renamed the app, executable, packages, and visual identity to Quiet AI.
- Replaced the Windows-only UI with a shared desktop dashboard for Windows and macOS.
- Added provider cards, a compact named chat list, a separate power-plan panel, and persistent action controls.
- Added discovery of environment/profile folders, standard app-data candidates, and installed desktop apps. Detected providers are selected by default.
- Added explicit Claude connection status and a one-click lifecycle hook setup retaining other hooks and backing up settings.
- Added Apple Silicon and Intel Mac app bundles with native power actions, read-only writer inspection, and a compiled Claude collector.
- Preserved the running-chat counting model, background-work blocking, idle confirmation, final-scan rule, timers, and migration from Codex Quiet.
- Added portable build tooling and architecture workflows. Mac and Windows ARM64 execution remain unverified in this Windows workspace.

## Codex Quiet 3.1.0

- Counted current user chats once, displayed names, filtered historical logs through live writer ownership, and separated task agents from internal maintenance.

## Codex Quiet 3.0.0

- Added automatic profile discovery, Claude hooks, provider switches, combined completion, and open-source release packaging.
