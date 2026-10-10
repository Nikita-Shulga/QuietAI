namespace QuietAI.Core;

public enum WorkStatus { Running, Scheduled, Uncertain }
public sealed record WorkItem(string Key, string Provider, string Session, string Label, WorkStatus Status, string Reason, DateTime LastEventUtc)
{
    public bool IsBackground { get; init; }
    public string ChatTitle { get; init; } = "";
}
public sealed record RunningChat(string Provider, string Session, string Title, int PromptCount, DateTime StartedUtc);
public sealed record ProviderSnapshot(string Name, bool Enabled, bool Connected, IReadOnlyList<WorkItem> Work, string Detail)
{
    public int Running => Work.Count(item => item.Status == WorkStatus.Running);
    public int Scheduled => Work.Count(item => item.Status == WorkStatus.Scheduled);
    public int Uncertain => Work.Count(item => item.Status == WorkStatus.Uncertain);
    public IReadOnlyList<RunningChat> Chats => Work.Where(item => item.Status == WorkStatus.Running && !item.IsBackground)
        .GroupBy(item => item.Session).Select(group => new RunningChat(Name, group.Key,
            group.First().ChatTitle.Length > 0 ? group.First().ChatTitle : $"Chat {group.Key}", group.Count(), group.Min(item => item.LastEventUtc))).ToArray();
    public int ChatCount => Chats.Count;
    public int BackgroundRunning => Work.Count(item => item.Status == WorkStatus.Running && item.IsBackground);
    public int InactiveLogCount { get; init; }
    public bool Clear => !Enabled || (Connected && Work.Count == 0);
}
public sealed record MonitorSnapshot(ProviderSnapshot Codex, ProviderSnapshot Claude, long Revision, DateTime CheckedUtc)
{
    public int Running => Codex.Running + Claude.Running;
    public int Scheduled => Codex.Scheduled + Claude.Scheduled;
    public int Uncertain => Codex.Uncertain + Claude.Uncertain;
    public int ChatCount => Codex.ChatCount + Claude.ChatCount;
    public int BackgroundRunning => Codex.BackgroundRunning + Claude.BackgroundRunning;
    public IEnumerable<RunningChat> Chats => Codex.Chats.Concat(Claude.Chats);
    public bool Clear => Codex.Clear && Claude.Clear && (Codex.Enabled || Claude.Enabled);
    public IEnumerable<WorkItem> Work => Codex.Work.Concat(Claude.Work);
}
public sealed record MonitorOptions(bool CodexEnabled, string CodexSessions, bool ClaudeEnabled, string ClaudeHome, string StateRoot, IReadOnlySet<string> ExcludedWork);

public static class AppPaths
{
    public static string StateRoot => OperatingSystem.IsMacOS()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "Quiet AI", "monitor")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexQuietShutdown");
    public static string CodexSessions(string? manual = null) => Resolve(manual, "CODEX_HOME", ".codex", "sessions");
    public static string ClaudeHome(string? manual = null) => Resolve(manual, "CLAUDE_CONFIG_DIR", ".claude", "");
    private static string Resolve(string? manual, string environmentVariable, string profileFolder, string child)
    {
        if (!string.IsNullOrWhiteSpace(manual)) return Expand(manual);
        var home = Environment.GetEnvironmentVariable(environmentVariable);
        if (string.IsNullOrWhiteSpace(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), profileFolder);
        return Path.GetFullPath(Path.Combine(Environment.ExpandEnvironmentVariables(home), child));
    }
    public static string Expand(string value)
    {
        value = Environment.ExpandEnvironmentVariables(value.Trim().Trim('"'));
        if (value == "~" || value.StartsWith("~/") || value.StartsWith("~\\"))
            value = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), value.Length == 1 ? "" : value[2..]);
        return Path.GetFullPath(value);
    }
}
