using System.Text.Json;
using System.Text.Json.Serialization;
using QuietAI.Core;

var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Converters = { new JsonStringEnumConverter() } };
if (args.Length >= 2 && args[0] == "hook")
{
    try { NativeClaudeBridge.Collect(args[1], Console.In.ReadToEnd()); return 0; }
    catch { Directory.CreateDirectory(Path.Combine(args[1], "claude-events")); File.WriteAllText(Path.Combine(args[1], "claude-events", "collector-error.txt"), "Claude event collection failed. Reconnect Claude in Quiet AI."); return 1; }
}
var state = args.Length > 0 ? Path.GetFullPath(args[0]) : AppPaths.StateRoot;
var engine = new MonitorEngine(state);
string? line;
while ((line = Console.ReadLine()) is not null)
{
    int id = 0;
    try
    {
        using var input = JsonDocument.Parse(line);
        var root = input.RootElement; id = root.GetProperty("id").GetInt32();
        var settings = root.GetProperty("settings");
        string Text(string name) => settings.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
        bool Flag(string name) => settings.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
        var claude = AppPaths.ClaudeHome(Text("claudeHomeOverride"));
        var command = root.GetProperty("command").GetString();
        if (command is "install" or "remove")
        {
            if (command == "remove") { if (OperatingSystem.IsWindows()) ClaudeHookInstaller.Uninstall(claude, state); else NativeClaudeBridge.Uninstall(claude, state); }
            else if (OperatingSystem.IsWindows()) ClaudeHookInstaller.Install(claude, state, Path.Combine(AppContext.BaseDirectory, "ClaudeHook.ps1"));
            else NativeClaudeBridge.Install(claude, state, AppContext.BaseDirectory);
            Console.WriteLine(JsonSerializer.Serialize(new { id, ok = true, message = command == "install" ? "Claude connected. Restart or resume open Claude Code sessions to load the hooks." : "Quiet AI hooks removed. Other hooks retained." }, json));
            continue;
        }
        var exclusions = settings.TryGetProperty("excludedWork", out var entries) ? entries.EnumerateArray().Select(item => item.GetString() ?? "").ToHashSet() : new HashSet<string>();
        var snapshot = engine.Scan(new(Flag("codexEnabled"), AppPaths.CodexSessions(Text("codexSessionsOverride")), Flag("claudeEnabled"), claude, state, exclusions));
        Console.WriteLine(JsonSerializer.Serialize(new { id, ok = true, snapshot }, json));
    }
    catch (Exception ex) { Console.WriteLine(JsonSerializer.Serialize(new { id, ok = false, error = ex.Message }, json)); }
}
engine.SaveCache();
return 0;
