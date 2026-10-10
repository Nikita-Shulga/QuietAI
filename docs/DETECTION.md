# Detection specification

This document describes Quiet AI 4.0.0 for Windows and macOS. Detection uses live local Codex writers and recorded lifecycle signals from the selected sources. It is not a promise to discover every running agent on a machine.

## Combined completion rule

For each **enabled** provider:

1. Its configured source must be available and connected.
2. No recorded work may remain running, scheduled, or uncertain.
3. Both enabled providers must satisfy those conditions together.

At least one provider must be enabled. The app then waits for the selected idle confirmation duration and starts the final countdown. It continues scanning while counting down. A change in observed work resets confirmation and cancels the countdown, including a turn that starts and completes between polls. At the deadline, a scan must have completed within three seconds, no scan may be in progress, and the combined state must still be clear. The app requests the Windows action only then.

The desktop polls approximately every two seconds while armed or disarmed, with an additional fresh scan at the action deadline. Previewing never starts a power plan. First reads can take longer with large live chats. Disabling a provider removes it from the plan; timer mode intentionally does not depend on providers. There is inevitably a boundary between the last scan and the system action: future work or an event that has not reached the local source cannot be predicted.

## Someone at the computer

With **Wait until I'm away** on (the default), the final countdown also requires the operating system's idle time (time since the last mouse, keyboard or touch input; `powerMonitor.getSystemIdleTime`, i.e. `GetLastInputInfo` on Windows) to be at least **Away means** (`awayMinutes`, default 10). Input during the countdown cancels it and the plan returns to waiting for the user to step away; the same rule holds when a timer runs out. Game controllers and remote-control tools that don't generate OS input are not seen. The countdown window is shown always-on-top without taking keyboard focus.

## Displayed counts

The main number groups running user prompt/turn records by provider and session, producing one row per running chat. Background agents/tasks, scheduled wakeups, and unknown status are separate. They still block the combined completion rule. Unknown status is shown separately as an “unverified” count and a banner in the main window; the visible number is then only the known running chats.

## Codex

The app first inspects `*.lock` in the `thread-writer-locks` directory beside the selected `sessions` directory. On Windows, read-only opens/reads detect sharing or lock violations. On Mac, the system `lsof` tool reports open-file/lock ownership; a writer file with unavailable lock status stays uncertain. The monitor does not acquire, release, create, or delete Codex locks. Codex holds its exclusive writer lock while it owns the session. This identifies loaded sessions, not prompt activity. See [Codex's writer-lock implementation](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/writer_lock.rs).

The reader enumerates `*.jsonl` filenames under the selected sessions folder, then reads only files whose session ID has a held writer lock. Historical logs without live writers are outside the current running set. There is no age cutoff. A newly held lock whose file cannot yet be read creates unknown status. Missing/unreadable lock support blocks the plan. A recent local Windows Codex installation providing these locks is required.

The session metadata identifies task subagents, whose work remains monitored separately. Internal guardian approval reviews and memory consolidation are excluded from user work. Labels come from a read-only query of the local Codex `state_5.sqlite` database (`CODEX_SQLITE_HOME`, otherwise the selected Codex home). Label lookup failure falls back to a short session ID and never changes completion.

For live task sessions, the reader consumes root records whose `type` is `event_msg` and reads their `payload` metadata:

| `payload.type` | Change |
| --- | --- |
| `task_started` | Add the specific `turn_id` to that session's active set |
| `task_complete` | Remove only the matching `turn_id` |
| `task_aborted`, `turn_aborted`, `task_cancelled`, `turn_cancelled` | Remove only the matching `turn_id` |

Each session path and turn ID form an independent key. A terminal event without an ID cannot clear arbitrary work. Starting two turns and completing one leaves the other running. A long-running turn never expires because it is old or its log is quiet. The monitor observes recorded starts; it does not count future submissions before Codex records them.

Initial reads stream each live session in 64 KiB chunks. Only the first 16 KiB of each record are retained while identifying metadata; bulky response text is not stored. Supported lifecycle metadata must be in that prefix. Live files containing model work without a supported lifecycle schema are uncertain rather than clear.

Subsequent scans reuse complete-line byte offsets, file length/write metadata, and a small anchor before the offset. Outstanding IDs are cached between app sessions. Incomplete trailing records, unreadable live files, detected replacements/truncation, and missing logs still owned by live writers keep the plan waiting. A replacement does not silently discard previous outstanding IDs. When Codex releases a writer, its historical log no longer contributes to current activity. The v2 cache can import old v1 cursor metadata, while applying this live-session filter.

Codex session JSONL and writer locks are integration formats which may evolve; this project does not claim an official stable Codex completion API. Unsupported versions require an updated reader. Threads belonging to another Codex home, account, host, WSL instance, or remote backend are outside this local monitor.

### Turns that end without a completion record

Codex writes no `task_complete` or abort record when a turn is interrupted, crashes or the app restarts mid-turn; the chat's writer lock stays held while the Codex app keeps it loaded. Such a turn is retired when:

- **a newer turn starts in the same chat** — a Codex chat runs one turn at a time (monitor and app both apply this; the app also reads the last start/completion record from the end of the chat's log, so a turn the monitor still holds is cleared once any later turn is recorded); or
- **it belongs to the Codex desktop app** (`originator: "Codex Desktop"` in `session_meta`), its log has not changed for 2 minutes, and the app-window watcher has seen no Stop button or “Working” marker in the Codex app for 1 minute.

Terminal and IDE sessions are not retired by the window signal, because their work is not shown in the app window. Retired turns are passed to the monitor as excluded work, so counts and rows stay consistent; they are kept in memory only.

## Claude Code

The installer registers synchronous command hooks in the configured Claude user `settings.json`. Windows uses the bundled PowerShell collector; macOS uses the compiled agent's hook mode. Both receive JSON on stdin and write sanitized events to the app's `claude-events` folder. The collector is copied to stable per-user storage and can run while the GUI is closed. A manual Connect action installs it and saves settings backups. Discovery alone does not modify Claude settings or prove hook coverage. Claude's authoritative event descriptions are in the [official hooks reference](https://code.claude.com/docs/en/hooks).

| Hook | Monitor behavior |
| --- | --- |
| `SessionStart` | Establish connection. A resumed session without previous lifecycle history remains uncertain until activity/Stop verifies it. |
| `UserPromptSubmit` | Add a prompt identified by session and `prompt_id`. |
| `PreToolUse`, `PostToolUse` | Mark the identified prompt/subagent active, including work continuing after an earlier Stop. |
| `SubagentStart` | Add the specific `agent_id` separately from its parent. |
| `Stop` | Remove the matching prompt/agent. For a root prompt, inspect background and scheduled registries. |
| `SubagentStop` | Remove only the matching subagent. |
| `StopFailure` | Mark the failure uncertain for review. |
| `SessionEnd` | Close main prompt/scheduled-session work. Retain known subagents and background work. |

At a root `Stop`, `background_tasks` and `session_crons` must both be arrays. Nonterminal background tasks remain active; registered future wakeups remain scheduled. An empty pair of arrays verifies that the reported registries are clear. Missing registries, missing required IDs, invalid bridge records, disabled hooks, and collector failure markers prevent automatic completion. Root prompts are grouped into the running-chat count; child agents and background tasks contribute to the separate background count.

### Live session status (second signal)

Claude Code keeps one small file per running session in `<Claude home>/sessions/<pid>.json` with the session ID, its name and a status Claude Code updates as it works: `busy`, `waiting` (a permission prompt or a question for the user, with `waitingFor`), `idle` or `shell`. The monitor reads these every scan:

- A session whose status is `busy` or `waiting` counts as a running chat, even if no hook event says so — this covers missed events and sessions started before the hook was connected. `waiting` keeps the plan waiting, because the work can't finish until someone answers.
- A file counts only while its process is alive; on Windows the process creation time must also match the file's `procStart`, so a reused process ID is ignored. Files left behind by a crash never hold a plan.
- The hook stays the primary signal (it also sees subagents, background tasks and scheduled wakeups). The live status only adds work; it never clears work the hook still reports.
- Chat names come from the same files (and `projects/<project>/<session>/custom-title.json`), so a chat tracked by the hook and shown in the Claude app window is listed once, under its real title.

### Coverage and limitations

- Install hooks **before** using the monitored sessions. Restart/resume all sessions after setup. A session that started earlier is still seen through its live status (above), but its subagents and background tasks are only visible once it emits hook events.
- Recent Claude hook payloads are required. Older payloads without prompt IDs or background registries remain uncertain; there is no fallback that treats silence as done.
- User interruption may not emit `Stop`. A missing terminal event leaves work outstanding until session closure or explicit review.
- Other Stop hooks can block completion and make Claude continue. Subsequent observed tool/prompt events reactivate the work and reset idle confirmation. Unobserved continuation cannot be guaranteed detectable.
- Project, local, plugin, and managed settings may alter hook behavior. The monitor verifies its installed user command hooks and checks known sessions' project/local `disableAllHooks` flags; it cannot prove coverage of unknown projects, every policy override, or work outside the configured root. See the [official settings reference](https://code.claude.com/docs/en/settings).
- Background task and cron lists are snapshots at Stop, not continuous operating-system task discovery. A task which finishes without a later observable registry update can conservatively keep the plan waiting.
- Native local Claude Code on Windows/macOS is the integration target. Regular Claude Chat, remote Code sessions, WSL, remote hosts, containers, and another account/device are outside this collector (on Windows, the app-window watcher below covers work shown in the Claude and Codex desktop apps). macOS runtime coverage remains unverified until a Mac launch check.

## Desktop app windows (Windows)

`desktop/uia-watch.ps1` reads the open Claude and Codex (ChatGPT) desktop app windows through Windows UI Automation every ~3 seconds. It reports only these markers, measured on real apps in October 2026:

- **Claude app:** an enabled button whose name starts with “Stop” (for example “Stop response”) while a reply streams; sidebar buttons named “Running ‹chat title›”, counted only while a status element named “Running” is also present; and the mode switcher's radio buttons, which read “‹mode›, working” (for example “Chat and Cowork, working” or “Code, working”) while a mode that isn't on screen has running work. This last marker is what makes cloud Cowork tasks and chats visible whichever tab is open (verified October 2026). A busy Code tab adds no row when Claude Code sessions are already tracked through the hook or live status. Hiding Claude's sidebar removes both the running list and the mode switcher, so a task that isn't on screen becomes invisible (measured: a cloud Cowork task ran for six minutes with no marker at all). The watcher reports this through the “Show sidebar” button; Claude then counts as unverified (the plan waits), and while a plan is armed Quiet AI expands the sidebar itself (UI Automation Expand on that button, at most every 30 seconds) so every task is visible again. A minimized Claude window still exposes all markers.

**Claude sweep (final check).** With “Check every Claude tab first” on (default), an agent plan doesn't start its countdown until `desktop/claude-sweep.ps1` has run: once there has been no mouse or keyboard input for 60 seconds (and after “Wait until I'm away”, if on), it expands Claude's sidebar if hidden, selects each mode in the switcher, reads the sidebar list, Stop buttons and badges twice per mode (lists can take a few seconds to render), then restores the original mode and sidebar state. Measured on a real PC: about 11 seconds for two modes; selecting a mode through UI Automation doesn't register as user input. While it runs, the app keeps using the window state from before the sweep, so the tab switching isn't mistaken for new work. Results: anything running → back to waiting; input during the sweep → discarded and retried after another idle minute; a failed sweep with Claude open → retried in a minute (never treated as clear). With the sweep on, a hidden sidebar doesn't hold the plan by itself (the sweep looks behind it); with it off, the older behaviour applies. Cloud work also leaves no local files while it runs (verified), so the window is the only local signal for it; with the Claude app closed, cloud tasks can't reach this computer and are unaffected by a shutdown.
- **Codex app:** an enabled “Stop” button; status elements named “Working”, one per busy task; “Running <command>” items for tool calls in progress (counted as working, never listed as chats).

Any such marker counts as running work. That covers Chat, Cowork and Code, local or cloud, as long as it shows in the app window. Claude chats are listed by title; Codex shows “Codex app · N tasks working”. When the only problem with a provider is missing setup (no hook, no sessions folder), a visible window counts as connected through the window. If the watcher is enabled but has not reported for more than 12 seconds (monotonic clock), an Uncertain item keeps the plan waiting. Window changes restart the idle confirmation.

Limits: Windows only; the app window must exist (an app closed to the system tray is not seen); Chromium apps expose their content to UI Automation only after the first request, so the first pass after an app starts can be empty; labels may change with app updates (the watcher then sees nothing, and the hook and session signals still apply). Turn it off in **Settings → App windows**.

## Manual review

Sources lists blocking work with provider, status, and reason. This desktop version does not offer a new manual-completion control. Existing migrated exclusions remain scoped to their identified keys; new IDs and ambiguous records remain monitored. Fix unavailable sources and unknown status before relying on an agent plan.

An exclusion changes the completion decision deliberately. It does not create evidence that a session finished. Do not use it to hide current work.

## Data retained

The Codex reader retains offsets, IDs, statuses, timestamps, and local paths, not prompt/response content. The Claude collector retains schema version, event, session/prompt/agent IDs, source, working directory, timestamp, background ID/type/status, and scheduled IDs. It drops prompt text, responses, tool inputs, commands, and task descriptions. The live-status reader keeps nothing; it reads session IDs, names, statuses and process IDs on each scan. Detection uses no network service or account credential (the only network use in the app is the update check, see RELEASING.md).
