param([int]$ParentPid = 0, [switch]$Probe, [switch]$NoDisplay, [switch]$NoPulse, [int]$PulseSeconds = 45)

# 运行期间阻止系统睡眠。
#
# 为什么必须连显示器一起保活（2026-10-12 实测结论）：
#   本机 powercfg /a 显示只有「S0 低电量待机(Modern Standby)」，S3 被 Device Guard 禁用。
#   在 S0 机型上，只申请 ES_SYSTEM_REQUIRED 是拦不住入睡的 ——
#   13:43:57 挂锁，14:01:21 系统仍以「进入新型待机状态 原因: Idle Timeout」睡了,
#   一直到 15:52:28 才被鼠标唤醒（Kernel-Power 506/507，可复查）。
#   Modern Standby 的触发前提是「显示器先关闭」，所以把显示器一起钉住，
#   待机就没有入口。代价是屏幕全程亮着，笔记本上更耗电。
#   要退回旧的只防睡眠行为：加 -NoDisplay。
#
# 请求挂在"本进程"上，所以本进程一退出就自动解除 —— 不改任何电源设置。

Add-Type -Namespace KW -Name N -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern uint SetThreadExecutionState(uint esFlags);
"@ | Out-Null

# ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x00000001) | ES_DISPLAY_REQUIRED(0x00000002)
$flags = [uint32]((0x80000000L) -bor 1L)
if (-not $NoDisplay) { $flags = [uint32]($flags -bor 2L) }

$prev = [KW.N]::SetThreadExecutionState($flags)

# 【定时"脉冲"按键 · 2026-10-23 加固】
# 为什么还要这个：本机是 S0（Modern Standby），SetThreadExecutionState 只能申请"别睡"，
# 但系统照样会在**没有用户输入**时以 Idle Timeout 进入新型待机 —— 10-12 那次
# 13:43 挂上请求、14:01 还是睡了就是证据。
# 这里每 PulseSeconds 秒按一次 F15（Windows 的保留功能键，没有任何程序会响应、
# 不会往任何输入框里打字），只是让系统看到"有输入" → Idle 计时器归零。
# 等价于你偶尔动一下鼠标，但不会真的移动光标、不打断你正在做的事。
if (-not $NoPulse) {
    Add-Type -Namespace KBP -Name N -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.IntPtr dwExtraInfo);
"@ | Out-Null
}

if ($Probe) {
    Write-Output ('SetThreadExecutionState(' + $flags + ') 返回 ' + $prev + '   ' +
        $(if ($prev -eq 0) { '失败' } else { '成功（非 0 即成功）' }) +
        '   F15 脉冲: ' + $(if ($NoPulse) { '关' } else { '开（每 ' + $PulseSeconds + ' 秒）' }))
    exit 0
}

if ($prev -eq 0) { exit 1 }

# 父进程还在就继续挂着；父进程一没，本进程退出，请求自动解除
$tick = 0
while ($true) {
    Start-Sleep -Seconds 5
    if ($ParentPid -gt 0) {
        $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        if (-not $p) { break }
    }
    if (-not $NoPulse) {
        $tick += 5
        if ($tick -ge [Math]::Max(20, $PulseSeconds)) {
            $tick = 0
            try {
                [KBP.N]::keybd_event(0x7E, 0, 0, [IntPtr]::Zero)   # VK_F15 down
                [KBP.N]::keybd_event(0x7E, 0, 2, [IntPtr]::Zero)   # up
            } catch { }
        }
    }
}

# 主动清除（其实进程退出也会清）
[void][KW.N]::SetThreadExecutionState([uint32](0x80000000L))