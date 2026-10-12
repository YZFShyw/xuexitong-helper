# 学习通助手 · 控制台
#
# 一个入口管全部：开始 / 停止 / 看进度 / 答题助手设置（含 API key）/ 解码乱码 / 自检。
#
# 用法：
#   双击 控制台.cmd
#   或者在别处这样只打开设置那一屏：  powershell -File 控制台.ps1 -Menu 设置
#
# ------------------------------------------------------------------
# 设计上的两个取舍：
#
# 1. 开始.cmd / 停止.cmd 是用"开新窗口"的方式调用的，不是在本窗口里跑。
#    原因是这两个脚本里都有 chcp 936。cmd 的 chcp 是改整个控制台的代码页的，
#    它们在自己窗口里跑完关掉没事；但如果在控制台这个窗口里跑，
#    跑完之后我这个窗口的代码页就变成 936 了，
#    而 PowerShell 是按 UTF-8 往外写中文的 —— 后面所有中文都会变成乱码。
#    开新窗口既躲开这个问题，也顺便让它们的 pause 提示出现在自己那边。
#
# 2. 写配置一律通过 node 配置.js，控制台自己不动 答题设置.json。
#    这样"谁写配置文件"只有一个答案。要是控制台也自己改 JSON，
#    就会出现「界面显示 mode 1、驱动器却读到 mode 0」这类问题
#    （这个坑在 BOM 那件事上已经吃过一次了）。
#
# 坑：
#   1. 控制台.cmd 里是 chcp 65001，本文件是 UTF-8 带 BOM。
#      两边要配套：代码页 65001 才能正确显示 UTF-8 中文。
#
#   2. 捕获 node 的输出之前，必须把 [Console]::OutputEncoding 设成 UTF-8。
#      node 永远输出 UTF-8 字节；如果 PS 还按 936 去解码这个管道，
#      拿回来的中文就是乱码。
#
#   3. 这段脚本用编辑器改过之后要补 UTF-8 BOM，
#      否则 PowerShell 5.1 会按 GBK 解，中文全乱。

param(
    [string]$Menu = ''
)

$ErrorActionPreference = 'Continue'

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$driver = Join-Path $here 'driver.js'
$cfgJs = Join-Path $here '配置.js'
$decoder = Join-Path $here '解乱码.js'
$pidFile = Join-Path $here '运行中.pid'
$logFile = Join-Path $here '运行日志.txt'
$hbFile = Join-Path $here '_内部\伪心跳开关.txt'

# node 的输出是 UTF-8，管道的解码方式要跟它一致
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

function Pause-Any([string]$msg = '按回车继续') {
    [void](Read-Host ("  " + $msg))
}

# ---------- 找 node ----------
# 优先用包里自带的那份：node\node.exe（分发包里带了就一定有，别人不用自己装）。
# 没有才退回去用系统 PATH 里的 node。
function Get-NodeExe {
    $bundled = Join-Path $here 'node\node.exe'
    if (Test-Path $bundled) { return $bundled }
    return 'node'
}

# ---------- node 检查 ----------
# 为什么要有这一段：这个助手的主体就是 driver.js / 答题助手.js 两个 JavaScript 文件，
# 全靠 node 来跑。分发包里带了一份便携的 node\node.exe（所以别人不用自己装），
# 万一没有那份，就退回用系统 PATH 里的 node（下面这段就是判断这种情况）。
# 别人电脑上没装、或者装的是很老的版本（14/16），会看到一堆看不懂的报错 ——
# 比如 "fetch is not defined"（node 18 才有内置 fetch）或者莫名其妙的语法错误。
# 所以干脆在开菜单之前先问一句，缺了/太旧就直接说人话。
# 实际探测 fetch、WebSocket 和 AbortController，避免只看版本号误判可用。
$script:NodeOk = $false
function Test-Node {
    $v = ''
    try { $v = (& (Get-NodeExe) -v 2>&1 | Out-String).Trim() } catch { $v = '' }
    if (-not $v -or $v -notmatch '^v(\d+)\.') {
        Write-Host ''
        Write-Host '  ============================================================' -ForegroundColor Red
        Write-Host '   没找到 node —— 这个助手跑不起来' -ForegroundColor Red
        Write-Host '  ============================================================' -ForegroundColor Red
        Write-Host ''
        Write-Host '   这个助手是用 JavaScript 写的，需要一个叫 Node.js 的程序来跑它。'
        Write-Host '   它跟你平时用的浏览器、Office 是两回事，得单独装一次。'
        Write-Host ''
        Write-Host '   怎么装（装一次就行，以后不用再管）：'
        Write-Host '     1. 打开  https://nodejs.org/zh-cn' -ForegroundColor Yellow
        Write-Host '     2. 点左边那个大按钮下载「LTS」版（长期支持版，最稳）' -ForegroundColor Yellow
        Write-Host '     3. 双击下载的安装包，一路点「下一步」（默认选项就行，不用改）' -ForegroundColor Yellow
        Write-Host '     4. 装完**把这个黑窗口关掉，重新双击 控制台.cmd**' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '   怎么确认装好了：按 Win+R，输入 cmd 回车，在黑窗口里敲  node -v'
        Write-Host '   看到一个版本号（例如 v22.11.0）就算好了。'
        Write-Host ''
        Write-Host '   注意：需要内置 fetch、WebSocket 和 AbortController，建议安装当前 LTS。'
        Write-Host ''
        return $false
    }
    $capabilityOk = $false
    $probe = "process.exit(typeof fetch === 'function' && typeof WebSocket === 'function' && typeof AbortController === 'function' ? 0 : 1)"
    try {
        & (Get-NodeExe) -e $probe 2>$null | Out-Null
        $capabilityOk = ($LASTEXITCODE -eq 0)
    } catch { $capabilityOk = $false }
    if (-not $capabilityOk) {
        Write-Host ''
        Write-Host '  ============================================================' -ForegroundColor Red
        Write-Host ('   node 功能检查未通过：' + $v + '（缺少必要的内置功能）') -ForegroundColor Red
        Write-Host '  ============================================================' -ForegroundColor Red
        Write-Host ''
        Write-Host '   需要 fetch、WebSocket 和 AbortController；请使用具备这些功能的 Node.js。'
        Write-Host ''
        Write-Host '   怎么办：打开 https://nodejs.org/zh-cn 下 LTS 版重装一遍，' -ForegroundColor Yellow
        Write-Host '           装完关掉黑窗口、重新双击 控制台.cmd。' -ForegroundColor Yellow
        Write-Host '           （直接装就行，新版本会覆盖旧的，不用先卸载）'
        Write-Host ''
        return $false
    }
    Write-Host ''
    Write-Host ('  node ' + $v + '  OK') -ForegroundColor DarkGray
    return $true
}

# ---------- 读状态 ----------
function Get-Cfg {
    $p = Join-Path $here '答题设置.json'
    # 这里的字段表要跟 答题助手.js 的 DEFAULT_CFG 保持一致。
    # 少写一个就会出现"控制台显示空、驱动器却有值"这种不一致。
    $def = [pscustomobject]@{
        mode = 0; apiKey = ''; model = 'deepseek-flash'; maxPerChapter = 30
        stopAtQuiz = $false; readMode = 'auto'; visionModel = 'deepseek-flash'
        autoFill = $false; maxShots = 3
    }
    if (-not (Test-Path $p)) { return $def }
    try {
        $raw = (Get-Content -Raw -Encoding UTF8 $p) -replace '^\uFEFF', ''
        if (-not $raw.Trim()) { return $def }
        $j = $raw | ConvertFrom-Json
        foreach ($k in @('mode', 'apiKey', 'model', 'maxPerChapter', 'stopAtQuiz', 'readMode', 'visionModel', 'autoFill', 'maxShots')) {
            if ($null -eq $j.PSObject.Properties[$k]) { $j | Add-Member -NotePropertyName $k -NotePropertyValue $def.$k }
        }
        return $j
    } catch { return $def }
}

function Get-Port {
    try {
        return (Invoke-RestMethod 'http://127.0.0.1:9222/json/version' -TimeoutSec 2).Browser
    } catch { return $null }
}

function Get-DriverPid {
    # 【驱动器判活（2026-10-11 重做）】
    # 旧写法只做两件事：读 运行中.pid、Get-Process 看那个 PID 在不在。
    # 两个真事故：
    #   ① 驱动器被强杀/崩溃时 pid 文件残留，Windows 把 PID 回收给别的程序之后，
    #      控制台会显示"驱动器正在跑 PID 1234"，其实那是别人的进程；
    #      「停止」还会 taskkill /f 一个完全无关的进程。
    #   ② 只凭 PID 活着就认定"驱动器在跑"，等于把"能不能启动"交给运气。
    # 现在统一走 runtime-processes.js：PID + 创建时间 + node 映像 + 命令行里的
    # **完整 driver.js 路径**四样全对上，才叫"在跑"。拿不到答案就说"说不清"，
    # 控制台会照实显示，不再猜。
    $v = Get-VerifiedDriverInfo
    if ($null -ne $v) {
        if ($v.alive) { return $v.pid }
        return $null
    }
    # 拿不到结构化结论（模块/环境有问题）时退回旧写法，但只在"看起来是 node"时才认。
    if (-not (Test-Path $pidFile)) { return $null }
    $raw = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue)
    if (-not $raw) { return $null }
    $t = $raw.Trim()
    if ($t -notmatch '^\d+$') { return $null }
    $p = Get-Process -Id ([int]$t) -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { return $t }
    return $null
}

# ---------- 驱动器判活（走共享模块，带缓存） ----------
# 为什么加缓存：Show-Status 每轮菜单都会问一次，每次都起一个 node 去查进程表太浪费。
# 缓存只用于**显示**；停止/杀进程一律重新实时查（stopVerifiedDriver 自己会重查）。
$script:DrvCache = $null
$script:DrvCacheAt = [datetime]::MinValue

function Invoke-RuntimeProcesses([string[]]$NodeArgs) {
    $mod = Join-Path $here 'runtime-processes.js'
    if (-not (Test-Path $mod)) { return $null }
    try {
        $out = (& (Get-NodeExe) $mod @NodeArgs 2>&1 | Out-String)
        $line = ($out -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
        if (-not $line) { return $null }
        return ($line | ConvertFrom-Json)
    } catch { return $null }
}

function Get-VerifiedDriverInfo([switch]$NoCache) {
    if (-not $NoCache -and $script:DrvCache -and ((Get-Date) - $script:DrvCacheAt).TotalSeconds -lt 3) {
        return $script:DrvCache
    }
    $r = Invoke-RuntimeProcesses @('--status', '--base', $here)
    if ($null -ne $r) {
        $script:DrvCache = $r
        $script:DrvCacheAt = Get-Date
    }
    return $r
}

function Stop-VerifiedDriver {
    # 走共享模块停驱动器：身份验证不过就**什么都不杀**。
    # 返回 @{ Ok=..; Killed=..; Reason=.. }，Ok=$true 表示"现在没有驱动器在跑了"
    # （停掉了，或者本来就没有 / 记录是陈旧的）。
    $r = Invoke-RuntimeProcesses @('--stop-driver', '--base', $here)
    $script:DrvCache = $null
    if ($null -eq $r) {
        Write-Host '  驱动器管理模块没给出结论（runtime-processes.js 起不来？）—— 改用系统停止流程。' -ForegroundColor Yellow
        return @{ Ok = $false; Killed = $false; Reason = '模块没给结论' }
    }
    $msg = ('  ' + [string]$r.reason)
    if ($r.killed) { Write-Host $msg -ForegroundColor Green }
    elseif ($r.ok) { Write-Host $msg -ForegroundColor DarkGray }
    else { Write-Host $msg -ForegroundColor Red }
    return @{ Ok = [bool]$r.ok; Killed = [bool]$r.killed; Reason = [string]$r.reason }
}

# ---------- 伪心跳 60 倍速 开关 ----------
# 开关就是一个文件：里面写的数字就是倍速，0（或文件不存在）= 关。
# 为什么用文件、而不是写在脚本里：驱动器是被 _内部\驱动器循环.cmd 拉起来的，
# 它读同一个文件 —— 这样控制台改了立刻生效，不用改代码、也不用重启控制台。
function Get-HbSpeed {
    if (-not (Test-Path $hbFile)) { return 0 }
    $v = Get-Content $hbFile -Raw -ErrorAction SilentlyContinue
    if (-not $v) { return 0 }
    $n = 0
    if ([int]::TryParse($v.Trim(), [ref]$n) -and $n -gt 1) { return $n }
    return 0
}
function Set-HbSpeed([int]$speed) {
    try {
        $dir = Split-Path -Parent $hbFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Set-Content -LiteralPath $hbFile -Value ([string]$speed) -Encoding ASCII
        return $true
    } catch { return $false }
}

function Mask-Key([string]$k) {
    if (-not $k) { return '(没配)' }
    if ($k.Length -le 12) { return $k.Substring(0, [Math]::Min(3, $k.Length)) + '…  (' + $k.Length + ' 位)' }
    return $k.Substring(0, 5) + '…' + $k.Substring($k.Length - 4) + '  (' + $k.Length + ' 位)'
}

$MODE_NAME = @('不做题（只放视频、翻节，测验一概不碰）', '记下题，不问 AI', '记下题 + 问 AI')

# 读题方式的显示名
function Read-ModeName([string]$m) {
    switch ($m) {
        'table' { return '只用解码表（快、免费；换字体就失效）' }
        'shot' { return '只用截图 + 看图模型（慢、要钱；不看字体）' }
        default { return '自动（表有效就用表，失效就截图）' }
    }
}

function Show-Status {
    $cfg = Get-Cfg
    $port = Get-Port
    $script:DrvInfo = Get-VerifiedDriverInfo
    $dp = Get-DriverPid

    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host '    学习通助手 · 控制台' -ForegroundColor Cyan
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host ''

    Write-Host '    调试端口   ' -NoNewline
    if ($port) { Write-Host ('在   ' + $port) -ForegroundColor Green }
    else { Write-Host '不在（开始的时候会自动开浏览器）' -ForegroundColor DarkGray }

    Write-Host '    驱动器     ' -NoNewline
    if ($dp) { Write-Host ('正在跑   PID ' + $dp) -ForegroundColor Green }
    elseif ($script:DrvInfo -and $script:DrvInfo.pid -and -not $script:DrvInfo.alive) {
        # 有记录、但记录里的进程不是驱动器（多半是强杀后留下的陈旧记录）——
        # 照实说清楚，免得用户对着"没在跑"却启动不了的情况猜。
        Write-Host ('没在跑（记录里的 PID ' + $script:DrvInfo.pid + ' 不是驱动器，已按陈旧处理）') -ForegroundColor DarkGray
    }
    else { Write-Host '没在跑' -ForegroundColor DarkGray }

    $m = [int]$cfg.mode
    $mn = if ($m -ge 0 -and $m -lt $MODE_NAME.Count) { $MODE_NAME[$m] } else { '未知' }
    Write-Host ('    答题助手   模式 ' + $m + ' —— ' + $mn)
    Write-Host ('               key ' + (Mask-Key ([string]$cfg.apiKey)) + '   模型 ' + $cfg.model)
    if ($m -eq 0) {
        # 不做题的时候，"测验停/不停""读题方式"这两项根本用不到。
        # 还照原样显示会自相矛盾（上面写着"测验一概不碰"，下面写着"记下题目"）。
        Write-Host '               测验     一概不碰（不看、不记、不问）'
    } else {
        Write-Host ('               测验     ' + $(if ($cfg.stopAtQuiz) { '测验停（一碰到就停下，等你填完）' } else { '测验不停（记下题目，继续往后跑）' }))
        Write-Host ('               读题     ' + (Read-ModeName $cfg.readMode))
        Write-Host ('               填答案   ' + $(if ($cfg.autoFill) { '开（只填，不交）' } else { '关' }))
    }

    $tab = Join-Path $here '_字体\对照表.json'
    Write-Host '    字体解码表 ' -NoNewline
    if (Test-Path $tab) {
        # 注意：.PSObject.Properties 本身没有 .Count，
        # 直接点 .Count 会触发 PowerShell 的"成员枚举"，把每个属性挨个取 .Count，
        # 结果打出来是 "1 1 1 1 …"。必须先包进 @() 变成数组再数。
        $n = 0
        try {
            $j = Get-Content -Raw -Encoding UTF8 $tab | ConvertFrom-Json
            $n = @($j.map.PSObject.Properties).Count
        } catch { }
        Write-Host ('已装（' + $n + ' 个替身字）') -ForegroundColor Green
    } else {
        Write-Host '缺失 —— 遇到混淆题目只能跳过' -ForegroundColor Yellow
    }
    Write-Host ''
}

function Show-Menu {
    Write-Host '  ------------------------------------------------------------'
    Write-Host '    1   开始 / 继续        需要时自动开浏览器'
    Write-Host '    2   停止'
    Write-Host '    3   看实时进度         另开一个窗口'
    Write-Host '    4   答题助手设置       ← API key 在这里填' -ForegroundColor Yellow
    Write-Host '    5   解码乱码           把 章节测验记录.txt 翻成真字'
    Write-Host '    6   环境自检           端口 / 解码表 / API key'
    Write-Host '    7   打开所在文件夹'
    Write-Host ('    8   伪心跳 60 倍速      ' + $(if ((Get-HbSpeed) -gt 1) { '现在：开（' + (Get-HbSpeed) + ' 倍速）' } else { '现在：关' }) + '  ← 不碰播放器倍速，替它上报进度') -ForegroundColor Yellow
    Write-Host '    0   退出'
    Write-Host '  ------------------------------------------------------------'
    Write-Host ''
    # 页脚就留一句（用户定的：别啰嗦）—— 问题和捐款都走这个邮箱。
    # 答题的 API 是使用者自己接的（key 自己填、钱自己花），不经过作者。
    Write-Host '   有问题或捐款请向 3975139018@qq.com 联系' -ForegroundColor Yellow
}

function Run-Node {
    param([string[]]$NodeArgs)
    & (Get-NodeExe) @NodeArgs 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
}

# ---------- 设置子菜单 ----------
function Show-Settings {
    while ($true) {
        Clear-Host
        $cfg = Get-Cfg
        Write-Host ''
        Write-Host '  ============================================================' -ForegroundColor Cyan
        Write-Host '    答题助手设置' -ForegroundColor Cyan
        Write-Host '  ============================================================' -ForegroundColor Cyan
        Write-Host ''
        Write-Host ('    现在：模式 ' + $cfg.mode + ' —— ' + $MODE_NAME[[int]$cfg.mode])
        Write-Host ('          key ' + (Mask-Key ([string]$cfg.apiKey)) + '   模型 ' + $cfg.model)
        Write-Host ''
        Write-Host '  ------------------------------------------------------------'
        Write-Host '  1   不做题' -ForegroundColor Yellow
        Write-Host '        只放视频、自动翻节。测验一概不碰 —— 不看、不记、不问。'
        Write-Host ''
        Write-Host '  2   记下题，不问 AI' -ForegroundColor Yellow
        Write-Host '        遇到测验把题目抄进 章节测验记录.txt，但不调 AI。'
        Write-Host ''
        Write-Host '  3   记下题 + 问 AI' -ForegroundColor Yellow
        Write-Host '        抄下来并让模型给答案和理由。需要先填 API key。'
        Write-Host ''
        Write-Host '  4   输入 / 更换 API key'
        Write-Host '  5   换模型'
        Write-Host ('  6   测验停 / 测验不停       现在：' + $(if ($cfg.stopAtQuiz) { '测验停' } else { '测验不停' }))
        Write-Host ('  7   每章最多问几题          现在：' + $cfg.maxPerChapter + ' 题')
        Write-Host '  8   看当前配置'
        Write-Host '  9   测试 key 能不能用（真的发一次请求）'
        Write-Host ' 10   清除 key'
        Write-Host (' 11   读题方式                现在：' + (Read-ModeName $cfg.readMode))
        Write-Host (' 12   自动填答案              现在：' + $(if ($cfg.autoFill) { '开（只填，不交）' } else { '关' })) -ForegroundColor Yellow
        Write-Host '  0   返回主菜单'
        Write-Host '  ------------------------------------------------------------'
        Write-Host ''
        $c = (Read-Host '  选一个').Trim()

        switch ($c) {
            '1' { Clear-Host; Run-Node @($cfgJs, '--set', 'mode=0'); Pause-Any }
            '2' { Clear-Host; Run-Node @($cfgJs, '--set', 'mode=1'); Pause-Any }
            '3' {
                Clear-Host
                $cc = Get-Cfg
                if (-not $cc.apiKey) {
                    Write-Host ''
                    Write-Host '  现在还没有 key，先把 key 填上。' -ForegroundColor Yellow
                    Write-Host '  （模式已经切到 3 了，但没 key 的话每道题只会写一句"跳过"）'
                    Write-Host ''
                }
                Run-Node @($cfgJs, '--set', 'mode=2')
                $cc2 = Get-Cfg
                Write-Host ''
                Write-Host '  说明：模式 3 会让驱动器把每道题发给 DeepSeek，' -ForegroundColor Gray
                Write-Host '        把「答案 + 一句理由」写进 章节测验记录.txt 和 运行日志.txt。' -ForegroundColor Gray
                # 【别再写死"不会替你填页面"】
                #   那句是"自动填答案"功能做出来之前的旧描述，跟实际行为相反 ——
                #   实测用户看完还在问"为什么控制台写的不填入答案"。
                #   现在照实说：填不填，取决于菜单 12 那个开关。
                if ($cc2.autoFill) {
                    Write-Host '        当前「自动填答案」是开着的：AI 出答案后会把选项直接点上（只填，不交）。' -ForegroundColor Green
                    Write-Host '        填空和简答不填（那要打字）；提交永远是你自己按。' -ForegroundColor Gray
                } else {
                    Write-Host '        当前「自动填答案」是关着的：只把答案写进日志和记录文件，页面一动不动。' -ForegroundColor Yellow
                    Write-Host '        想让驱动器顺手把选项点上，回上级菜单选 12 打开。' -ForegroundColor Gray
                    Write-Host '        （不管开关怎么样，提交都永远是你自己按。）' -ForegroundColor Gray
                }
                Pause-Any
            }
            '4' {
                Clear-Host
                Write-Host ''
                Write-Host '  粘贴 DeepSeek 的 API key（形如 sk-…………），回车保存。' -ForegroundColor Yellow
                Write-Host '  直接回车 = 不改。'
                Write-Host ''
                Write-Host '  注意：key 会用明文存在 答题设置.json 里（本机文件）。' -ForegroundColor DarkGray
                Write-Host '        不想落盘的话可以把 key 放进环境变量 DEEPSEEK_API_KEY，' -ForegroundColor DarkGray
                Write-Host '        配置文件留空时会自动用它。' -ForegroundColor DarkGray
                Write-Host ''
                $k = (Read-Host '  key').Trim()
                if ($k) {
                    Run-Node @($cfgJs, '--set', ('key=' + $k))
                    Write-Host ''
                    Write-Host '  顺手测一下这个 key 能不能用？' -ForegroundColor Gray
                    $t = (Read-Host '  测 (y/N)').Trim()
                    if ($t -match '^[yY]') { Clear-Host; Run-Node @($cfgJs, '--test') }
                } else {
                    Write-Host '  没输入，没改。'
                }
                Pause-Any
            }
            '5' {
                Clear-Host
                Write-Host ''
                Write-Host '  官方现在只有两个模型名：' -ForegroundColor Cyan
                Write-Host ''
                Write-Host '    deepseek-flash' -ForegroundColor Yellow
                Write-Host '        DeepSeek-V4.1-Flash。1M 上下文，支持看图，便宜。答题够用。'
                Write-Host ''
                Write-Host '    deepseek-v4-pro' -ForegroundColor Yellow
                Write-Host '        DeepSeek-V4-Pro。更强也更贵（输入约 4 倍价），不支持看图。'
                Write-Host ''
                Write-Host '  注意：旧的 deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用，' -ForegroundColor DarkGray
                Write-Host '        填这两个名字会直接报错。程序读到旧名字会自动换成 deepseek-flash。' -ForegroundColor DarkGray
                Write-Host ''
                Write-Host '  思考模式：一直开着，档位在代码里写死了 —— 答题用 max，截图抄录用 high。' -ForegroundColor DarkGray
                Write-Host '  （思考模式下 temperature 不生效，所以程序不传它；思维链算输出 token，会计费。）' -ForegroundColor DarkGray
                Write-Host ''
                $mv = (Read-Host ('  模型名（现在 ' + (Get-Cfg).model + '）')).Trim()
                if ($mv) { Run-Node @($cfgJs, '--set', ('model=' + $mv)) } else { Write-Host '  没输入，没改。' }
                Pause-Any
            }
            '6' {
                Clear-Host
                $cur = Get-Cfg
                Write-Host ''
                Write-Host '  遇到测验的时候，驱动器怎么办？' -ForegroundColor Cyan
                Write-Host ''
                Write-Host '    1   测验不停' -ForegroundColor Yellow
                Write-Host '          记下题目，继续往后面的章节跑。'
                Write-Host '          题目和答案都留在 章节测验记录.txt 里，你回头再看。'
                Write-Host ''
                Write-Host '    2   测验停' -ForegroundColor Yellow
                Write-Host '          一碰到测验就停下退出。你看完答案自己填、自己交，'
                Write-Host '          填完回控制台点 1 继续往后跑。'
                Write-Host ''
                Write-Host ('  现在：' + $(if ($cur.stopAtQuiz) { '测验停' } else { '测验不停' }))
                Write-Host ''
                $pick = (Read-Host '  选 1 或 2（别的键=不改）').Trim()
                if ($pick -eq '1') { Run-Node @($cfgJs, '--set', 'stopAtQuiz=0') }
                elseif ($pick -eq '2') { Run-Node @($cfgJs, '--set', 'stopAtQuiz=1') }
                else { Write-Host '  没改。' }
                Pause-Any
            }
            '7' {
                Clear-Host
                $mv = (Read-Host ('  每章最多问几题（现在 ' + (Get-Cfg).maxPerChapter + '）')).Trim()
                if ($mv -match '^\d+$') { Run-Node @($cfgJs, '--set', ('maxPerChapter=' + $mv)) } else { Write-Host '  要是正整数。' }
                Pause-Any
            }
            '8' { Clear-Host; Run-Node @($cfgJs); Pause-Any }
            '9' { Clear-Host; Run-Node @($cfgJs, '--test'); Pause-Any }
            '11' {
                Clear-Host
                $cur = Get-Cfg
                Write-Host ''
                Write-Host '  题目是怎么读出来的？' -ForegroundColor Cyan
                Write-Host ''
                Write-Host '  背景：学习通用 font-cxsecret 字体做过反爬 —— 网页里存的是替身字'
                Write-Host '        （"从法律" 在网页里存成 "庘庝律"），屏幕上看着是对的，'
                Write-Host '        直接读 DOM 是乱码。所以题目有两种读法：'
                Write-Host ''
                Write-Host '    1   自动（推荐）' -ForegroundColor Yellow
                Write-Host '          先拿页面上的字体跟本地解码表对指纹。没变就用表（快、免费）；'
                Write-Host '          变了、或者本地根本没表，就自动改用截图读题。'
                Write-Host ''
                Write-Host '    2   只用解码表' -ForegroundColor Yellow
                Write-Host '          字符串替换，快、免费、零误差。'
                Write-Host '          缺点：只在这支持定字体有效，对方一换字体整张表作废。'
                Write-Host ''
                Write-Host '    3   只用截图 + 看图模型' -ForegroundColor Yellow
                Write-Host ('          不依赖字体，对方怎么换都拦不住，题目是图片也能读。')
                Write-Host ('          缺点：慢一点，每次要多花 API 费用（用的模型：' + $cur.visionModel + '）。')
                Write-Host ''
                Write-Host ('  现在：' + (Read-ModeName $cur.readMode))
                Write-Host ''
                $pick = (Read-Host '  选 1 / 2 / 3（别的键=不改）').Trim()
                if ($pick -eq '1') { Run-Node @($cfgJs, '--set', 'readMode=auto') }
                elseif ($pick -eq '2') { Run-Node @($cfgJs, '--set', 'readMode=table') }
                elseif ($pick -eq '3') { Run-Node @($cfgJs, '--set', 'readMode=shot') }
                else { Write-Host '  没改。' }
                Pause-Any
            }
            '10' {
                Clear-Host
                Run-Node @($cfgJs, '--clear-key')
                Pause-Any
            }
            '12' {
                Clear-Host
                $cur = Get-Cfg
                Write-Host ''
                Write-Host '  要不要把 AI 给的答案自动填进页面？' -ForegroundColor Cyan
                Write-Host ''
                Write-Host '    1   开' -ForegroundColor Yellow
                Write-Host '        遇到测验、AI 给出答案后，自动把对应的选项点上。'
                Write-Host '        单选 / 多选 / 判断会填；填空和简答不填（那要打字）。'
                Write-Host ''
                Write-Host '    0   关'
                Write-Host '        只在日志和记录文件里给答案，页面一动不动，你自己点。'
                Write-Host ''
                Write-Host '  ── 不管开不开，都不会替你提交 ──' -ForegroundColor Yellow
                Write-Host '  代码里没有任何点提交按钮的逻辑，提交永远由你自己按。' -ForegroundColor Gray
                Write-Host '  填完请自己过一眼再交 —— 模型给的答案没有经过验证。' -ForegroundColor Gray
                Write-Host ''
                Write-Host ('  现在：' + $(if ($cur.autoFill) { '开（只填，不交）' } else { '关' }))
                Write-Host ''
                $pick = (Read-Host '  选 1 或 0（别的键=不改）').Trim()
                if ($pick -eq '1') { Run-Node @($cfgJs, '--set', 'autoFill=1') }
                elseif ($pick -eq '0') { Run-Node @($cfgJs, '--set', 'autoFill=0') }
                else { Write-Host '  没改。' }
                Pause-Any
            }
            '0' { return }
            default { }
        }
    }
}

# ---------- 自检 ----------
function Do-SelfCheck {
    Clear-Host
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host '    环境自检' -ForegroundColor Cyan
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host ''

    Write-Host '  [1] node'
    $nv = (& (Get-NodeExe) --version 2>&1)
    Write-Host ('      ' + $nv)

    Write-Host '  [2] 脚本语法'
    foreach ($f in @($driver, (Join-Path $here '答题助手.js'), $cfgJs,
                     (Join-Path $here 'runtime-processes.js'), (Join-Path $here 'driver-checkpoint.js'))) {
        & (Get-NodeExe) --check $f 2>&1 | Out-Null
        Write-Host ('      ' + $(if ($LASTEXITCODE -eq 0) { '正常  ' } else { '有错！' }) + ' ' + (Split-Path -Leaf $f))
    }

    Write-Host '  [3] 浏览器调试端口'
    $port = Get-Port
    Write-Host ('      ' + $(if ($port) { '在   ' + $port } else { '不在（正常 —— 点"开始"会开）' }))

    Write-Host '  [4] 字体反爬对照表'
    Run-Node @($cfgJs, '--table')

    Write-Host '  [5] 驱动器'
    $dp = Get-DriverPid
    if ($dp) {
        Write-Host ('      正在跑 PID ' + $dp + '（身份已验证：node + 创建时间 + driver.js 完整路径）') -ForegroundColor Green
    } else {
        $v = Get-VerifiedDriverInfo -NoCache
        if ($v -and $v.pid -and -not $v.alive) {
            Write-Host ('      没在跑（记录里的 PID ' + $v.pid + ' 不是驱动器：' + $v.reason + '）') -ForegroundColor DarkGray
        } else {
            Write-Host '      没在跑' -ForegroundColor DarkGray
        }
    }

    Write-Host '  [6] API key'
    $cfg = Get-Cfg
    $envKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
    if ($cfg.apiKey) {
        Write-Host ('      配置里有：' + (Mask-Key ([string]$cfg.apiKey)))
        Write-Host ''
        $t = (Read-Host '  现在真的发一次请求测测它？(Y/n)').Trim()
        if ($t -notmatch '^[nN]') { Write-Host ''; Run-Node @($cfgJs, '--test') }
    } elseif ($envKey) {
        Write-Host ('      配置里没有，但环境变量 DEEPSEEK_API_KEY 有：' + (Mask-Key $envKey))
        Write-Host '      （配置文件留空时会自动用它）'
    } else {
        Write-Host '      没配 —— 现在只能用到模式 2（只提示）。' -ForegroundColor Yellow
        Write-Host '      去 主菜单 → 4 → 4 填一个就能用模式 3。' -ForegroundColor Yellow
    }

    Write-Host ''
    Pause-Any '按回车返回'
}

# ---------- 主循环 ----------
$script:NodeOk = Test-Node
if (-not $script:NodeOk) {
    Write-Host '  按回车关掉这个窗口，装好 node 再重新打开。' -ForegroundColor Gray
    Pause-Any
    exit 1
}

if ($Menu -eq '设置') { Show-Settings; exit 0 }

while ($true) {
    Clear-Host
    Show-Status
    Show-Menu
    $c = (Read-Host '  选一个').Trim()

    switch ($c) {
        '1' {
            Write-Host ''
            Write-Host '  打开开始流程（会在新窗口里跑，按它的提示操作）…' -ForegroundColor Gray
            try {
                # 【本轮批次标识】由"新启动"生成，外套（驱动器循环.cmd）内部重启会沿用它。
                # 用途：跨外套重启时把"这一章本轮填过题"这类账接上，避免同一章被重复填一遍
                # （重复填 = 再截一次图、再问一次模型，白花钱）。下一次全新启动会换一个新标识，
                # 所以不会把上一次运行的旧账背过来。
                $env:DSH_BATCH = ('c' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + $PID)
                # 【修 2026-10-11】这里原来是 Start-Process ... -Wait —— 它会跟 开始.cmd
                # 结尾那个"等你看一眼"的暂停互相死等：-Wait 等它退出，它等用户在那个
                # 窗口按键，而用户正盯着这个控制台。结果就是这个窗口再也回不到菜单、
                # 敲什么都没反应，看着像"无响应"（实测：两个进程一起挂住半小时不退出）。
                # 现在改成**轮询 + 上限**：它一退出就立刻接着往下走；跑的时候把"还在跑"
                # 打在屏幕上，免得用户以为卡死。上限 300 秒纯粹是兜底 —— 失败路径上
                # 开始.cmd 会停在它自己的 pause 等用户看错误，那种情况也不该永远等下去。
                $startProc = Start-Process -FilePath (Join-Path $here '_内部\开始.cmd') -PassThru -ErrorAction Stop
                Write-Host '  开始窗口已经另开了 —— 请在**那个**窗口里按它的提示操作。' -ForegroundColor Gray
                $ticks = 0
                while (-not $startProc.HasExited -and $ticks -lt 600) {
                    Start-Sleep -Milliseconds 500
                    $ticks++
                    if ($ticks % 10 -eq 0) {
                        Write-Host ('      …开始进程还在跑（已等 ' + [int]($ticks / 2) + ' 秒），它那个窗口在等你操作。') -ForegroundColor DarkGray
                    }
                }
                if (-not $startProc.HasExited) {
                    Write-Host '  开始窗口还开着（它在等你按键，或者在等你看它的提示），这里不等了，直接继续。' -ForegroundColor Gray
                } elseif ($startProc.ExitCode -ne 0) {
                    Write-Host ('  开始流程未成功（退出码 ' + $startProc.ExitCode + '）。请查看开始窗口的提示或运行日志。') -ForegroundColor Yellow
                    Pause-Any
                } else {
                    Write-Host '  开始流程已经跑完了。' -ForegroundColor Gray
                }
            } catch {
                Write-Host ('  无法启动开始流程：' + $_.Exception.Message) -ForegroundColor Red
                Pause-Any
            }
        }
        '2' {
            Write-Host ''
            # 【必须先立停止标记】外套（_内部\驱动器循环.cmd）每 15 秒看一次这个文件；
            # 不立标记的话，驱动器一退出外套立刻又拉一个新的起来 —— 用户看到的就是"停不掉"。
            try {
                Set-Content -LiteralPath (Join-Path $here '_内部\停止标记.txt') -Value 'stop' -Encoding ASCII -ErrorAction Stop
            } catch {
                Write-Host ('  ⚠ 没能写停止标记（' + $_.Exception.Message + '）：外套可能又把驱动器拉起来。') -ForegroundColor Yellow
            }
            # 先在这里把驱动器停掉（走共享模块做身份验证：PID + 创建时间 + node + driver.js 完整路径）。
            # 这样「停止」不必再经过 cmd 那一层，少一次转手也少一处能出岔子的地方。
            $sr = Stop-VerifiedDriver
            if (-not $sr.Ok) {
                Write-Host '  改用系统停止流程（会在新窗口里跑）…' -ForegroundColor Yellow
                # 【修 2026-10-11】和"开始"那条一样的坑：停止.cmd 结尾也有裸 pause
                # （"完成。按任意键关闭。"）。-Wait 会一直等用户去那个窗口按键，
                # 这里就再也回不到菜单。同样改成轮询 + 上限。
                # （错误报告只提了"开始"那一处，这一处是排查时发现的同类问题。）
                $stopProc = Start-Process -FilePath (Join-Path $here '_内部\停止.cmd') -PassThru
                $ticks = 0
                while (-not $stopProc.HasExited -and $ticks -lt 600) {
                    Start-Sleep -Milliseconds 500
                    $ticks++
                    if ($ticks % 10 -eq 0) {
                        Write-Host ('      …停止窗口还开着（已等 ' + [int]($ticks / 2) + ' 秒），按它窗口里的提示操作。') -ForegroundColor DarkGray
                    }
                }
                if (-not $stopProc.HasExited) {
                    Write-Host '  停止窗口还开着（在等你按键），这里不等了 —— 它自己会等你处理完。' -ForegroundColor Gray
                }
            } else {
                # 驱动器已经处理完了；浏览器要不要关，仍交给 停止.cmd 的交互问卷（那里也只关助手自己那一个实例）
                Write-Host ''
                $t = (Read-Host '  顺便关掉助手自己启动的那个浏览器吗？(y/N)').Trim()
                if ($t -match '^[yY]') {
                    $er = Invoke-RuntimeProcesses @('--stop-edge', '--base', $here,
                        '--profile', (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User'), '--port', '9222')
                    if ($null -eq $er) {
                        Write-Host '  浏览器管理模块没给出结论 —— 一个进程都没关（安全优先）。' -ForegroundColor Yellow
                    } elseif ($er.ok) {
                        Write-Host ('  已关闭助手实例：' + [string]$er.reason) -ForegroundColor Green
                    } else {
                        Write-Host ('  没能确认那就是助手启动的浏览器，所以一个进程都没关：' + [string]$er.reason) -ForegroundColor DarkGray
                    }
                } else {
                    Write-Host '  浏览器留着不动（你正常用的那个 Edge 从头到尾都没被碰）。' -ForegroundColor DarkGray
                }
            }
            $script:DrvCache = $null
            Pause-Any
        }
        '3' {
            if (-not (Test-Path $logFile)) {
                Write-Host ''
                Write-Host '  还没有 运行日志.txt —— 先点 1 开始。' -ForegroundColor Yellow
                Pause-Any
            } else {
                Start-Process -FilePath (Join-Path $here '_内部\看进度.cmd')
                Write-Host ''
                Write-Host '  已经另开一个窗口看进度了（按 Ctrl+C 关掉它）。' -ForegroundColor Gray
                Pause-Any
            }
        }
        '4' { Show-Settings }
        '5' {
            Clear-Host
            Write-Host ''
            if (-not (Test-Path $decoder)) {
                Write-Host ('  找不到解码脚本: ' + $decoder) -ForegroundColor Yellow
            } else {
                Push-Location (Split-Path -Parent $decoder)
                & (Get-NodeExe) (Split-Path -Leaf $decoder) 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
                Pop-Location
            }
            Write-Host ''
            Pause-Any
        }
        '6' { Do-SelfCheck }
        '7' { Start-Process explorer.exe $here; Pause-Any }
        '8' {
            $cur = Get-HbSpeed
            Write-Host ''
            if ($cur -gt 1) {
                Write-Host ('  伪心跳现在是 ' + $cur + ' 倍速（开）。') -ForegroundColor Green
                $t = (Read-Host '  关掉它？(Y/n)').Trim()
                if ($t -notmatch '^[nN]') {
                    if (Set-HbSpeed 0) { Write-Host '  已关掉。下一次跑驱动器就按老样子老实播。' -ForegroundColor Gray }
                }
            } else {
                Write-Host '  伪心跳现在是关的。' -ForegroundColor Gray
                $t = (Read-Host '  开启 60 倍速？(Y/n)').Trim()
                if ($t -notmatch '^[nN]') {
                    if (Set-HbSpeed 60) {
                        Write-Host ''
                        Write-Host '  已开启 60 倍速。' -ForegroundColor Green
                        Write-Host '  · 驱动器要重跑一次才生效：回主菜单点 2（停），再点 1（开始）。' -ForegroundColor Gray
                        Write-Host '  · 它不碰 playbackRate（平台的 1Hz 看门狗抓不到），改为替播放器把进度报上去。' -ForegroundColor Gray
                        Write-Host '  · 认没认看日志里的「平台回话 accepted / rejected」——程序不会替你猜。' -ForegroundColor Gray
                        Write-Host '  · 万一连续被拒，样本会落在 伪心跳-样本.json，把它发给作者补 dtoken 算法。' -ForegroundColor Gray
                    } else {
                        Write-Host '  写开关文件失败（目录不可写？）。' -ForegroundColor Yellow
                    }
                }
            }
            Pause-Any
        }
        '0' { exit 0 }
        default { }
    }
}
