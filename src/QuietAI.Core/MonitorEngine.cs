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
    private string _lastClaudeLive = "";
    private readonly HashSet<string> _seenLiveSessions = new(StringComparer.OrdinalIgnoreCase);
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
                { Session = id, ChatTitle = title, IsBackground = state.IsSubagent, ActivityToken = EventLog.ActivityToken(state) }));
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
            var reason = work[0].Reason;
            if (provider == "Claude") work = WithClaudeLiveSessions(work, options);
            return new(provider, true, false, work, reason);
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
                  ChatTitle = entry.Value.ChatTitle.Length > 0 ? entry.Value.ChatTitle : "Claude chat " + (entry.Value.Session.Length > 10 ? entry.Value.Session[..10] : entry.Value.Session),
                  ActivityToken = EventLog.ActivityToken(state) }));
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
        if (provider == "Claude") work = WithClaudeLiveSessions(work, options);
        var connected = provider == "Codex" ? !work.Any(item => item.Key == "Codex:connection") && _logs.Values.Any(log => log.Provider == "Codex" && Within(log.Path, folder) && log.SeenLifecycle)
            : !work.Any(item => item.Key == "Claude:connection") && _logs.Values.Any(log => log.Provider == "Claude" && Within(log.Path, folder) && log.SessionConnected);
        if (provider == "Claude" && !connected && work.Count == 0) Problem("Waiting for the first real Claude hook event. Restart or resume Claude Code after setup.");
        if (provider == "Codex" && !connected && work.Count == 0) Problem("No supported Codex turn events found. Check the sessions folder or run a Codex prompt.");
        return new(provider, true, connected, work, connected ? "Connected" : work.FirstOrDefault()?.Reason ?? "Not connected");
    }

    // Second Claude signal: sessions Claude Code itself reports as busy or waiting, even if no hook
    // event says so (missed events, or sessions started before the hook was connected). Also gives
    // every Claude item its chat name, so the app-window row for the same chat isn't listed twice.
    private List<WorkItem> WithClaudeLiveSessions(List<WorkItem> work, MonitorOptions options)
    {
        var live = ClaudeLiveSessions.Read(options.ClaudeHome);
        // An interrupted turn never sends Stop, so its prompt would look "running" until the next turn
        // ends. Claude Code's own live status settles it: a root prompt is over if its session has been
        // idle for a minute since that prompt's last event, or if a session seen here before has exited.
        // Only root prompts are dropped; subagents and background tasks keep their own tracking.
        var liveById = live.GroupBy(s => s.Id, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        foreach (var s in live) _seenLiveSessions.Add(s.Id);
        bool Stale(WorkItem item)
        {
            if (item.Status != WorkStatus.Running || !item.Key.Contains(":prompt:", StringComparison.Ordinal)) return false;
            if (liveById.TryGetValue(item.Session, out var s))
                return s.Status is "idle" or "shell" && DateTime.UtcNow - s.UpdatedUtc > TimeSpan.FromMinutes(1) && item.LastEventUtc < s.UpdatedUtc;
            return _seenLiveSessions.Contains(item.Session);
        }
        work = work.Where(item => !Stale(item)).ToList();
        var hooked = work.Where(item => item.Status == WorkStatus.Running).Select(item => item.Session).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var session in live.Where(ClaudeLiveSessions.Working).Where(s => !hooked.Contains(s.Id)))
        {
            var key = "Claude:live:" + session.Id;
            if (options.ExcludedWork.Contains(key)) continue;
            var waiting = session.Status == "waiting";
            work.Add(new(key, "Claude", session.Id, waiting ? "Claude Code · waiting for you" : "Claude Code · working", WorkStatus.Running,
                waiting ? "Claude Code is waiting (" + (session.WaitingFor.Length > 0 ? session.WaitingFor : "input") + ") before it can finish." : "Claude Code reports this session as busy.", session.UpdatedUtc)
                { IsBackground = false, ActivityToken = "live:" + session.ActivityToken });
        }
        var fingerprint = string.Join("\n", live.Where(ClaudeLiveSessions.Working).Select(s => s.Id + ":" + s.Status).Order());
        if (_lastClaudeLive != fingerprint) { _lastClaudeLive = fingerprint; _revision++; }
        if (work.Count == 0) return work;
        var names = new Dictionary<string, string>(ClaudeChatNames.Read(options.ClaudeHome, work.Select(item => item.Session).Distinct()), StringComparer.OrdinalIgnoreCase);
        foreach (var session in live.Where(s => s.Name.Length > 0)) names[session.Id] = session.Name;
        return work.Select(item => item with
        {
            ChatTitle = names.TryGetValue(item.Session, out var name) ? name : item.ChatTitle.Length > 0 ? item.ChatTitle : "Claude chat " + (item.Session.Length > 10 ? item.Session[..10] : item.Session),
            ActivityToken = item.ActivityToken.Length == 0 ? "" : item.ActivityToken + "|" + (liveById.TryGetValue(item.Session, out var session) ? session.ActivityToken : "no-live")
        }).ToList();
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
