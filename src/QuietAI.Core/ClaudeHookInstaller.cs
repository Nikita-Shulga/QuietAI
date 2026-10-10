using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text;

namespace QuietAI.Core;

public static class ClaudeHookInstaller
{
    public static readonly string[] Events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop", "SessionEnd", "StopFailure"];
    private static string ScriptPath(string stateRoot) => Path.Combine(stateRoot, "integration", "ClaudeHook.ps1");
    public static bool IsInstalled(string claudeHome, string stateRoot, out string reason)
    {
        reason = "Install Claude hooks in Connections, then restart or resume Claude Code.";
        try
        {
            if (!File.Exists(ScriptPath(stateRoot))) return false;
            var settings = JsonNode.Parse(File.ReadAllText(Path.Combine(claudeHome, "settings.json")))?.AsObject();
            if (settings?["disableAllHooks"]?.GetValue<bool>() == true) { reason = "Claude's user settings disable all hooks."; return false; }
            var hooks = settings?["hooks"] as JsonObject;
            if (hooks is null) return false;
            foreach (var eventName in Events)
            {
                var groups = hooks[eventName] as JsonArray;
                if (groups is null || !groups.OfType<JsonObject>().Any(group => (group["hooks"] as JsonArray)?.OfType<JsonObject>().Any(handler =>
                    handler["type"]?.GetValue<string>() == "command" && handler["command"]?.GetValue<string>() == HookCommand(stateRoot) && handler["async"]?.GetValue<bool>() != true) == true)) return false;
            }
            reason = "Installed; waiting for lifecycle events.";
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        { reason = "Could not verify Claude hook settings: " + ex.Message; return false; }
    }
    public static string Install(string claudeHome, string stateRoot, string bundledScript)
    {
        var settingsPath = Path.Combine(claudeHome, "settings.json");
        Directory.CreateDirectory(claudeHome);
        var settings = File.Exists(settingsPath) ? JsonNode.Parse(File.ReadAllText(settingsPath))?.AsObject() ?? throw new InvalidDataException("Claude settings are empty.") : new JsonObject();
        if (settings["disableAllHooks"]?.GetValue<bool>() == true) throw new InvalidOperationException("Claude settings disable all hooks. Enable them before installing the bridge.");
        var hooks = settings["hooks"] as JsonObject;
        if (hooks is null)
        {
            if (settings.ContainsKey("hooks")) throw new InvalidDataException("The hooks setting is not an object.");
            settings["hooks"] = hooks = new JsonObject();
        }
        var scriptPath = ScriptPath(stateRoot);
        var command = HookCommand(stateRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(scriptPath)!);
        File.Copy(bundledScript, scriptPath, true);
        Directory.CreateDirectory(Path.Combine(stateRoot, "claude-events"));
        foreach (var eventName in Events)
        {
            if (hooks[eventName] is not null && hooks[eventName] is not JsonArray) throw new InvalidDataException($"Hook {eventName} is not an array.");
            var groups = hooks[eventName] as JsonArray;
            if (groups is null) hooks[eventName] = groups = new JsonArray();
            foreach (var group in groups.OfType<JsonObject>().ToArray())
            {
                if (group["hooks"] is not JsonArray handlers) continue;
                foreach (var handler in handlers.OfType<JsonObject>().ToArray())
                    if (handler["command"] is JsonValue value && value.TryGetValue<string>(out var existing) && IsOurCommand(existing, stateRoot)) handlers.Remove(handler);
                if (handlers.Count == 0) groups.Remove(group);
            }
            groups.Add(new JsonObject { ["hooks"] = new JsonArray(new JsonObject { ["type"] = "command", ["command"] = command, ["timeout"] = 10 }) });
        }
        var backup = "";
        if (File.Exists(settingsPath))
        {
            backup = settingsPath + ".codexquiet-backup-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
            File.Copy(settingsPath, backup, false);
        }
        var temporary = settingsPath + ".codexquiet-tmp";
        File.WriteAllText(temporary, settings.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, settingsPath, true);
        var errorMarker = Path.Combine(stateRoot, "claude-events", "collector-error.txt");
        if (File.Exists(errorMarker)) File.Delete(errorMarker);
        return backup;
    }
    public static void Uninstall(string claudeHome, string stateRoot)
    {
        var settingsPath = Path.Combine(claudeHome, "settings.json");
        var settings = JsonNode.Parse(File.ReadAllText(settingsPath))?.AsObject() ?? throw new InvalidDataException("Claude settings are empty.");
        if (settings["hooks"] is JsonObject hooks)
            foreach (var eventName in Events)
            {
                if (hooks[eventName] is not JsonArray groups) continue;
                foreach (var group in groups.OfType<JsonObject>().ToArray())
                {
                    if (group["hooks"] is not JsonArray handlers) continue;
                    foreach (var handler in handlers.OfType<JsonObject>().ToArray())
                        if (handler["command"] is JsonValue value && value.TryGetValue<string>(out var command) && IsOurCommand(command, stateRoot)) handlers.Remove(handler);
                    if (handlers.Count == 0) groups.Remove(group);
                }
                if (groups.Count == 0) hooks.Remove(eventName);
            }
        File.Copy(settingsPath, settingsPath + ".codexquiet-backup-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff"), false);
        var temporary = settingsPath + ".codexquiet-tmp";
        File.WriteAllText(temporary, settings.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, settingsPath, true);
    }
    public static string HookCommand(string stateRoot)
    {
        static string Literal(string value) => "'" + value.Replace("'", "''") + "'";
        var script = "# CodexQuiet lifecycle bridge v1\n& " + Literal(ScriptPath(stateRoot)) + " -StateDirectory " + Literal(Path.Combine(stateRoot, "claude-events"));
        return "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
    }
    private static bool IsOurCommand(string command, string stateRoot)
    {
        if (command == HookCommand(stateRoot)) return true;
        if (command.Contains(ScriptPath(stateRoot), StringComparison.OrdinalIgnoreCase)) return true;
        var separator = command.IndexOf("-EncodedCommand ", StringComparison.OrdinalIgnoreCase);
        if (separator < 0) return false;
        try { return Encoding.Unicode.GetString(Convert.FromBase64String(command[(separator + 16)..].Trim())).Contains(ScriptPath(stateRoot).Replace("'", "''"), StringComparison.OrdinalIgnoreCase); }
        catch (FormatException) { return false; }
    }
}
