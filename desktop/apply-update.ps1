# Quiet AI update hand-over (Windows). Started by updater.js from a temporary folder.
# Waits for Quiet AI to quit, copies the new version over the app folder, then reopens it.
# Only the app's own files are touched: resources\app is replaced, everything else is overwritten
# in place, and nothing else in the folder is deleted (the folder may be e.g. Downloads).
param([int]$ProcessId,[string]$Source,[string]$Target,[string]$Log)
$ErrorActionPreference='Stop'
function Note($text){try{Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('s')+' '+$text) -Encoding UTF8}catch{}}
Note "Update: waiting for Quiet AI ($ProcessId) to quit."
try{Wait-Process -Id $ProcessId -Timeout 60 -ErrorAction Stop}catch{}
# The monitor and window watcher are children of the app; give them a moment to exit too.
$deadline=(Get-Date).AddSeconds(30)
while((Get-Date) -lt $deadline){
  $busy=Get-Process -ErrorAction SilentlyContinue | Where-Object { try{$_.Path -and $_.Path.StartsWith($Target,[StringComparison]::OrdinalIgnoreCase)}catch{$false} }
  if(-not $busy){break}
  Start-Sleep -Milliseconds 500
}
$app=Join-Path $Target 'resources\app'
$backup=Join-Path (Split-Path $Source) 'previous-app'
try{
  if(-not (Test-Path -LiteralPath (Join-Path $Target 'QuietAI.exe'))){throw "QuietAI.exe is not in $Target"}
  if(Test-Path -LiteralPath $app){Move-Item -LiteralPath $app -Destination $backup}
  & robocopy.exe $Source $Target /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if($LASTEXITCODE -ge 8){throw "robocopy failed with code $LASTEXITCODE"}
  Note 'Update: files replaced.'
}catch{
  Note ('Update failed: '+$_.Exception.Message)
  if((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath (Join-Path $app 'package.json'))){
    if(Test-Path -LiteralPath $app){Remove-Item -LiteralPath $app -Recurse -Force}
    Move-Item -LiteralPath $backup -Destination $app
    Note 'Update: previous version restored.'
  }
}
Start-Process -FilePath (Join-Path $Target 'QuietAI.exe') -WorkingDirectory $Target
Start-Sleep -Seconds 5
try{Remove-Item -LiteralPath (Split-Path $Source) -Recurse -Force}catch{}
