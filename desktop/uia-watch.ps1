# Quiet AI window watcher (Windows). Read-only.
# Every few seconds it reads activity markers from the Claude and Codex app windows through
# Windows UI Automation (the accessibility API used by screen readers). Markers seen on a
# real PC (October 2026):
#   Claude app : button "Stop response" while replying; sidebar buttons "Running <chat title>"
#                for every running chat/task, together with status elements named "Running";
#                the mode switcher's radio buttons read "<mode>, working" (e.g. "Chat and Cowork,
#                working") for a mode that has running work but isn't the one on screen, so cloud
#                Cowork tasks and chats are seen whichever tab is open. Hiding the sidebar removes
#                both the list and the switcher; a "Show sidebar" button then reports sidebarHidden.
#                Minimized windows still expose all of this.
#   Codex app  : button "Stop" while working; status elements named "Working" per busy task;
#                "Running <command>" items for tool calls (counted as working, never as chat titles).
# Prints one JSON line per pass:
#   {"claude":{"windows":1,"stops":["Stop response"],"running":["Fight AI program review"],"working":1,"tabs":["Chat and Cowork"]},"codex":{...},"ms":120}
# Only these labels are reported; chat content is never read or sent anywhere.
# Note: Chromium-based apps expose their content to UI Automation after the first request, so the
# very first pass after an app starts can come back empty; later passes see everything.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$interesting = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Button)),
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::StatusBar)),
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::RadioButton)))
$interval = 3000
function Clip([string]$s) { if ($s.Length -gt 80) { $s.Substring(0, 80) } else { $s } }
while ($true) {
  $started = [Environment]::TickCount
  $result = [ordered]@{
    claude = [ordered]@{ windows = 0; stops = @(); running = @(); working = 0; tabs = @(); sidebarHidden = $false }
    codex  = [ordered]@{ windows = 0; stops = @(); running = @(); working = 0; tabs = @() }
    ms = 0 }
  $owner = @{}
  foreach ($p in (Get-Process -Name claude, codex, chatgpt -ErrorAction SilentlyContinue)) {
    $owner[[int]$p.Id] = $(if ($p.ProcessName -match '(?i)claude') { 'claude' } else { 'codex' })
  }
  if ($owner.Count -gt 0) {
    foreach ($w in $A::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try { $key = $owner[[int]$w.Current.ProcessId] } catch { continue }
      if (-not $key) { continue }
      $r = $result[$key]; $r.windows++
      $titles = @()
      try {
        foreach ($e in $w.FindAll($scope::Descendants, $interesting)) {
          try {
            $name = [string]$e.Current.Name
            if (-not $name) { continue }
            $type = $e.Current.ControlType
            if ($type -eq $CT::StatusBar) {
              if ($name -match '^\s*(running|working)\s*$') { $r.working++ }
              continue
            }
            if ($type -eq $CT::RadioButton) {
              # Mode switcher: "<mode>, working" while that (off-screen) mode has running work.
              if ($name -match '^\s*(.{1,40}?),\s*working\s*$' -and $r.tabs -notcontains $Matches[1].Trim()) { $r.tabs += $Matches[1].Trim() }
              continue
            }
            # With Claude's sidebar hidden, its running list and mode badges are gone too, so work
            # that isn't on screen can't be seen. Reported so the app can treat Claude as unverified.
            if ($key -eq 'claude' -and $name -match '^\s*Show sidebar\s*$') { $r.sidebarHidden = $true; continue }
            if (-not $e.Current.IsEnabled) { continue }
            if ($name -match '^\s*(stop|interrupt)\b' -and $name -notmatch '(?i)dictat|record|listen|speak|read aloud') { $r.stops += (Clip $name) }
            elseif ($name -match '^\s*Running\s+(.+)$') {
              # Claude: sidebar entry "Running <chat title>". Codex: "Running <shell command>" for a
              # tool call inside a task -- that's work in progress, not a chat, so it only counts as busy.
              # Claude's in-chat tool progress reads e.g. "Running a command running" -- not a chat title.
              $title = $Matches[1].Trim()
              if ($key -eq 'claude') { if ($title -notmatch '(?i)\brunning$') { $titles += (Clip $title) } else { $r.working++ } } else { $r.working++ }
            }
          } catch {}
        }
      } catch {}
      # "Running <title>" counts only alongside a "Running" status marker, so a chat that is
      # merely titled "Running ..." does not look busy.
      if ($r.working -gt 0) { $r.running += $titles }
    }
  }
  $result.ms = [Environment]::TickCount - $started
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $interval
}
