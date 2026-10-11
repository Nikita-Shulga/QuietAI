using System.Text;
using System.Text.Json;

namespace QuietAI.Core;

// Persists completed-line offsets and outstanding work. Full history is read once,
// without allocating entire transcript lines or silently dropping older starts.
public sealed class LogState
{
    public string Path { get; set; } = "";
    public string Provider { get; set; } = "";
    public long Offset { get; set; }
    public long LengthAtScan { get; set; } = -1;
    public long WriteTicks { get; set; }
    public string Anchor { get; set; } = "";
    public bool PartialLine { get; set; }
    public bool SeenLifecycle { get; set; }
    public bool SeenModelWork { get; set; }
    public long EventIndex { get; set; }
    public bool SessionConnected { get; set; }
    public bool SessionEnded { get; set; }
    public bool MetadataRead { get; set; }
    public string SessionId { get; set; } = "";
    public bool IsSubagent { get; set; }
    public bool IsInternal { get; set; }
    public string Cwd { get; set; } = "";
    public Dictionary<string, WorkItem> Work { get; set; } = [];
    public string? ReadError { get; set; }
}

public static class EventLog
{
    private const int PrefixLimit = 16 * 1024;
    public static string ActivityToken(LogState state) => $"{state.Offset}:{state.LengthAtScan}:{state.WriteTicks}:{state.EventIndex}";
    public static void Read(LogState state, Action<LogState, ReadOnlyMemory<byte>> consume, CancellationToken cancellationToken)
    {
        var info = new FileInfo(state.Path);
        if (!info.Exists) { state.ReadError = "The log disappeared; outstanding work has not been declared finished."; return; }
        if (state.LengthAtScan == info.Length && state.WriteTicks == info.LastWriteTimeUtc.Ticks && state.ReadError is null) return;
        try
        {
            using var stream = new FileStream(state.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.SequentialScan);
            var limit = stream.Length;
            var anchorChanged = false;
            if (state.Offset > 0 && state.Anchor.Length > 0 && limit >= state.Offset)
            {
                var expected = Convert.FromBase64String(state.Anchor);
                stream.Position = state.Offset - expected.Length;
                var actual = new byte[expected.Length];
                stream.ReadExactly(actual);
                anchorChanged = !actual.AsSpan().SequenceEqual(expected);
            }
            if (limit < state.Offset || anchorChanged || (limit == state.LengthAtScan && info.LastWriteTimeUtc.Ticks != state.WriteTicks))
            {
                // Changed-in-place/truncated history cannot establish a clean state.
                state.EventIndex++;
                state.Work["history-replaced"] = LifecycleIssue(state, "history-replaced", "History was truncated or replaced. Review this session.");
                state.Offset = 0;
            }
            else if (state.Offset > 0 && state.Anchor.Length == 0) state.Offset = 0;
            state.ReadError = null;
            stream.Position = state.Offset;
            var buffer = new byte[65536];
            var prefix = new byte[PrefixLimit];
            var prefixCount = 0;
            var position = state.Offset;
            var lastComplete = position;
            while (position < limit)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var count = stream.Read(buffer, 0, (int)Math.Min(buffer.Length, limit - position));
                if (count == 0) break;
                var index = 0;
                while (index < count)
                {
                    var remainder = buffer.AsSpan(index, count - index);
                    var newline = remainder.IndexOf((byte)'\n');
                    var segmentSize = newline < 0 ? remainder.Length : newline;
                    var captureSize = Math.Min(segmentSize, PrefixLimit - prefixCount);
                    remainder[..captureSize].CopyTo(prefix.AsSpan(prefixCount));
                    prefixCount += captureSize;
                    index += segmentSize;
                    position += segmentSize;
                    if (newline >= 0)
                    {
                        if (prefixCount > 0) consume(state, prefix.AsMemory(0, prefixCount));
                        prefixCount = 0;
                        index++;
                        position++;
                        lastComplete = position;
                    }
                }
            }
            state.Offset = lastComplete;
            var anchorLength = (int)Math.Min(lastComplete, 64);
            var anchor = new byte[anchorLength];
            stream.Position = lastComplete - anchorLength;
            if (anchorLength > 0) stream.ReadExactly(anchor);
            state.Anchor = Convert.ToBase64String(anchor);
            state.PartialLine = lastComplete < limit;
            state.LengthAtScan = limit;
            state.WriteTicks = info.LastWriteTimeUtc.Ticks;
        }
        catch (IOException ex) { state.ReadError = ex.Message; }
        catch (UnauthorizedAccessException ex) { state.ReadError = ex.Message; }
    }

    public static WorkItem Issue(LogState state, string key, string reason) => new($"{state.Provider}:{state.Path}:{key}", state.Provider, System.IO.Path.GetFileNameWithoutExtension(state.Path), "Unverified session", WorkStatus.Uncertain, reason, DateTime.UtcNow);

    public static void ConsumeCodex(LogState state, ReadOnlyMemory<byte> bytes)
    {
        // Task metadata is at the front of the record. Ignore bulky response text.
        string? outerType = null, eventType = null, turnId = null;
        DateTime when = DateTime.UtcNow;
        try
        {
            var span = bytes.Span;
            if (span.StartsWith(new byte[] { 0xef, 0xbb, 0xbf })) span = span[3..];
            var reader = new Utf8JsonReader(span, isFinalBlock: false, state: default);
            while (reader.Read())
            {
                if (reader.TokenType != JsonTokenType.PropertyName) continue;
                var depth = reader.CurrentDepth;
                var name = reader.GetString();
                if (depth == 1 && name == "type" && reader.Read())
                {
                    outerType = reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
                    if (outerType == "response_item") state.SeenModelWork = true;
                    if (outerType != "event_msg") return;
                }
                else if (depth == 1 && name == "timestamp" && reader.Read() && reader.TokenType == JsonTokenType.String)
                { if (DateTime.TryParse(reader.GetString(), out var timestamp)) when = timestamp.ToUniversalTime(); }
                else if (depth == 2 && name == "type" && reader.Read() && reader.TokenType == JsonTokenType.String) eventType = reader.GetString();
                else if (depth == 2 && name == "turn_id" && reader.Read() && reader.TokenType == JsonTokenType.String) turnId = reader.GetString();
            }
        }
        catch (JsonException)
        {
            if (bytes.Length < PrefixLimit || outerType != "event_msg" || eventType is null) state.Work["invalid-record"] = LifecycleIssue(state, "invalid-record", "A lifecycle record could not be parsed.");
        }
        if (outerType != "event_msg") return;
        if (eventType is not ("task_started" or "task_complete" or "task_aborted" or "turn_aborted" or "task_cancelled" or "turn_cancelled"))
        {
            if (eventType is "agent_message" or "agent_reasoning") state.SeenModelWork = true;
            return;
        }
        state.SeenLifecycle = true;
        state.EventIndex++;
        if (string.IsNullOrWhiteSpace(turnId))
        {
            state.Work["missing-turn-id"] = LifecycleIssue(state, "missing-turn-id", "A start/completion record has no turn ID, so it cannot be paired reliably.");
            return;
        }
        if (eventType == "task_started")
        {
            // A Codex chat runs one turn at a time. A turn that was interrupted or crashed may never
            // get a completion record; a new turn in the same chat means it is over.
            foreach (var previous in state.Work.Where(entry => entry.Key != turnId && entry.Value.Label.StartsWith("Turn ", StringComparison.Ordinal)).Select(entry => entry.Key).ToArray())
                state.Work.Remove(previous);
            state.Work[turnId] = new($"Codex:{state.Path}:{turnId}", "Codex", System.IO.Path.GetFileNameWithoutExtension(state.Path), $"Turn {Short(turnId)}", WorkStatus.Running, "Waiting for this turn's matching completion or cancellation event.", when);
        }
        else state.Work.Remove(turnId);
    }

    public static void ConsumeClaude(LogState state, ReadOnlyMemory<byte> bytes)
    {
        state.EventIndex++;
        try
        {
            using var document = JsonDocument.Parse(bytes);
            var root = document.RootElement;
            if (root.GetProperty("schema").GetInt32() != 1) throw new JsonException("Unsupported bridge event schema.");
            var eventType = root.GetProperty("event").GetString();
            var session = root.GetProperty("session_id").GetString() ?? "unknown";
            var agent = Text(root, "agent_id");
            var prompt = Text(root, "prompt_id");
            var when = root.GetProperty("timestamp_utc").GetDateTime().ToUniversalTime();
            state.Cwd = Text(root, "cwd");
            if (eventType is "SubagentStart" or "SubagentStop" && string.IsNullOrEmpty(agent))
            {
                state.Work["missing-agent-id"] = LifecycleIssue(state, "missing-agent-id", "A subagent lifecycle event has no agent ID. Update Claude Code or review the session.");
                return;
            }
            if (eventType is "UserPromptSubmit" or "PreToolUse" or "PostToolUse" or "Stop" or "StopFailure" && string.IsNullOrEmpty(prompt) && string.IsNullOrEmpty(agent))
                state.Work["missing-prompt-id"] = LifecycleIssue(state, "missing-prompt-id", "Claude did not supply a prompt ID, so overlapping prompts cannot be paired reliably.");
            var key = string.IsNullOrEmpty(agent) ? "prompt:" + (string.IsNullOrEmpty(prompt) ? "legacy" : prompt) : "agent:" + agent;
            WorkItem Running(string itemKey, string label) => new($"Claude:{state.Path}:{itemKey}", "Claude", session, label, WorkStatus.Running, "Waiting for a matching Claude lifecycle event.", when)
            { IsBackground = !itemKey.StartsWith("prompt:"), ChatTitle = $"Claude chat {Short(session)}" };
            if (eventType == "SessionStart")
            {
                state.SessionConnected = true;
                state.SessionEnded = false;
                if (Text(root, "source") == "resume" && !state.SeenLifecycle)
                    state.Work["resume-unknown"] = LifecycleIssue(state, "resume-unknown", "Resumed session: waiting for a prompt or Stop event to establish its state.");
            }
            else if (eventType is "UserPromptSubmit" or "PreToolUse" or "PostToolUse" or "SubagentStart")
            {
                state.SessionConnected = true;
                state.SessionEnded = false;
                state.SeenLifecycle = true;
                state.Work.Remove("resume-unknown");
                state.Work[key] = Running(key, string.IsNullOrEmpty(agent) ? "Claude prompt" : $"Subagent {Short(agent)}");
            }
            else if (eventType is "Stop" or "SubagentStop")
            {
                state.SessionConnected = true;
                state.SeenLifecycle = true;
                state.Work.Remove("resume-unknown");
                state.Work.Remove(key);
                if (eventType == "Stop" && string.IsNullOrEmpty(agent))
                {
                    // A session runs one root turn at a time, so its turn ending means every earlier prompt
                    // is over too — including turns that were interrupted and never sent their own Stop.
                    foreach (var old in state.Work.Keys.Where(k => k.StartsWith("prompt:", StringComparison.Ordinal)).ToArray()) state.Work.Remove(old);
                    foreach (var old in state.Work.Keys.Where(k => k.StartsWith("background:") || k.StartsWith("cron:")).ToArray()) state.Work.Remove(old);
                    if (!root.TryGetProperty("background_tasks", out var background) || background.ValueKind != JsonValueKind.Array ||
                        !root.TryGetProperty("session_crons", out var crons) || crons.ValueKind != JsonValueKind.Array)
                        state.Work["missing-registry"] = LifecycleIssue(state, "missing-registry", "Stop did not include background/scheduled-work registries. Update Claude Code or review the session.");
                    else
                    {
                        state.Work.Remove("missing-registry");
                        foreach (var task in background.EnumerateArray())
                        {
                            var id = Text(task, "id");
                            if (string.IsNullOrEmpty(id)) { state.Work["registry-id"] = LifecycleIssue(state, "registry-id", "Background work has no identifier."); continue; }
                            if (Text(task, "status") is "completed" or "failed" or "cancelled") continue;
                            if (state.Work.ContainsKey("agent:" + id)) continue;
                            state.Work["background:" + id] = Running("background:" + id, "Background " + Text(task, "type"));
                        }
                        foreach (var cron in crons.EnumerateArray())
                        {
                            var id = Text(cron, "id");
                            if (string.IsNullOrEmpty(id)) id = Guid.NewGuid().ToString("N");
                            state.Work["cron:" + id] = new($"Claude:{state.Path}:cron:{id}", "Claude", session, "Scheduled wakeup", WorkStatus.Scheduled, "A Claude scheduled wakeup is still registered.", when);
                        }
                        // Subagents that ran inside the turn (foreground) may report tool events but never a
                        // SubagentStop. The root Stop's registry lists everything still running in the
                        // background, so any other subagent of this session has finished.
                        var stillRunning = background.EnumerateArray().Where(task => Text(task, "status") is not ("completed" or "failed" or "cancelled"))
                            .Select(task => Text(task, "id")).Where(id => id.Length > 0).ToHashSet(StringComparer.Ordinal);
                        foreach (var old in state.Work.Keys.Where(k => k.StartsWith("agent:", StringComparison.Ordinal) && !stillRunning.Contains(k[6..])).ToArray()) state.Work.Remove(old);
                    }
                }
            }
            else if (eventType == "StopFailure")
            {
                state.Work.Remove(key);
                state.Work["failed-turn"] = LifecycleIssue(state, "failed-turn", "Claude stopped with an API error. Review the session before acting.");
            }
            else if (eventType == "SessionEnd")
            {
                state.SessionEnded = true;
                foreach (var old in state.Work.Keys.Where(k => k.StartsWith("prompt:") || k.StartsWith("cron:") || k == "resume-unknown").ToArray()) state.Work.Remove(old);
                // Known background agents/shell work survive until explicitly resolved.
            }
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        { state.Work["invalid-bridge-record"] = LifecycleIssue(state, "invalid-bridge-record", "A Claude bridge record is invalid or uses an unsupported schema."); }
    }

    private static string Text(JsonElement element, string key) => element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    private static WorkItem LifecycleIssue(LogState state, string key, string reason) => Issue(state, key + ":" + state.EventIndex, reason);
    private static string Short(string value) => value.Length > 10 ? value[..10] : value;
}
