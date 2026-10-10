using System.Text.Json;

namespace QuietAI.Core;

public sealed class MonitorEngine
{
    private readonly Dictionary<string, LogState> _logs = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _cachePath;
    private long _revision;
    private DateTime _lastSave;
    public MonitorEngine(string stateRoot)
    {
        _cachePath = Path.Combine(stateRoot, "monitor-cache-v2.json");
        try
        {
            var loadPath = File.Exists(_cachePath) ? _cachePath : Path.Combine(stateRoot, "monitor-cache-v1.json");
            var cache = JsonSerializer.Deserialize<Cache>(File.ReadAllText(loadPath));
            if (cache?.Schema == 1)
            { foreach (var log in cache.Logs) _logs[log.Provider + ":" + log.Path] = log; _revision = cache.Revision; }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
    }

    public MonitorSnapshot Scan(MonitorOptions options, CancellationToken cancellationToken = default)
    {
        var codex = ScanCodex(options, cancellationToken);
        var claude = ScanProvider("Claude", options.ClaudeEnabled, Path.Combine(options.StateRoot, "claude-events"), options, cancellationToken);
        if (DateTime.UtcNow - _lastSave > TimeSpan.FromSeconds(30)) SaveCache();
        return new(codex, claude, _revision, DateTime.UtcNow);
    }

    private string _lastCodexVisible = "";
    private ProviderSnapshot ScanCodex(MonitorOptions options, CancellationToken token)
    {
        if (!options.CodexEnabled) return new("Codex", false, false, [], "Disabled in Connections.");
        var work = new List<WorkItem>();
        void Problem(string key, string reason) => work.Add(new("Codex:" + key, "Codex", "Connection", "Status needs attention", WorkStatus.Uncertain, reason, DateTime.UtcNow));
        if (!Directory.Exists(options.CodexSessions))
            return new("Codex", true, false, [new("Codex:connection", "Codex", "Connection", "Source unavailable", WorkStatus.Uncertain, "The sessions folder is missing. Choose the correct folder in Connections.", DateTime.UtcNow)], "Sessions folder missing.");
        var leases = CodexLiveSessions.ReadLeases(options.CodexSessions);
        foreach (var reason in leases.Problems) Problem("connection", reason);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var titles = CodexChatNames.Read(options.CodexSessions);
        var historicalFiles = 0;
        try
        {
            foreach (var path in Directory.EnumerateFiles(options.CodexSessions, "*.jsonl", SearchOption.AllDirectories))
            {
                token.ThrowIfCancellationRequested();
                var id = CodexLiveSessions.SessionId(path);
                if (!leases.Held.Contains(id)) { historicalFiles++; continue; }
                seen.Add(id);
                var cacheKey = "Codex:" + path;
                if (!_logs.TryGetValue(cacheKey, out var state)) _logs[cacheKey] = state = new() { Path = path, Provider = "Codex" };
                CodexLiveSessions.ReadHeader(state);
                // Guardian approval reviews and memory maintenance are system work,
                // not user chats or agents doing the user's requested task.
                if (state.IsInternal) continue;
                EventLog.Read(state, (log, data) =>
                {
                    var before = JsonSerializer.Serialize(log.Work);
                    EventLog.ConsumeCodex(log, data);
                    if (before != JsonSerializer.Serialize(log.Work)) _revision++;
                }, token);
                var title = titles.TryGetValue(id, out var label) ? label : "Chat " + (id.Length > 10 ? id[..10] : id);
                work.AddRange(state.Work.Values.Where(item => !options.ExcludedWork.Contains(item.Key)).Select(item => item with
                { Session = id, ChatTitle = title, IsBackground = state.IsSubagent }));
                if (state.SeenModelWork && !state.SeenLifecycle)
                {
                    var unsupported = EventLog.Issue(state, "unsupported-schema:" + state.Offset, "A live chat has no supported turn status. Its running state cannot be verified.");
                    if (!options.ExcludedWork.Contains(unsupported.Key)) work.Add(unsupported);
                }
                if (state.ReadError is not null) work.Add(EventLog.Issue(state, "read-error", state.ReadError));
                if (state.PartialLine) work.Add(EventLog.Issue(state, "partial-line", "A current chat is still writing a status record."));
            }
            // Include newly acquired writers even when their rollout file appeared
            // after this enumeration. Never declare a new/loading chat finished.
            var finalLeases = CodexLiveSessions.ReadLeases(options.CodexSessions);
            foreach (var reason in finalLeases.Problems) Problem("connection", reason);
            foreach (var id in finalLeases.Held.Where(id => !seen.Contains(id)))
                Problem("loading:" + id, "A live Codex chat is loading or its log is unavailable/deleted. Waiting for its status.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Problem("connection", "Could not read current Codex chats: " + ex.Message); }
        var fingerprint = string.Join("\n", work.Select(item => item.Key + ":" + item.Status).Order());
        if (_lastCodexVisible != fingerprint) { _lastCodexVisible = fingerprint; _revision++; }
        var connected = !work.Any(item => item.Key == "Codex:connection");
        return new("Codex", true, connected, work, connected ? "Current local chats detected from live writers and matching turn records." : work.FirstOrDefault()?.Reason ?? "Status unavailable.")
        { InactiveLogCount = historicalFiles };
    }

    private ProviderSnapshot ScanProvider(string provider, bool enabled, string folder, MonitorOptions options, CancellationToken cancellationToken)
    {
        if (!enabled) return new(provider, false, false, [], "Disabled in Connections.");
        var work = new List<WorkItem>();
        void Problem(string reason) => work.Add(new(provider + ":connection", provider, "Connection", "Connection needs attention", WorkStatus.Uncertain, reason, DateTime.UtcNow));
        if (provider == "Claude")
        {
            var installed = OperatingSystem.IsWindows() ? ClaudeHookInstaller.IsInstalled(options.ClaudeHome, options.StateRoot, out var whyWindows) : NativeClaudeBridge.IsInstalled(options.ClaudeHome, options.StateRoot, out var whyMac);
            if (!installed)
            {
                var why = OperatingSystem.IsWindows() ? "Connect Claude in Sources, then restart or resume open Claude Code sessions." : "Connect Claude in Sources, then restart or resume open Code sessions.";
                Problem(why);
            }
        }
        if (provider == "Claude" && File.Exists(Path.Combine(folder, "collector-error.txt"))) Problem("Claude event collection failed. Review the integration and reinstall hooks to acknowledge the error.");
        if (!Directory.Exists(folder))
        {
            Problem(provider == "Codex" ? "The sessions folder is missing. Select the correct folder in Connections." : "No Claude events yet. Install the bridge and start or resume Claude Code.");
            return new(provider, true, false, work, work[0].Reason);
        }
        var observed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var path in Directory.EnumerateFiles(folder, "*.jsonl", SearchOption.AllDirectories))
            {
                cancellationToken.ThrowIfCancellationRequested();
                observed.Add(path);
                var cacheKey = provider + ":" + path;
                if (!_logs.TryGetValue(cacheKey, out var state)) _logs[cacheKey] = state = new() { Path = path, Provider = provider };
                EventLog.Read(state, (log, data) =>
                {
                    var before = JsonSerializer.Serialize(log.Work);
                    if (provider == "Codex") EventLog.ConsumeCodex(log, data); else EventLog.ConsumeClaude(log, data);
                    if (before != JsonSerializer.Serialize(log.Work)) _revision++;
                }, cancellationToken);
                work.AddRange(state.Work.Where(entry => !options.ExcludedWork.Contains(entry.Value.Key)).Select(entry => entry.Value with
                { IsBackground = !entry.Key.StartsWith("prompt:", StringComparison.Ordinal),
                  ChatTitle = entry.Value.ChatTitle.Length > 0 ? entry.Value.ChatTitle : "Claude chat " + (entry.Value.Session.Length > 10 ? entry.Value.Session[..10] : entry.Value.Session) }));
                if (provider == "Codex" && state.SeenModelWork && !state.SeenLifecycle)
                {
                    var unsupported = EventLog.Issue(state, "unsupported-schema:" + state.Offset, "This session contains model work but no supported lifecycle events. Review its state or update the integration.");
                    if (!options.ExcludedWork.Contains(unsupported.Key)) work.Add(unsupported);
                }
                if (state.ReadError is not null) work.Add(EventLog.Issue(state, "read-error", state.ReadError));
                if (state.PartialLine) work.Add(EventLog.Issue(state, "partial-line", "An incomplete log record is still being written."));
                if (provider == "Claude" && !state.SessionEnded && !string.IsNullOrWhiteSpace(state.Cwd) && ProjectHooksDisabled(state.Cwd))
                    work.Add(EventLog.Issue(state, "hooks-disabled", "This Claude project's settings disable hooks."));
            }
            foreach (var state in _logs.Values.Where(log => log.Provider == provider && Within(log.Path, folder) && !observed.Contains(log.Path)))
            {
                var unresolved = state.Work.Values.Where(item => !options.ExcludedWork.Contains(item.Key)).ToArray();
                if (unresolved.Length > 0) { work.AddRange(unresolved); work.Add(EventLog.Issue(state, "deleted", "A log containing unresolved work was deleted.")); }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Problem("Could not scan the configured folder: " + ex.Message); }
        var connected = provider == "Codex" ? !work.Any(item => item.Key == "Codex:connection") && _logs.Values.Any(log => log.Provider == "Codex" && Within(log.Path, folder) && log.SeenLifecycle)
            : !work.Any(item => item.Key == "Claude:connection") && _logs.Values.Any(log => log.Provider == "Claude" && Within(log.Path, folder) && log.SessionConnected);
        if (provider == "Claude" && !connected && work.Count == 0) Problem("Waiting for the first real Claude hook event. Restart or resume Claude Code after setup.");
        if (provider == "Codex" && !connected && work.Count == 0) Problem("No supported Codex turn events found. Check the sessions folder or run a Codex prompt.");
        return new(provider, true, connected, work, connected ? "Connected" : work.FirstOrDefault()?.Reason ?? "Not connected");
    }

    public void SaveCache()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_cachePath)!);
            var temporary = _cachePath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(new Cache { Logs = _logs.Values.ToList(), Revision = _revision }));
            File.Move(temporary, _cachePath, true);
            _lastSave = DateTime.UtcNow;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
    private static bool Within(string path, string folder) => path.StartsWith(Path.TrimEndingDirectorySeparator(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    private static bool ProjectHooksDisabled(string cwd)
    {
        foreach (var name in new[] { "settings.json", "settings.local.json" })
        {
            try { using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(cwd, ".claude", name))); if (json.RootElement.TryGetProperty("disableAllHooks", out var disabled) && disabled.ValueKind == JsonValueKind.True) return true; }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return true; }
        }
        return false;
    }
    private sealed class Cache { public int Schema { get; set; } = 1; public long Revision { get; set; } public List<LogState> Logs { get; set; } = []; }
}
