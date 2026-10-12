# 写字形图 —— 把反爬字体里的 41 个字形画成一张图
#
# 用法：
#   powershell -File 写字形图.ps1              画全部字形，存 _字体\字形表.png
#   powershell -File 写字形图.ps1 -Text "..."  另外把一段文字放大画出来（用来验收对照表）
#
# 为什么要有这一步：
#   造对照表.js 已经查明替身字形的轮廓不是从任何系统字体剪的 ——
#   它自称来自 "Source Han Sans CN Normal"（思源黑体 CN Normal），
#   而思源黑体不是 Windows 自带字体，这台机器没装。
#
#   于是自动比对的路走不通了。但换个角度想：
#   一共就 41 个字，把它们画出来直接看，比下载几 MB 字体再写匹配算法
#   更快、也更容易验证。这就是这一步干的事。
#
# 坑：
#   1. 必须用 PrivateFontCollection 私有加载
#      直接把 ttf 丢给 new Font("字体名", size) 是不行的 ——
#      系统字体表里没有这支字体，GDI+ 会悄悄回退到宋体，
#      结果画出来是一堆正常的"厐厙厠厦"，看着像成功了其实全错。
#      私有加载才保证用的是这支字体自己的 cmap。
#
#   2. 标签用另一支字体画
#      这支字体只有 41 个字形，没有 A-Z 和 0-9。
#      拿它画 "U+5390" 会变成一堆豆腐块，所以标签必须换字体。
#
#   3. 这段脚本存盘必须是 UTF-8 带 BOM
#      PowerShell 5.1 读没有 BOM 的 UTF-8 文件会按 GBK 解，中文全乱。
#      看到中文变成"锟斤拷"就是这个原因。

param(
    [string]$Text = '',
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutDir) { $OutDir = $here }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$fontPath = Join-Path $OutDir 'font-01-font-cxsecret.ttf'
if (-not (Test-Path $fontPath)) {
    Write-Host '找不到字体文件: ' -NoNewline
    Write-Host $fontPath
    Write-Host '先跑一次:  node 看字体.js --dump'
    exit 1
}

# ---- 私有加载这支字体 ----
$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile($fontPath)
$fam = $pfc.Families[0]
Write-Host ('加载字体: ' + $fam.Name)

# ---- 从轮廓.json 里读出 41 个码位 ----
$jsonPath = Join-Path $OutDir '轮廓.json'
if (-not (Test-Path $jsonPath)) {
    Write-Host ''
    Write-Host '找不到 轮廓.json —— 先跑:  node 解析字体.js --json'
    exit 1
}
$j = Get-Content -Raw -Encoding UTF8 $jsonPath | ConvertFrom-Json
$cps = @($j.cmap | ForEach-Object { [int]$_.cp } | Sort-Object -Unique)
Write-Host ('码位:     ' + $cps.Count + ' 个')

# ---- 画网格 ----
$COLS = 6
$CW = 130      # 格子宽
$CH = 155      # 格子高
$GLYPH = 82    # 字形字号
$rows = [Math]::Ceiling($cps.Count / $COLS)
$W = $COLS * $CW
$H = $rows * $CH

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$fGlyph = New-Object System.Drawing.Font($fam, $GLYPH, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fLabel = $null
foreach ($n in @('Consolas', 'Segoe UI', 'Arial')) {
    try { $fLabel = New-Object System.Drawing.Font($n, 13); break } catch { }
}
if (-not $fLabel) { $fLabel = New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericSansSerif, 13) }

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 210, 210), 1)
$brGlyph = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
$brLabel = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 90, 90))
$brIdx = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 60, 60))

$fmtCenter = New-Object System.Drawing.StringFormat
$fmtCenter.Alignment = [System.Drawing.StringAlignment]::Center

for ($i = 0; $i -lt $cps.Count; $i++) {
    $cx = ($i % $COLS) * $CW
    $cy = [Math]::Floor($i / $COLS) * $CH
    $g.DrawRectangle($pen, $cx, $cy, $CW - 1, $CH - 1)

    # 序号（红）—— 方便对着控制台列表核对
    $g.DrawString(('#' + ($i + 1)), $fLabel, $brIdx, ($cx + 6), ($cy + 4))

    # 字形本体：用这支反爬字体画替身码位，出来的就是真字形
    # 坑：New-Object 的参数表里不能直接写算术式。
    #     New-Object X($a, $b + 16) 会被拆成 5 个参数，报 "argument count: 5"。
    #     所以先算好存进变量，再传进去。
    $ch = [char]$cps[$i]
    $rx = [float]$cx
    $rw = [float]$CW
    $rect = New-Object System.Drawing.RectangleF($rx, [float]($cy + 24), $rw, [float]($GLYPH + 16))
    $g.DrawString([string]$ch, $fGlyph, $brGlyph, $rect, $fmtCenter)

    # 码位标签（灰）
    $lab = 'U+' + $cps[$i].ToString('X4')
    $rect2 = New-Object System.Drawing.RectangleF($rx, [float]($cy + $CH - 26), $rw, [float]20)
    $g.DrawString($lab, $fLabel, $brLabel, $rect2, $fmtCenter)
}

$g.Dispose()
$outPng = Join-Path $OutDir '字形表.png'
$bmp.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host ''
Write-Host ('字形表已存: ' + $outPng)
Write-Host ''

# ---- 控制台也列一遍，方便直接抄 ----
Write-Host '序号  码位    字符'
for ($i = 0; $i -lt $cps.Count; $i++) {
    Write-Host (('{0,3}   U+{1}   {2}' -f ($i + 1), $cps[$i].ToString('X4'), [char]$cps[$i]))
}

# ---- 可选：把一段文字放大画出来，用来验收 ----
if ($Text) {
    $W2 = 1100
    $H2 = 300
    $bmp2 = New-Object System.Drawing.Bitmap($W2, $H2)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
    $g2.Clear([System.Drawing.Color]::White)
    $g2.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $fBig = New-Object System.Drawing.Font($fam, 46, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $rect3 = New-Object System.Drawing.RectangleF(20, 20, ($W2 - 40), ($H2 - 40))
    $g2.DrawString($Text, $fBig, $brGlyph, $rect3)
    $g2.Dispose()
    $outPng2 = Join-Path $OutDir '验收.png'
    $bmp2.Save($outPng2, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp2.Dispose()
    Write-Host ''
    Write-Host ('验收图已存: ' + $outPng2)
}
