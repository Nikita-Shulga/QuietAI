using System.Diagnostics;
using System.Text.Json;

namespace QuietAI.Core;

// Claude Code keeps one small file per running session in <claude home>/sessions/<pid>.json with
// its sessionId, name and status: "busy" (working), "waiting" (permission prompt / input needed),
// "idle" or "shell". This is an independent second signal next to the lifecycle hook: it covers
// sessions whose hook events were missed or that started before the hook was connected.
// A file only counts while its process is alive (and, on Windows, is the same process).
internal static class ClaudeLiveSessions
{
    public sealed record Inventory(IReadOnlyList<Session> Sessions, bool Complete, string Problem);
    public sealed record Session(string Id, string Name, string Status, string WaitingFor, DateTime UpdatedUtc)
    {
        // Ignore heartbeat-only/name rewrites when the provider supplies a status timestamp.
        // Without one, UpdatedUtc falls back to mtime and intentionally errs on resurfacing.
        public string ActivityToken { get; init; } = "";
    }

    public static IReadOnlyList<Session> Read(string claudeHome) => ReadInventory(claudeHome).Sessions;

    // Absence is useful only when the entire local registry was read successfully.
    // Never turn a missing folder, partial JSON write, or denied process query into an exit.
    public static Inventory ReadInventory(string claudeHome)
    {
        var result = new List<Session>();
        var folder = Path.Combine(claudeHome ?? "", "sessions");
        var complete = true;
        if (string.IsNullOrWhiteSpace(claudeHome) || !Directory.Exists(folder))
            return new(result, false, "Claude's live-session folder is unavailable. Session exits cannot be verified.");
        try
        {
            var files = Directory.GetFiles(folder, "*.json");
            foreach (var file in files)
            {
                try
                {
                    var info = new FileInfo(file);
                    if (info.Length > 64 * 1024) { complete = false; continue; }
                    using var json = JsonDocument.Parse(File.ReadAllBytes(file));
                    var root = json.RootElement;
                    if (root.ValueKind != JsonValueKind.Object) { complete = false; continue; }
                    var id = Text(root, "sessionId");
                    if (id.Length == 0 || !root.TryGetProperty("pid", out var pidValue) || !pidValue.TryGetInt32(out var pid) || pid <= 0)
                    { complete = false; continue; }
                    var domain = Text(root, "pidDomain");
                    var localDomain = (OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux") + ":" + Environment.MachineName;
                    if (domain.Length > 0 && !domain.Equals(localDomain, StringComparison.OrdinalIgnoreCase))
                    { complete = false; continue; }
                    var procStart = Text(root, "procStart");
                    if (OperatingSystem.IsWindows() && procStart.Length > 0 && (!long.TryParse(procStart, out var start) || start <= 0))
                    { complete = false; continue; }
                    var alive = Alive(pid, procStart);
                    if (alive is null) { complete = false; continue; }
                    if (alive == false) continue;
                    var status = Text(root, "status");
                    if (status is not ("busy" or "waiting" or "idle" or "shell"))
                    { complete = false; continue; }
                    var updated = root.TryGetProperty("statusUpdatedAt", out var at) && at.TryGetInt64(out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime : info.LastWriteTimeUtc;
                    result.Add(new(id, Text(root, "name"), status, Text(root, "waitingFor"), updated)
                    { ActivityToken = $"{pid}:{Text(root, "procStart")}:{updated.Ticks}:{status}:{Text(root, "waitingFor")}" });
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException)
                { complete = false; }
            }
            // A session created/deleted during enumeration needs another scan.
            if (!files.Order(StringComparer.Ordinal).SequenceEqual(Directory.GetFiles(folder, "*.json").Order(StringComparer.Ordinal))) complete = false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { complete = false; }
        return new(result, complete, complete ? "" : "Claude's live-session registry could not be checked completely. Waiting for a successful scan.");
    }

    public static bool Working(Session session) => session.Status is "busy" or "waiting";

    private static bool? Alive(int pid, string procStart)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited) return false;
            // On Windows procStart is the process creation time as a FILETIME; a reused pid won't match.
            if (OperatingSystem.IsWindows() && long.TryParse(procStart, out var fileTime) && fileTime > 0)
                return process.StartTime.ToUniversalTime().ToFileTimeUtc() == fileTime;
            return true;
        }
        catch (ArgumentException) { return false; } // No process owns this PID.
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        { return null; } // Access/race failures are not proof of an exit.
    }
    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? (value.GetString() ?? "").Trim() : "";
}
