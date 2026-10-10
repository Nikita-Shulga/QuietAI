using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace QuietAI.Core;

public static class NativeClaudeBridge
{
    private static string Executable(string state) => Path.Combine(state, "integration", "agent", "QuietAI.Agent");
    private static string Quote(string text) => "'" + text.Replace("'", "'\\''") + "'";
    public static string Command(string state) => Quote(Executable(state)) + " hook " + Quote(state);
    public static bool IsInstalled(string home, string state, out string reason)
    {
        reason = "Connect Claude, then restart or resume open Code sessions.";
        try
        {
            if (!File.Exists(Executable(state))) return false;
            var settings = JsonNode.Parse(File.ReadAllText(Path.Combine(home, "settings.json")))!.AsObject();
            if (settings["disableAllHooks"]?.GetValue<bool>() == true) { reason = "Claude user settings disable hooks."; return false; }
            if (settings["hooks"] is not JsonObject hooks) return false;
            foreach (var name in ClaudeHookInstaller.Events)
                if (hooks[name] is not JsonArray groups || !groups.OfType<JsonObject>().Any(group => group["hooks"] is JsonArray handlers && handlers.OfType<JsonObject>().Any(handler => handler["command"]?.GetValue<string>() == Command(state) && handler["async"]?.GetValue<bool>() != true))) return false;
            reason = "Connected; waiting for Claude lifecycle events."; return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException) { reason = "Could not read Claude integration settings."; return false; }
    }
    public static void Install(string home, string state, string bundledAgent)
    {
        Directory.CreateDirectory(home);
        var file = Path.Combine(home, "settings.json");
        var settings = File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file))!.AsObject() : new JsonObject();
        if (settings["disableAllHooks"]?.GetValue<bool>() == true) throw new InvalidOperationException("Claude settings disable hooks. Enable them before connecting.");
        if (settings["hooks"] is not null and not JsonObject) throw new InvalidDataException("Claude hooks configuration is not an object.");
        var hooks = settings["hooks"] as JsonObject;
        if (hooks is null) { hooks = new JsonObject(); settings["hooks"] = hooks; }
        var target = Path.GetDirectoryName(Executable(state))!; Directory.CreateDirectory(target);
        foreach (var source in Directory.EnumerateFiles(bundledAgent))
        {
            var destination = Path.Combine(target, Path.GetFileName(source)); File.Copy(source, destination, true);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(destination, File.GetUnixFileMode(source));
        }
        foreach (var name in ClaudeHookInstaller.Events)
        {
            if (hooks[name] is not null and not JsonArray) throw new InvalidDataException("A Claude hook entry is not an array.");
            var groups = hooks[name] as JsonArray;
            if (groups is null) { groups = new JsonArray(); hooks[name] = groups; }
            RemoveOwn(groups, state);
            groups.Add(new JsonObject { ["hooks"] = new JsonArray(new JsonObject { ["type"] = "command", ["command"] = Command(state), ["timeout"] = 10 }) });
        }
        Save(file, settings);
        Directory.CreateDirectory(Path.Combine(state, "claude-events"));
        var marker = Path.Combine(state, "claude-events", "collector-error.txt"); if (File.Exists(marker)) File.Delete(marker);
    }
    public static void Uninstall(string home, string state)
    {
        var file = Path.Combine(home, "settings.json");
        var settings = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
        if (settings["hooks"] is JsonObject hooks)
            foreach (var name in ClaudeHookInstaller.Events)
                if (hooks[name] is JsonArray groups) { RemoveOwn(groups, state); if (groups.Count == 0) hooks.Remove(name); }
        Save(file, settings);
    }
    private static void RemoveOwn(JsonArray groups, string state)
    {
        foreach (var group in groups.OfType<JsonObject>().ToArray())
        {
            if (group["hooks"] is not JsonArray handlers) continue;
            foreach (var handler in handlers.OfType<JsonObject>().ToArray())
                if (handler["command"]?.GetValue<string>() == Command(state)) handlers.Remove(handler);
            if (handlers.Count == 0) groups.Remove(group);
        }
    }
    private static void Save(string file, JsonObject settings)
    {
        if (File.Exists(file)) File.Copy(file, file + ".quietai-backup-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff"));
        var temp = file + ".quietai-tmp"; File.WriteAllText(temp, settings.ToJsonString(new() { WriteIndented = true })); File.Move(temp, file, true);
    }
    public static void Collect(string state, string input)
    {
        using var document = JsonDocument.Parse(input); var root = document.RootElement;
        string Text(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
        var session = Text("session_id"); var name = Text("hook_event_name");
        if (!Regex.IsMatch(session, "^[a-zA-Z0-9_-]{1,160}$") || !ClaudeHookInstaller.Events.Contains(name)) throw new InvalidDataException();
        var record = new JsonObject { ["schema"] = 1, ["event"] = name, ["session_id"] = session, ["prompt_id"] = Text("prompt_id"), ["agent_id"] = Text("agent_id"), ["source"] = Text("source"), ["cwd"] = Text("cwd"), ["timestamp_utc"] = DateTime.UtcNow.ToString("O") };
        foreach (var registry in new[] { "background_tasks", "session_crons" })
        {
            if (!root.TryGetProperty(registry, out var items) || items.ValueKind != JsonValueKind.Array) continue;
            var filtered = new JsonArray();
            foreach (var item in items.EnumerateArray())
            {
                var safe = new JsonObject();
                foreach (var key in registry == "background_tasks" ? new[] { "id", "type", "status" } : new[] { "id" })
                    safe[key] = item.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : "";
                filtered.Add(safe);
            }
            record[registry] = filtered;
        }
        var folder = Path.Combine(state, "claude-events"); Directory.CreateDirectory(folder);
        using var lease = new FileStream(Path.Combine(folder, session + ".collector-lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
        if (flock(lease.SafeFileHandle.DangerousGetHandle().ToInt32(), 2) != 0) throw new IOException("Collector lock failed.");
        try
        {
            using var file = new FileStream(Path.Combine(folder, session + ".jsonl"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            file.Write(Encoding.UTF8.GetBytes(record.ToJsonString() + "\n")); file.Flush(true);
        }
        finally { flock(lease.SafeFileHandle.DangerousGetHandle().ToInt32(), 8); }
    }
    [DllImport("libc", SetLastError = true)] private static extern int flock(int descriptor, int operation);
}
