# Quiet AI: starts the update hand-over (apply-update.ps1) so that it outlives the app (Windows).
# Quiet AI runs inside a Windows job object that ends its child processes when it quits, and
# PowerShell started "detached" from the app exits without running (both measured in October 2026).
# So this short-lived helper relaunches the hand-over with CREATE_BREAKAWAY_FROM_JOB and reports
# whether that worked: exit code 0 = started; anything else = not started (the app stays open).
param([string]$Script,[int]$ProcessId,[string]$Source,[string]$Target,[string]$Log)
$ErrorActionPreference='Stop'
try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class QuietAIBreakaway {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Start(string app, string cmd, string dir) {
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); PROCESS_INFORMATION pi;
    // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW
    if (!CreateProcess(app, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, dir, ref si, out pi)) return Marshal.GetLastWin32Error();
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return 0;
  }
}
'@
  $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $cmd = "`"$shell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`" -ProcessId $ProcessId -Source `"$Source`" -Target `"$Target`" -Log `"$Log`""
  # Run it from the app folder, not its own temporary folder, so that folder can be deleted afterwards.
  $err = [QuietAIBreakaway]::Start($shell, $cmd, $Target)
  if ($err -ne 0) { [Console]::Out.WriteLine("CreateProcess failed with Windows error $err"); exit 2 }
  exit 0
} catch { [Console]::Out.WriteLine($_.Exception.Message); exit 1 }
