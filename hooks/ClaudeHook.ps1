param([Parameter(Mandatory=$true)][string]$StateDirectory)

# MIT licensed. Windows PowerShell 5.1; no Python, Node, or .NET SDK needed.
# Do not echo input: prompt/tool contents are intentionally discarded.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $eventInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $allowedEvents = @('SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStart','SubagentStop','SessionEnd','StopFailure')
    if ($eventInput.hook_event_name -notin $allowedEvents -or [string]::IsNullOrWhiteSpace($eventInput.session_id)) { throw 'Invalid lifecycle input.' }
    $safeSession = [string]$eventInput.session_id
    if ($safeSession -notmatch '^[a-zA-Z0-9_-]{1,160}$') { throw 'Invalid session ID.' }
    $record = [ordered]@{
        schema = 1
        event = [string]$eventInput.hook_event_name
        session_id = $safeSession
        prompt_id = [string]$eventInput.prompt_id
        agent_id = [string]$eventInput.agent_id
        source = [string]$eventInput.source
        cwd = [string]$eventInput.cwd
        timestamp_utc = [DateTime]::UtcNow.ToString('o')
    }
    if (($eventInput.PSObject.Properties.Name -contains 'background_tasks') -and ($eventInput.background_tasks -is [System.Array])) {
        $record.background_tasks = @($eventInput.background_tasks | ForEach-Object { @{ id = [string]$_.id; type = [string]$_.type; status = [string]$_.status } })
    }
    if (($eventInput.PSObject.Properties.Name -contains 'session_crons') -and ($eventInput.session_crons -is [System.Array])) {
        $record.session_crons = @($eventInput.session_crons | ForEach-Object { @{ id = [string]$_.id } })
    }
    $null = [IO.Directory]::CreateDirectory($StateDirectory)
    $logPath = Join-Path $StateDirectory ($safeSession + '.jsonl')
    $mutex = [Threading.Mutex]::new($false, ('Local\CodexQuietClaude-' + $safeSession))
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(3000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Lifecycle event lock timed out.' }
        $jsonLine = ($record | ConvertTo-Json -Depth 6 -Compress) + "`n"
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($jsonLine)
        $stream = [IO.FileStream]::new($logPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    exit 0
} catch {
    try {
        $null = [IO.Directory]::CreateDirectory($StateDirectory)
        [IO.File]::WriteAllText((Join-Path $StateDirectory 'collector-error.txt'), 'Claude event collection failed. Reinstall hooks or review the integration.')
    } catch { }
    [Console]::Error.WriteLine('Quiet AI could not record this lifecycle event. Check Settings in the app.')
    exit 1
}
