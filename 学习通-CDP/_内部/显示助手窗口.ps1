# show-assistant-window.ps1 -- reveal the assistant's own Edge window.
#
# Why this exists:
#   The launcher spawns Edge detached (with a hidden helper window). In practice the
#   browser process and pages come up fine, the driver runs, and yet the main window
#   is HIDDEN (IsWindowVisible = False) -- the user sees nothing on screen and has to
#   ask "where is the course page?". This script finds the browser window that
#   belongs to the assistant's own profile (looked up by the PID in the ownership
#   record) and makes it visible, centered on the working area, and raised.
#
# It only ever touches windows whose PID is in the ownership record / matches the
# assistant profile command line. The user's own Edge is never touched.
# (Authoring rule: this file stays pure ASCII -- PowerShell 5.1 reads BOM-less UTF-8
#   as ANSI, which corrupts Chinese text and causes parse errors. Every script under
#   the internal dir follows this; see the comments in the test-runner .cmd script.)
#
# Exit code: 0 = at least one window was made visible; 1 = not found / browser not up.
# Last output line is a machine-readable status.

$ErrorActionPreference = 'SilentlyContinue'

$proj = Split-Path -Parent $PSScriptRoot          # parent of the internal dir = project root

# [Never put any Chinese literal inside this script]
# PowerShell 5.1 decodes BOM-less UTF-8 as ANSI, so Chinese file names / wildcards get
# corrupted, and a file that plainly exists still reports NO_OWNER_FILE (hit twice live).
# So identify the file BY CONTENT instead: walk the json files under the project root and
# whichever one contains msedge.exe is the ownership record.
# This also tolerates future file names that carry a batch suffix.
$own = $null; $rec = $null
foreach ($f in (Get-ChildItem -Path $proj -Filter '*.json' -File | Sort-Object LastWriteTime -Descending)) {
  try { $o = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
  if ($o -and $o.exe -like '*msedge.exe' -and $o.pid) { $own = $f.FullName; $rec = $o; break }
}
if (-not $rec) { Write-Output 'NO_OWNER_FILE'; exit 1 }
$script:pid0 = [int]$rec.pid
if ($script:pid0 -le 0) { Write-Output 'NO_PID'; exit 1 }

Add-Type -Namespace AsstWin -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
'@

# Collect the PIDs of every msedge process that carries our profile + debug port.
# The main browser window can hang off any of them, so we match against the whole set.
$script:edges = @()
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if ($cl -and ($cl -like '*Edge\User*') -and ($cl -like '*remote-debugging-port=9222*')) {
    $script:edges += [int]$_.ProcessId
  }
}
# [2026-10-11] One "not found" is not proof that the browser is absent.
# Get-CimInstance can hand back a slightly stale process table right after a cold start,
# and this script is also meant to be runnable by hand for diagnostics -- so wait a
# little (max 10s) before concluding. Each round rebuilds the list from scratch, so PIDs
# never accumulate. The caller now invokes us only after the debug port is up, so this
# loop is a safety net, not the normal path.
if ($script:edges.Count -eq 0) {
  for ($w = 0; $w -lt 20 -and $script:edges.Count -eq 0; $w++) {
    Start-Sleep -Milliseconds 500
    $script:edges = @()
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object {
      $cl = $_.CommandLine
      if ($cl -and ($cl -like '*Edge\User*') -and ($cl -like '*remote-debugging-port=9222*')) {
        $script:edges += [int]$_.ProcessId
      }
    }
  }
}
if ($script:edges.Count -eq 0) { Write-Output 'NO_EDGE_PROCESS'; exit 1 }

# [scope] A function body cannot see script-level locals; everything must go through
# $script: -- otherwise pid0 reads as $null inside the callback and nothing matches.
function Get-OwnedWindows {
  $script:acc = @()
  $cb = [AsstWin.Api+EnumWindowsProc] {
    param($h, $l)
    $p = 0
    [void][AsstWin.Api]::GetWindowThreadProcessId($h, [ref]$p)
    if ([int]$p -eq $script:pid0 -or ($script:edges -contains [int]$p)) {
      if ([AsstWin.Api]::GetWindowTextLength($h) -gt 0) { $script:acc += $h }
    }
    return $true
  }
  [void][AsstWin.Api]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:acc
}

# Wait for the window to appear (cold start: window comes after the process).
$chosen = [IntPtr]::Zero
for ($i = 0; $i -lt 20; $i++) {
  foreach ($h in (Get-OwnedWindows)) {
    $r = New-Object AsstWin.Api+RECT
    [void][AsstWin.Api]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $ht = $r.B - $r.T
    # Main window test: big enough. Skips toolbars / IME / helper windows.
    if ($w -gt 400 -and $ht -gt 300) { $chosen = $h; break }
  }
  if ($chosen -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 400
}
if ($chosen -eq [IntPtr]::Zero) { Write-Output 'NO_MAIN_WINDOW'; exit 1 }

# [2026-10-11] The launcher no longer starts the browser with its window hidden
# (runtime-processes.js: the windowsHide flag was removed after an A/B test proved it was
# the cause). So the normal case now is "already on screen, exactly where the browser put it".
#
# In that case do NOT resize or move it. Forcing SW_RESTORE + SetWindowPos on every start
# would stomp on --window-size and on whatever size the user set by hand, and they would see
# the window jump every single time they hit "start". Just bring it forward -- they did
# literally ask to see it.
$isVisible = [AsstWin.Api]::IsWindowVisible($chosen)
$isIconic = [AsstWin.Api]::IsIconic($chosen)

if ($isVisible -and -not $isIconic) {
  [void][AsstWin.Api]::BringWindowToTop($chosen)
  [void][AsstWin.Api]::SetForegroundWindow($chosen)
  Write-Output ('SHOWN pid=' + $script:pid0 + ' hwnd=' + $chosen + ' kept-as-is')
  exit 0
}

# Hidden or minimized: this is the fallback path the script was originally written for.
# Restore it and center it on the primary working area (does not touch display settings).
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = [int]($wa.Width * 0.92); $h = [int]($wa.Height * 0.9)
$x = $wa.X + [int](($wa.Width - $w) / 2); $y = $wa.Y + [int](($wa.Height - $h) / 2)

[void][AsstWin.Api]::ShowWindow($chosen, 9)                                          # SW_RESTORE
[void][AsstWin.Api]::SetWindowPos($chosen, [IntPtr]::Zero, $x, $y, $w, $h, 0x0040)   # SWP_SHOWWINDOW
[void][AsstWin.Api]::BringWindowToTop($chosen)
[void][AsstWin.Api]::SetForegroundWindow($chosen)
Start-Sleep -Milliseconds 300
[void][AsstWin.Api]::SetForegroundWindow($chosen)

if ([AsstWin.Api]::IsWindowVisible($chosen)) { Write-Output ('SHOWN pid=' + $script:pid0 + ' hwnd=' + $chosen); exit 0 }
Write-Output 'STILL_HIDDEN'; exit 1
