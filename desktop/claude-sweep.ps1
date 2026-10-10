# Quiet AI: final check of the Claude app before a power action (Windows).
# Run only while a plan is armed and nobody has used the computer for a while. It shows Claude's
# sidebar if hidden, switches through each mode (e.g. "Chat and Cowork", "Code"), reads the same
# markers as uia-watch.ps1 in each, then puts the window back as it was (mode and sidebar).
# Prints one JSON line: {"windows":1,"modes":["Chat and Cowork","Code"],"busy":["Code: Running My chat"],"error":""}
# Only labels are read; chat content is never read or sent anywhere.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$interesting = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Button)),
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::StatusBar)),
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::RadioButton)))
$result = [ordered]@{ windows = 0; modes = @(); busy = @(); error = '' }

function Find-Named($window, [string]$type, [string]$pattern) {
  foreach ($e in $window.FindAll($scope::Descendants, $interesting)) {
    try { if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.$type" -and ([string]$e.Current.Name) -match $pattern) { return $e } } catch {}
  }
  return $null
}
function Expand-Sidebar($window, [bool]$show) {
  $b = Find-Named $window 'Button' $(if ($show) { '^\s*Show sidebar\s*$' } else { '^\s*Hide sidebar\s*$' })
  if (-not $b) { return $false }
  try { $p = $b.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($show) { $p.Expand() } else { $p.Collapse() }; return $true }
  catch { try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }
}
function Modes($window) {
  $list = @()
  foreach ($e in $window.FindAll($scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::RadioButton)))) {
    try {
      $name = ([string]$e.Current.Name) -replace ',\s*working\s*$', ''
      if (-not $name -or ($list | Where-Object { $_.Name -eq $name })) { continue }
      $selected = $false; try { $selected = $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch {}
      $list += [pscustomobject]@{ Name = $name; Element = $e; Selected = $selected }
    } catch {}
  }
  return $list
}
function Select-Mode($window, [string]$name) {
  foreach ($m in (Modes $window)) {
    if ($m.Name -ne $name) { continue }
    try { $m.Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return $true }
    catch { try { $m.Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }
  }
  return $false
}
function Read-Busy($window, [string]$mode) {
  $found = @(); $titles = @(); $statusRunning = 0
  foreach ($e in $window.FindAll($scope::Descendants, $interesting)) {
    try {
      $name = [string]$e.Current.Name
      if (-not $name) { continue }
      $type = $e.Current.ControlType
      if ($type -eq $CT::StatusBar) { if ($name -match '^\s*(running|working)\s*$') { $statusRunning++ }; continue }
      if ($type -eq $CT::RadioButton) { if ($name -match '^\s*(.{1,40}?),\s*working\s*$') { $found += "$($Matches[1].Trim()) working" }; continue }
      if (-not $e.Current.IsEnabled) { continue }
      if ($name -match '^\s*(stop|interrupt)\b' -and $name -notmatch '(?i)dictat|record|listen|speak|read aloud') { $found += "${mode}: $name" }
      elseif ($name -match '^\s*Running\s+(.+)$' -and $Matches[1].Trim() -notmatch '(?i)\brunning$') { $titles += "${mode}: Running $($Matches[1].Trim())" }
    } catch {}
  }
  if ($statusRunning -gt 0) { $found += $titles }
  return $found
}

try {
  $ids = @((Get-Process -Name claude -ErrorAction SilentlyContinue).Id)
  foreach ($w in $A::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($ids -notcontains $w.Current.ProcessId) { continue }
    $result.windows++
    $busy = @()
    $busy += Read-Busy $w 'On screen'
    $hidden = [bool](Find-Named $w 'Button' '^\s*Show sidebar\s*$')
    if ($hidden) { [void](Expand-Sidebar $w $true); Start-Sleep -Milliseconds 900 }
    $modes = @(Modes $w)
    $original = ($modes | Where-Object Selected | Select-Object -First 1).Name
    foreach ($m in $modes) {
      $result.modes += $m.Name
      if (-not (Select-Mode $w $m.Name)) { $result.error = "Could not open $($m.Name)."; continue }
      # Lists and badges can take a few seconds to appear after switching; read twice.
      Start-Sleep -Milliseconds 2500; $busy += Read-Busy $w $m.Name
      Start-Sleep -Milliseconds 2500; $busy += Read-Busy $w $m.Name
    }
    if ($original) { [void](Select-Mode $w $original) }
    if ($hidden) { Start-Sleep -Milliseconds 400; [void](Expand-Sidebar $w $false) }
    if ($modes.Count -eq 0 -and -not $result.error) { $result.error = 'Claude''s mode switcher was not found.' }
    $result.busy += $busy
  }
} catch { $result.error = $_.Exception.Message }
$result.busy = @($result.busy | Select-Object -Unique)
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
