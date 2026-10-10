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
    public sealed record Session(string Id, string Name, string Status, string WaitingFor, DateTime UpdatedUtc);

    public static IReadOnlyList<Session> Read(string claudeHome)
    {
        var result = new List<Session>();
        var folder = Path.Combine(claudeHome ?? "", "sessions");
        if (string.IsNullOrWhiteSpace(claudeHome) || !Directory.Exists(folder)) return result;
        try
        {
            foreach (var file in Directory.EnumerateFiles(folder, "*.json"))
            {
                try
                {
                    var info = new FileInfo(file);
                    if (info.Length > 64 * 1024) continue;
                    using var json = JsonDocument.Parse(File.ReadAllBytes(file));
                    var root = json.RootElement;
                    if (root.ValueKind != JsonValueKind.Object) continue;
                    var id = Text(root, "sessionId");
                    if (id.Length == 0 || !root.TryGetProperty("pid", out var pidValue) || !pidValue.TryGetInt32(out var pid)) continue;
                    if (!Alive(pid, Text(root, "procStart"))) continue;
                    var updated = root.TryGetProperty("statusUpdatedAt", out var at) && at.TryGetInt64(out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime : info.LastWriteTimeUtc;
                    result.Add(new(id, Text(root, "name"), Text(root, "status"), Text(root, "waitingFor"), updated));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException) { }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return result;
    }

    public static bool Working(Session session) => session.Status is "busy" or "waiting";

    private static bool Alive(int pid, string procStart)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited) return false;
            // On Windows procStart is the process creation time as a FILETIME; a reused pid won't match.
            if (OperatingSystem.IsWindows() && long.TryParse(procStart, out var fileTime) && fileTime > 0)
                return Math.Abs(process.StartTime.ToUniversalTime().ToFileTimeUtc() - fileTime) < 20_000_000;
            return true;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { return false; }
    }
    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? (value.GetString() ?? "").Trim() : "";
}
