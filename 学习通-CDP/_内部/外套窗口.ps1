# hide-outer-window.ps1 -- keep the self-healing wrapper console out of the user's way.
#
# Why this exists (2026-10-11):
#   The wrapper script (the .cmd that keeps auto-restarting driver.js) lives in its own
#   console window. Two problems, both observed on a real machine:
#     1. The window is meant to sit minimized in the taskbar. We do not want to depend on
#        `start /min` alone -- if it ever ends up on the desktop the user sees an
#        unexplained black box with no way to tell what it is.
#     2. `HKCU\Console\QuickEdit` is 1 on this machine. A single left-click inside such a
#        window puts conhost into "Select" mode: output freezes, the keyboard is eaten,
#        and conhost prefixes the window title with a Chinese word meaning "Select".
#        It *looks* like a dead window even though the wrapper is running perfectly.
#
# What this does:
#   * Disables QuickEdit for THIS console only (SetConsoleMode on our own input handle).
#     It never writes HKCU\Console, so the user's own console windows stay untouched.
#   * Minimizes THIS console window (ShowWindow SW_MINIMIZE). It stays in the taskbar,
#     so anything the wrapper prints (e.g. the "cannot find node.exe" error) can still be
#     read by restoring it -- we only stop it from covering the desktop by default.
#
# Scope guarantee: GetConsoleWindow() returns the *shared* conhost window of the cmd.exe
# that invoked us, which is exactly the wrapper's window and nothing else. Verified on
# this machine: the HWND reported here matched the HWND seen by an external enumerator.
#
# Failure is not fatal: the caller deliberately ignores our exit code. If any API call
# fails we just leave the window alone -- the wrapper must keep running either way.
#
# Exit code: 0 always (informational only; callers must never gate on it).
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files as ANSI,
# so any non-ASCII byte here can corrupt parsing (this has bitten us before).
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -Namespace OuterWin -Name Api -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
'@ | Out-Null

# STD_INPUT_HANDLE = -10 ; ENABLE_QUICK_EDIT_MODE = 0x0040
$in = [OuterWin.Api]::GetStdHandle(-10)
$mode = 0
if ([OuterWin.Api]::GetConsoleMode($in, [ref]$mode)) {
  [void][OuterWin.Api]::SetConsoleMode($in, ($mode -band (-bnot 0x40)))
}

# SW_MINIMIZE = 6
$win = [OuterWin.Api]::GetConsoleWindow()
if ($win -ne [IntPtr]::Zero) { [void][OuterWin.Api]::ShowWindow($win, 6) }

exit 0
