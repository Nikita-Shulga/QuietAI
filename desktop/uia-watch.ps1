# Quiet AI window watcher (Windows). Read-only.
# Every few seconds it reads activity markers from the Claude and Codex app windows through
# Windows UI Automation (the accessibility API used by screen readers). Markers seen on a
# real PC (October 2026):
#   Claude app : button "Stop response" while replying; sidebar buttons "Running <chat title>"
#                for every running chat/task, together with status elements named "Running".
#   Codex app  : button "Stop" while working; status elements named "Working" per busy task;
#                "Running <command>" items for tool calls (counted as working, never as chat titles).
# Prints one JSON line per pass:
#   {"claude":{"windows":1,"stops":["Stop response"],"running":["Fight AI program review"],"working":1},"codex":{...},"ms":120}
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
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::StatusBar)))
$interval = 3000
function Clip([string]$s) { if ($s.Length -gt 80) { $s.Substring(0, 80) } else { $s } }
while ($true) {
  $started = [Environment]::TickCount
  $result = [ordered]@{
    claude = [ordered]@{ windows = 0; stops = @(); running = @(); working = 0 }
    codex  = [ordered]@{ windows = 0; stops = @(); running = @(); working = 0 }
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
            if (-not $e.Current.IsEnabled) { continue }
            if ($name -match '^\s*(stop|interrupt)\b') { $r.stops += (Clip $name) }
            elseif ($name -match '^\s*Running\s+(.+)$') {
              # Claude: sidebar entry "Running <chat title>". Codex: "Running <shell command>" for a
              # tool call inside a task -- that's work in progress, not a chat, so it only counts as busy.
              if ($key -eq 'claude') { $titles += (Clip $Matches[1].Trim()) } else { $r.working++ }
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
