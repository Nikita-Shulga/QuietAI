using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace QuietAI.Core;

// File age is never used to infer completion. A Windows lock violation proves
// that a live Codex writer owns the session; an unlocked historical file does not.
public static partial class CodexLiveSessions
{
    public sealed record LeaseSnapshot(IReadOnlySet<string> Held, IReadOnlyList<string> Problems);
    public static string Home(string sessions) => Directory.GetParent(Path.TrimEndingDirectorySeparator(sessions))?.FullName ?? sessions;
    public static string SessionId(string path)
    {
        var name = Path.GetFileNameWithoutExtension(path);
        var match = IdAtEnd().Match(name);
        return match.Success ? match.Value : name;
    }
    [GeneratedRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    private static partial Regex IdAtEnd();

    public static LeaseSnapshot ReadLeases(string sessions)
    {
        var held = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var problems = new List<string>();
        var folder = Path.Combine(Home(sessions), "thread-writer-locks");
        if (!Directory.Exists(folder))
            return new(held, ["Live Codex writer locks are unavailable. Select the sessions folder belonging to a recent local Codex installation."]);
        if (OperatingSystem.IsMacOS()) return MacWriterLocks.Read(folder);
        if (!OperatingSystem.IsWindows()) return new(held, ["Writer inspection currently supports Windows and macOS."]);
        try
        {
            foreach (var path in Directory.EnumerateFiles(folder, "*.lock"))
            {
                if (Path.GetFileName(path) == ".coordination.lock") continue;
                try
                {
                    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1);
                    // A direct read also catches byte-range locks on zero-length files.
                    if (!ReadFile(stream.SafeFileHandle.DangerousGetHandle(), new byte[1], 1, out _, IntPtr.Zero))
                    {
                        var code = Marshal.GetLastWin32Error();
                        if (code is 32 or 33) held.Add(Path.GetFileNameWithoutExtension(path));
                        else if (code is not 38) problems.Add("Cannot verify Codex writer ownership (Windows error " + code + ").");
                    }
                }
                catch (FileNotFoundException) { }
                catch (IOException ex) when ((ex.HResult & 0xffff) is 32 or 33) { held.Add(Path.GetFileNameWithoutExtension(path)); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                { problems.Add("Cannot verify a Codex writer lock: " + ex.Message); }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { problems.Add("Cannot scan Codex writer locks: " + ex.Message); }
        return new(held, problems);
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);

    public static void ReadHeader(LogState state)
    {
        if (state.MetadataRead) return;
        state.SessionId = SessionId(state.Path);
        try
        {
            using var stream = new FileStream(state.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var prefix = new byte[(int)Math.Min(stream.Length, 16384)];
            stream.ReadExactly(prefix);
            var newline = Array.IndexOf(prefix, (byte)'\n');
            var span = prefix.AsSpan(0, newline >= 0 ? newline : prefix.Length);
            if (span.StartsWith(new byte[] { 0xef, 0xbb, 0xbf })) span = span[3..];
            var reader = new Utf8JsonReader(span, isFinalBlock: false, state: default);
            string? outer = null;
            while (reader.Read())
            {
                if (reader.TokenType != JsonTokenType.PropertyName) continue;
                var depth = reader.CurrentDepth;
                var name = reader.GetString();
                if (depth == 1 && name == "type" && reader.Read())
                { outer = reader.GetString(); if (outer != "session_meta") break; }
                else if (outer == "session_meta" && depth == 2 && name == "id" && reader.Read() && reader.TokenType == JsonTokenType.String)
                    state.SessionId = reader.GetString() ?? state.SessionId;
                else if (outer == "session_meta" && depth == 3 && name == "subagent" && reader.Read())
                {
                    state.IsSubagent = true;
                    if (reader.TokenType == JsonTokenType.String && reader.GetString() == "memory_consolidation") state.IsInternal = true;
                }
                else if (outer == "session_meta" && name == "internal" && reader.Read() && reader.TokenType == JsonTokenType.String)
                    state.IsInternal = reader.GetString() is "guardian" or "memory_consolidation";
                else if (outer == "session_meta" && state.IsSubagent && name == "other" && reader.Read() && reader.TokenType == JsonTokenType.String)
                    state.IsInternal = reader.GetString() is "guardian" or "memory_consolidation";
                else if (outer == "session_meta" && state.IsSubagent && name == "memory_consolidation") state.IsInternal = true;
            }
            state.MetadataRead = true;
        }
        catch (JsonException) { state.MetadataRead = true; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { state.ReadError = ex.Message; }
    }
}
