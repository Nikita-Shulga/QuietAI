using System.Diagnostics;

namespace QuietAI.Core;

internal static class MacWriterLocks
{
    public static CodexLiveSessions.LeaseSnapshot Read(string folder)
    {
        var held = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var problems = new List<string>();
        try
        {
            var start = new ProcessStartInfo("/usr/sbin/lsof") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            foreach (var arg in new[] { "-n", "-P", "-F", "fln", "+D", folder }) start.ArgumentList.Add(arg);
            using var process = Process.Start(start)!;
            var outputTask = process.StandardOutput.ReadToEndAsync();
            var errorTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(5000)) { process.Kill(); return new(held, ["macOS writer ownership inspection timed out."]); }
            var output = outputTask.GetAwaiter().GetResult();
            var error = errorTask.GetAwaiter().GetResult();
            if (process.ExitCode is not 0 and not 1 || !string.IsNullOrWhiteSpace(error))
                problems.Add("macOS could not fully inspect Codex writer locks. Check folder access permissions.");
            // lsof's field output associates lock state with an open file descriptor.
            // Query only: never acquire a lock which could interfere with Codex.
            string? file = null, lockState = null;
            void Flush()
            {
                if (file is null || Path.GetFileName(file) == ".coordination.lock" || !file.EndsWith(".lock", StringComparison.Ordinal)) return;
                if (lockState is "W" or "w" or "u") held.Add(Path.GetFileNameWithoutExtension(file));
                else problems.Add("A Codex writer file is open but its exclusive lock cannot be verified on this Mac.");
            }
            foreach (var line in output.Split('\n'))
            {
                if (line.Length == 0) continue;
                if (line[0] is 'f' or 'p') { Flush(); file = lockState = null; }
                else if (line[0] == 'l') lockState = line[1..].Trim();
                else if (line[0] == 'n') file = line[1..];
            }
            Flush();
        }
        catch (Exception ex) when (ex is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        { problems.Add("macOS writer inspection is unavailable: " + ex.Message); }
        return new(held, problems.Distinct().ToArray());
    }
}
