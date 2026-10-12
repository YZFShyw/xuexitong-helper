# 扫字形 —— 把两万多个汉字的形状都渲染成小图，存成二进制给 Node 去比
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File 扫字形.ps1
#
# 产物（都在 _字体\ 下）：
#   mask-参照.bin   参照字体渲染的 ~21000 个汉字，每个 32x32x4 字节
#   mask-替身.bin   反爬字体渲染的 41 个字形，同样的格式
#   扫描索引.json    码位顺序、网格大小、参照字体名
#
# ------------------------------------------------------------------
# 为什么要拆成"PowerShell 渲染 + Node 比对"两步：
#
#   渲染只有 GDI+ 能干（Node 里没有现成的字体光栅化器），
#   而比对是 21000 x 41 x 1024 次乘加（约 9 亿次），
#   在 PowerShell 里跑这种循环要几个小时，在 Node 里只要几秒。
#
#   所以：PowerShell 只负责把每个字变成 32x32 的灰度小图，
#   原样 dump 成二进制；比对交给 Node。
#   中间不经过文本，避免编码问题。
#
# ------------------------------------------------------------------
# 为什么是"轮廓路径 + 墨迹包围盒归一化"：
#
#   直接用 DrawString 画到固定画布是不行的：
#   字形画在画布的哪个位置、多大，取决于字体的 ascent/descent 等度量，
#   两支字体度量不同，同一个字就画在不同位置、不同大小上，
#   比像素等于比位置和字号，不是比形状。
#
#   所以用 GraphicsPath.AddString 拿到纯轮廓坐标，
#   用 GetBounds 求出这支字体下这个字的墨迹框，
#   再自己平移缩放到固定网格 ——
#   位置、字号这些无关变量就被彻底消掉了，剩下的只有形状差异。
#   等比缩放（取宽高缩放比的较小值）而不是拉伸，
#   是因为"一"这种扁字一旦被拉成方块，形状信息就毁了。
#
# 坑：
#   1. 用同一个 Graphics 反复画，LockBits 前必须 Flush
#      Graphics 是延迟提交的，不 Flush 有可能读到上一张的内容。
#      用 Flush(Sync) 强制同步。
#
#   2. Format32bppArgb 的内存顺序是 B,G,R,A
#      不是 R,G,B,A。取红色通道要 +2，不是 +0。
#      这里画的是黑字白底，所以"墨迹程度" = (255 - R) / 255。
#
#   3. 这段脚本存盘必须是 UTF-8 带 BOM（中文注释）
#      PowerShell 5.1 读没有 BOM 的 UTF-8 会按 GBK 解，中文全乱。

param(
    [int]$Grid = 32,
    [int]$Em = 128,
    [string]$RefFont = 'Noto Sans SC',
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutDir) { $OutDir = $here }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$fontPath = Join-Path $OutDir 'font-01-font-cxsecret.ttf'
$jsonPath = Join-Path $OutDir '轮廓.json'

$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile($fontPath)
$decoyFam = $pfc.Families[0]

$refFam = $null
foreach ($n in @($RefFont, 'SimHei', 'Microsoft YaHei')) {
    try { $refFam = New-Object System.Drawing.FontFamily($n); $RefFont = $n; break } catch { }
}
if (-not $refFam) { Write-Host '找不到可用的参照字体'; exit 1 }

# ---------- 扫描范围 ----------
$ranges = @(
    @(0x3000, 0x303F),   # 中文标点
    @(0x4E00, 0x9FFF),   # 中日韩统一表意文字（常用汉字全在这）
    @(0xFF00, 0xFFEF)    # 全角符号
)
$cps = New-Object System.Collections.Generic.List[int]
foreach ($r in $ranges) { for ($c = $r[0]; $c -le $r[1]; $c++) { [void]$cps.Add($c) } }

$dj = Get-Content -Raw -Encoding UTF8 $jsonPath | ConvertFrom-Json
$decoyCps = @($dj.cmap | ForEach-Object { [int]$_.cp } | Sort-Object -Unique)

Write-Host ('替身字体: ' + $decoyFam.Name)
Write-Host ('参照字体: ' + $RefFont)
Write-Host ('网格: ' + $Grid + 'x' + $Grid + '   em: ' + $Em)
Write-Host ('待渲染: 参照 ' + $cps.Count + ' 个，替身 ' + $decoyCps.Count + ' 个')
Write-Host ''

# ---------- 渲染器：反复用同一张位图 ----------
$PX = 4
$bmp = New-Object System.Drawing.Bitmap($Grid, $Grid, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$eWhite = [System.Drawing.Color]::White
$brBlack = [System.Drawing.Brushes]::Black
$rectLock = New-Object System.Drawing.Rectangle(0, 0, $Grid, $Grid)
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$origin = New-Object System.Drawing.PointF([float]0, [float]0)

function Render-Mask {
    param($family, [string]$ch, [byte[]]$dst, [int]$dstOff, [int]$grid, [int]$em, $gfx, $bmpObj, $lockRect)
    $stride = $grid * 4
    # 先清成白底，失败的渲染就自然是"全白"
    for ($i = 0; $i -lt $stride * $grid; $i++) { $dst[$dstOff + $i] = 255 }

    $path = $null
    try {
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddString($ch, $family, [System.Drawing.FontStyle]::Regular, [float]$em, $origin, $fmt)
        if ($path.PointCount -eq 0) { return $false }
        $b = $path.GetBounds()
        if ($b.Width -le 0 -or $b.Height -le 0) { return $false }
        $k = [Math]::Min($grid / $b.Width, $grid / $b.Height)
        $tx = ($grid - $b.Width * $k) / 2 - $b.X * $k
        $ty = ($grid - $b.Height * $k) / 2 - $b.Y * $k
        $m = New-Object System.Drawing.Drawing2D.Matrix
        $m.Translate([float]$tx, [float]$ty)
        $m.Scale([float]$k, [float]$k)
        $path.Transform($m)

        $gfx.Clear($eWhite)
        $gfx.FillPath($brBlack, $path)
        $gfx.Flush([System.Drawing.Drawing2D.FlushIntention]::Sync)

        $data = $bmpObj.LockBits($lockRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
            [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $dst, $dstOff, $stride * $grid)
        } finally {
            $bmpObj.UnlockBits($data)
        }
        return $true
    } catch {
        return $false
    } finally {
        if ($path) { $path.Dispose() }
    }
}

# ---------- 参照字体：全量扫 ----------
$cell = $Grid * $Grid * $PX
$refBuf = New-Object byte[] ($cell * $cps.Count)
$t0 = Get-Date
$okRef = 0
for ($i = 0; $i -lt $cps.Count; $i++) {
    if (Render-Mask -family $refFam -ch ([string][char]$cps[$i]) -dst $refBuf -dstOff ($i * $cell) `
            -grid $Grid -em $Em -gfx $g -bmpObj $bmp -lockRect $rectLock) { $okRef++ }
    if (($i + 1) % 2000 -eq 0) {
        $el = ((Get-Date) - $t0).TotalSeconds
        $eta = $el / ($i + 1) * ($cps.Count - $i - 1)
        Write-Host ('  参照 ' + ($i + 1) + '/' + $cps.Count + '   已用 ' + [int]$el + ' 秒   预计还要 ' + [int]$eta + ' 秒')
    }
}
Write-Host ('  参照渲染完成: ' + $okRef + '/' + $cps.Count + ' 个取到轮廓')

# ---------- 替身字体：41 个 ----------
$decoyBuf = New-Object byte[] ($cell * $decoyCps.Count)
$okDecoy = 0
for ($i = 0; $i -lt $decoyCps.Count; $i++) {
    if (Render-Mask -family $decoyFam -ch ([string][char]$decoyCps[$i]) -dst $decoyBuf -dstOff ($i * $cell) `
            -grid $Grid -em $Em -gfx $g -bmpObj $bmp -lockRect $rectLock) { $okDecoy++ }
}
Write-Host ('  替身渲染完成: ' + $okDecoy + '/' + $decoyCps.Count)

$g.Dispose(); $bmp.Dispose()

[System.IO.File]::WriteAllBytes((Join-Path $OutDir 'mask-参照.bin'), $refBuf)
[System.IO.File]::WriteAllBytes((Join-Path $OutDir 'mask-替身.bin'), $decoyBuf)

$idx = [pscustomobject]@{
    grid       = $Grid
    em         = $Em
    px         = $PX
    cell       = $cell
    refFont    = $RefFont
    decoyFont  = $decoyFam.Name
    refCps     = @($cps)
    decoyCps   = @($decoyCps)
    generated  = (Get-Date).ToString('yyyy/MM/dd HH:mm:ss')
}
$idx | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path (Join-Path $OutDir '扫描索引.json') -Encoding UTF8

Write-Host ''
Write-Host ('已写出 mask-参照.bin (' + [int]($refBuf.Length / 1MB) + ' MB) 和 mask-替身.bin')
Write-Host ('总用时 ' + [int](((Get-Date) - $t0).TotalSeconds) + ' 秒')
