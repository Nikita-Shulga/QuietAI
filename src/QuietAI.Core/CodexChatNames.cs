using System.Runtime.InteropServices;

namespace QuietAI.Core;

// Windows ships this SQLite library. Open read-only and read chat labels only;
// a label lookup failure never changes the completion decision.
internal static class CodexChatNames
{
    static CodexChatNames()
    {
        NativeLibrary.SetDllImportResolver(typeof(CodexChatNames).Assembly, (name, assembly, searchPath) =>
            name == "winsqlite3.dll" && OperatingSystem.IsMacOS() ? NativeLibrary.Load("/usr/lib/libsqlite3.dylib") : IntPtr.Zero);
    }
    public static IReadOnlyDictionary<string, string> Read(string sessions)
    {
        var result = new Dictionary<string, string>();
        var home = Environment.GetEnvironmentVariable("CODEX_SQLITE_HOME");
        if (string.IsNullOrWhiteSpace(home)) home = CodexLiveSessions.Home(sessions);
        var path = Path.Combine(home, "state_5.sqlite");
        if (!File.Exists(path)) return result;
        IntPtr database = IntPtr.Zero, statement = IntPtr.Zero;
        try
        {
            if (sqlite3_open_v2(path, out database, 1, IntPtr.Zero) != 0) return result;
            sqlite3_busy_timeout(database, 100);
            var query = "SELECT id, COALESCE(NULLIF(name, ''), title) FROM threads WHERE archived = 0";
            if (sqlite3_prepare_v2(database, query, -1, out statement, IntPtr.Zero) != 0) return result;
            while (sqlite3_step(statement) == 100)
            {
                var id = Marshal.PtrToStringUTF8(sqlite3_column_text(statement, 0));
                var title = Marshal.PtrToStringUTF8(sqlite3_column_text(statement, 1));
                if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(title)) result[id] = title;
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException) { }
        finally { if (statement != IntPtr.Zero) sqlite3_finalize(statement); if (database != IntPtr.Zero) sqlite3_close(database); }
        return result;
    }
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_open_v2([MarshalAs(UnmanagedType.LPUTF8Str)] string file, out IntPtr database, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_busy_timeout(IntPtr database, int milliseconds);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_prepare_v2(IntPtr database, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, int length, out IntPtr statement, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_step(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_finalize(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_close(IntPtr database);
}
