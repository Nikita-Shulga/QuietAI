using System.Text.Json;

namespace QuietAI.Core;

// Chat names for Claude Code sessions, so hook-tracked work shows the same title as the Claude
// app (and isn't listed a second time from the app window). Sources, best first:
//  1. <claude home>/sessions/<pid>.json  — one per running session: sessionId + name.
//  2. <claude home>/projects/<project>/<sessionId>/custom-title.json — {"customTitle": "..."}.
// Read-only and best effort: a missing name never changes the completion decision.
internal static class ClaudeChatNames
{
    public static IReadOnlyDictionary<string, string> Read(string claudeHome, IEnumerable<string> sessionIds)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var wanted = sessionIds.Where(id => !string.IsNullOrWhiteSpace(id) && id.IndexOfAny(Path.GetInvalidFileNameChars()) < 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (wanted.Count == 0 || string.IsNullOrWhiteSpace(claudeHome)) return result;
        try
        {
            var live = Path.Combine(claudeHome, "sessions");
            if (Directory.Exists(live))
                foreach (var file in Directory.EnumerateFiles(live, "*.json"))
                {
                    var json = ReadSmall(file);
                    if (json is null) continue;
                    using (json)
                    {
                        var id = Text(json.RootElement, "sessionId");
                        var name = Text(json.RootElement, "name");
                        if (wanted.Contains(id) && name.Length > 0) result[id] = name;
                    }
                }
            var projects = Path.Combine(claudeHome, "projects");
            if (Directory.Exists(projects) && wanted.Any(id => !result.ContainsKey(id)))
                foreach (var project in Directory.EnumerateDirectories(projects))
                    foreach (var id in wanted.Where(id => !result.ContainsKey(id)).ToArray())
                    {
                        var json = ReadSmall(Path.Combine(project, id, "custom-title.json"));
                        if (json is null) continue;
                        using (json) { var name = Text(json.RootElement, "customTitle"); if (name.Length > 0) result[id] = name; }
                    }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return result;
    }

    private static JsonDocument? ReadSmall(string file)
    {
        try
        {
            var info = new FileInfo(file);
            if (!info.Exists || info.Length > 64 * 1024) return null;
            var document = JsonDocument.Parse(File.ReadAllBytes(file));
            if (document.RootElement.ValueKind == JsonValueKind.Object) return document;
            document.Dispose();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return null;
    }
    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? (value.GetString() ?? "").Trim() : "";
}
