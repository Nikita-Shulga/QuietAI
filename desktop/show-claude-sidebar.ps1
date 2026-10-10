# Quiet AI: shows the Claude app's sidebar (the same as clicking its "Show sidebar" button), so the
# window watcher can see running chats and tasks that aren't on screen. Run only while a power plan
# is armed. Touches nothing else in the window.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$button = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Show sidebar')))
$ids = @((Get-Process -Name claude -ErrorAction SilentlyContinue).Id)
$done = 0
foreach ($w in $A::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($ids -notcontains $w.Current.ProcessId) { continue }
  $b = $w.FindFirst($scope::Descendants, $button)
  if ($b -and $b.Current.IsEnabled) {
    # The toggle exposes Expand/Collapse (Claude 2.31226); fall back to Invoke for other versions.
    try { $b.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); $done++ }
    catch { try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $done++ } catch {} }
  }
}
[Console]::Out.WriteLine($done)
