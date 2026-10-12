using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using QuietAI.Core;

var root = Path.Combine(Path.GetTempPath(), "quietai-claude-lifecycle-" + Guid.NewGuid());
Directory.CreateDirectory(root);
var passed = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception(name);
    Console.WriteLine("PASS " + name); passed++;
}
try
{
    var clock = DateTime.UtcNow;
    var home = Path.Combine(root, "claude");
    var folder = Path.Combine(home, "sessions");
    Directory.CreateDirectory(folder);
    var stateRoot = Path.Combine(root, "state");
    var options = new MonitorOptions(false, root, true, home, stateRoot, new HashSet<string>());
    MonitorEngine Engine() => new(stateRoot, () => clock);
    var engine = Engine();
    var method = typeof(MonitorEngine).GetMethod("WithClaudeLiveSessions", BindingFlags.Instance | BindingFlags.NonPublic)!;
    List<WorkItem> Read(params WorkItem[] work) => (List<WorkItem>)method.Invoke(engine, new object[] { work.ToList(), options })!;
    WorkItem Prompt(string session, string id = "one", DateTime? at = null) =>
        new($"Claude:fixture-{session}:prompt:{id}", "Claude", session, "Claude prompt", WorkStatus.Running, "Fixture", at ?? clock.AddHours(-52))
        { ActivityToken = "fixture-generation" };
    var old = Prompt("previous-account");
    var current = Prompt("current-account", at: clock);
    var liveFile = Path.Combine(folder, Environment.ProcessId + ".json");
    void Live(string session, string status = "busy", DateTime? at = null, string? procStart = null, string? domain = null)
    {
        File.WriteAllText(liveFile, JsonSerializer.Serialize(new
        {
            pid = Environment.ProcessId, sessionId = session, name = "Fixture", status,
            statusUpdatedAt = new DateTimeOffset(at ?? clock).ToUnixTimeMilliseconds(),
            procStart, pidDomain = domain
        }));
    }
    bool Has(List<WorkItem> work, string session) => work.Any(w => w.Session == session && w.Status == WorkStatus.Running);

    // A fresh app run has never observed the previous account's exited session.
    Live("current-account");
    Check(Read(old, current).Count == 2, "first healthy scan gives unregistered roots a startup grace period");
    clock = clock.AddSeconds(9);
    Check(Has(Read(old, current), old.Session), "confirmation cannot retire a root before ten seconds");
    clock = clock.AddSeconds(2);
    var switched = Read(old, current);
    Check(!Has(switched, old.Session) && Has(switched, current.Session), "account switch retires historical root and preserves current account work");
    engine = Engine();
    Check(Has(Read(old, current), old.Session), "restart repeats exit verification instead of trusting prior silence");
    clock = clock.AddSeconds(11);
    Check(!Has(Read(old, current), old.Session), "historical root is also retired after a Quiet AI restart");

    Live(old.Session);
    Check(Has(Read(old), old.Session), "a genuinely busy 52-hour session never expires by age");
    Live(old.Session, "waiting");
    Check(Has(Read(old), old.Session), "an old session waiting for user input still blocks");
    var duplicate = Path.Combine(folder, "duplicate.json");
    File.WriteAllText(duplicate, JsonSerializer.Serialize(new { pid = Environment.ProcessId, sessionId = old.Session, status = "idle", statusUpdatedAt = new DateTimeOffset(clock).ToUnixTimeMilliseconds() }));
    Check(Has(Read(old), old.Session), "busy or waiting owner wins over a second idle owner of the same session");
    Check(Read().Count(w => w.Session == old.Session && w.Status == WorkStatus.Running) == 1, "multiple registry owners never duplicate one running chat");
    File.Delete(duplicate);
    Live(old.Session, "idle", clock.AddMinutes(-2));
    Check(Read(old).Count == 0, "explicit idle status after an older prompt retires its interrupted turn");
    Check(Has(Read(old with { LastEventUtc = clock }), old.Session), "fresh hook activity wins over older idle status");

    Live("current-account");
    var background = old with { Key = "Claude:fixture:agent:child", IsBackground = true };
    var scheduled = old with { Key = "Claude:fixture:cron:wakeup", Status = WorkStatus.Scheduled, IsBackground = true };
    var unknown = old with { Key = "Claude:fixture:invalid", Status = WorkStatus.Uncertain };
    Read(old, background, scheduled, unknown);
    clock = clock.AddSeconds(11);
    var protectedWork = Read(old, background, scheduled, unknown);
    Check(!Has(protectedWork, old.Session) || protectedWork.All(w => w.Key != old.Key), "only the absent root is retired");
    Check(protectedWork.Any(w => w.Key == background.Key), "background agents survive root-session retirement");
    Check(protectedWork.Any(w => w.Key == scheduled.Key), "scheduled work survives root-session retirement");
    Check(protectedWork.Any(w => w.Key == unknown.Key), "uncertain work survives root-session retirement");

    var broken = Path.Combine(folder, "partial.json");
    File.WriteAllText(broken, "{\"pid\":");
    Check(Has(Read(old), old.Session) && Read(old).Any(w => w.Status == WorkStatus.Uncertain), "partial registry writes cannot falsely retire work");
    File.Delete(broken);
    File.WriteAllText(broken, "{\"sessionId\":\"bad-field\",\"pid\":\"not-a-number\"}");
    Check(Read(old).Any(w => w.Status == WorkStatus.Uncertain), "invalid registry field types produce a blocking status instead of a scan crash");
    File.Delete(broken);
    Read(old);
    clock = clock.AddSeconds(11);
    Check(!Has(Read(old), old.Session), "healthy registry recovery restarts and completes exit verification");

    Directory.Move(folder, folder + "-temporarily-unavailable");
    Check(Has(Read(old), old.Session) && Read(old).Any(w => w.Status == WorkStatus.Uncertain), "missing live-session folder blocks instead of implying an exit");
    Directory.Move(folder + "-temporarily-unavailable", folder);
    Read(old); clock = clock.AddSeconds(11);
    Check(!Has(Read(old), old.Session), "missing-folder recovery requires new healthy scans");

    Live("current-account", "future-unsupported-status");
    Check(Read(old).Any(w => w.Status == WorkStatus.Uncertain) && Has(Read(old), old.Session), "unsupported live status keeps historical roots protected");
    Live("current-account", domain: "remote:another-host");
    Check(Read(old).Any(w => w.Status == WorkStatus.Uncertain), "foreign PID domains cannot be used as local exit evidence");
    Live("current-account");

    engine = Engine(); Read(old);
    clock = clock.AddSeconds(11);
    var fresh = old with { LastEventUtc = clock, ActivityToken = "new-hook-generation" };
    Check(Has(Read(fresh), fresh.Session), "new hook generation cancels an old exit confirmation");
    clock = clock.AddSeconds(9);
    Check(Has(Read(fresh), fresh.Session), "fresh unregistered hooks retain their full registration grace period");
    Live(fresh.Session);
    clock = clock.AddMinutes(5);
    Check(Has(Read(fresh), fresh.Session), "resumed account session reappears automatically without a manual restore");
    File.Delete(liveFile);
    Read(fresh); clock = clock.AddSeconds(11);
    Check(Read(fresh).Count == 0, "empty but readable registry also verifies local session exits");

    if (OperatingSystem.IsWindows())
    {
        using var process = Process.GetCurrentProcess();
        Live(old.Session, procStart: process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString());
        Check(Has(Read(old), old.Session), "exact Windows process creation identity recognizes the real owner");
        Live(old.Session, procStart: "invalid-identity");
        Check(Read(old).Any(w => w.Status == WorkStatus.Uncertain), "invalid Windows process identity cannot validate a session inventory");
        Live(old.Session, procStart: "1");
        Read(old); clock = clock.AddSeconds(11);
        Check(Read(old).Count == 0, "reused Windows PID cannot keep a dead session running");
    }

    // Exercise the public scan/cache path with genuine fixture hook installation,
    // not just the reconciliation helper. Never touch the user's settings.
    var events = Path.Combine(stateRoot, "claude-events"); Directory.CreateDirectory(events);
    var logPath = Path.Combine(events, "previous-account.jsonl");
    var oldAt = clock.AddHours(-52).ToString("O");
    File.WriteAllText(logPath, JsonSerializer.Serialize(new { schema = 1, @event = "SessionStart", session_id = old.Session, source = "startup", cwd = root, timestamp_utc = oldAt }) + "\n" +
        JsonSerializer.Serialize(new { schema = 1, @event = "UserPromptSubmit", session_id = old.Session, prompt_id = "old", cwd = root, timestamp_utc = oldAt }) + "\n");
    var script = Path.Combine(root, "fixture-collector.ps1"); File.WriteAllText(script, "# fixture only");
    if (OperatingSystem.IsWindows()) ClaudeHookInstaller.Install(home, stateRoot, script);
    else
    {
        var bundle = Path.Combine(root, "fixture-agent"); Directory.CreateDirectory(bundle);
        File.WriteAllText(Path.Combine(bundle, "QuietAI.Agent"), "fixture only");
        NativeClaudeBridge.Install(home, stateRoot, bundle);
    }
    Live("current-account"); engine = Engine();
    var scan = engine.Scan(options);
    Check(scan.Claude.ChatCount == 2 && !scan.Clear, "public scan initially counts historical and current roots during verification");
    clock = clock.AddSeconds(11); scan = engine.Scan(options);
    Check(scan.Claude.ChatCount == 1 && scan.Claude.Chats.Single().Session == "current-account" && !scan.Clear,
        "public scan removes old account from counts while current account still blocks power");
    engine.SaveCache(); engine = Engine(); engine.Scan(options); clock = clock.AddSeconds(11);
    Check(engine.Scan(options).Claude.ChatCount == 1, "saved legacy history cannot resurrect an exited account after restart");
    File.Delete(liveFile); engine.Scan(options); clock = clock.AddSeconds(11);
    Check(engine.Scan(options).Clear, "all roots finished permits clear after exit verification");
    Live("current-account", "busy");
    Check(!engine.Scan(options).Clear, "new real activity immediately blocks after a previous clear");

    var state = new LogState { Path = logPath, Provider = "Claude" };
    void Event(string type, string prompt, string agent = "") => EventLog.ConsumeClaude(state, Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        { schema = 1, @event = type, session_id = "same-session", prompt_id = prompt, agent_id = agent, timestamp_utc = clock.ToString("O") })));
    Event("UserPromptSubmit", "interrupted"); Event("SubagentStart", "", "child");
    Event("UserPromptSubmit", "current");
    Check(!state.Work.ContainsKey("prompt:interrupted") && state.Work.ContainsKey("prompt:current"), "new root prompt supersedes an interrupted prior root in the same chat");
    Check(state.Work.ContainsKey("agent:child"), "superseding root never clears a background agent");
    Event("PreToolUse", "other");
    Check(state.Work.ContainsKey("prompt:current") && state.Work.ContainsKey("prompt:other"), "tool activity never arbitrarily clears another root");
    Console.WriteLine($"{passed} Claude lifecycle checks passed; only isolated generated fixtures used.");
}
finally { Directory.Delete(root, true); }
