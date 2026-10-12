# 随时手动解锁：双击运行或 `pwsh -File 停止保持唤醒.ps1`
# 只杀挂着「保持唤醒.ps1」（不带 -Probe）的进程，不碰别的 pwsh 窗口。

$hit = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*保持唤醒.ps1*' -and $_.CommandLine -notlike '*-Probe*' }

if (-not $hit) {
    Write-Host '当前没有在跑的睡眠锁。'
    exit 0
}

foreach ($p in $hit) {
    Write-Host ('解锁 pid ' + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 300
$left = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*保持唤醒.ps1*' -and $_.CommandLine -notlike '*-Probe*' }

if ($left) { Write-Host '还有残留，请再运行一次。' }
else { Write-Host '已解除，系统恢复正常的睡眠策略。' }
