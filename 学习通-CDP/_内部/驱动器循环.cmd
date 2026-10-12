@echo off
chcp 936 >nul
title 学习通驱动器
rem ==========================================================
rem  【2026-10-11 新增】别让这个窗口骚扰人。外套没人盯着看 ——
rem  日志全在 运行日志.txt 里，屏幕上没有信息。可它偏偏会在桌面上留一个
rem  说不出用途的黑框，更糟的是：本机 HKCU\Console\QuickEdit = 1，
rem  在里面点一下鼠标就会进 conhost 的"选择"模式 —— 输出冻结、键盘失灵，
rem  窗口标题还会变成「选择 学习通驱动器」，看着就像卡死（其实外套跑得好好的）。
rem  所以开头做两件事：把本窗口最小化 + 关掉本窗口的快速编辑。
rem  只动这一个窗口，**绝不改 HKCU\Console 的全局设置**（那是用户的东西）。
rem  失败了也没关系：这里不看退出码，外套该跑还是跑。
rem ==========================================================
if exist "%~dp0外套窗口.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0外套窗口.ps1" >nul 2>&1
cd /d "%~dp0.."
setlocal enabledelayedexpansion
rem ------------------------------------------------------------
rem Prefer the node bundled in this folder (node\node.exe).
rem Falls back to whatever node is on PATH if it is not there.
rem ------------------------------------------------------------
set "NODEEXE=node"
if exist "%~dp0..\node\node.exe" set "NODEEXE=%~dp0..\node\node.exe"
set "RTP=%~dp0..\runtime-processes.js"
set "BATCHDIR=%~dp0.."

rem ==========================================================
rem  「自愈外套」。
rem  驱动器（"%NODEEXE%" driver.js）因为任何原因退出 —— 弹窗点不动、
rem  翻节失败、端口抖了一下 —— 这里都会隔一会自动重新拉起来，
rem  不用你守着。要彻底停就回控制台点 2。
rem ==========================================================

rem ==========================================================
rem  【本轮批次标识】只在"新启动"时生成一次，之后每次重拉都沿用同一个。
rem  为什么：driver.js 里"这一章本轮填过题 / 点开过几次任务点"这类去重账
rem  现在会落到 驱动器检查点.<批次>.json。外套重启的新进程读到同一个批次，
rem  才知道"这是同一次运行"，不会把同一章重新填一遍（重复填 = 白花钱）。
rem  而用户重新点一次开始 = 新批次，不会背上次的旧账。
rem ==========================================================
if not defined DSH_BATCH set "DSH_BATCH=c%RANDOM%%RANDOM%-%RANDOM%"
echo [%DATE% %TIME%] 本轮批次：!DSH_BATCH! >> "运行日志.txt"

set /a N=0

rem 只在进入循环前补充一次 PATH，防止每次重试不断增长。
set "PATH=%~dp0node;%~dp0..\node;%PATH%"
set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs"
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\nodejs"
set "PATH=%PATH%;%APPDATA%\nvm"

:loop
if exist "_内部\停止标记.txt" goto :stopped
set /a N+=1
rem 【启动前体检】以前这里是裸 node，而 set 出来的 NODEEXE 从没被用过 ——
rem 在没装 Node、没配 PATH 的机器上，cmd 只会回一句「不是内部或外部命令」，
rem 外面看不出来，外套照样空转 60 次然后放弃，日志里一个字节都没有。
rem 所以这里先把常见的安装位置拼进 PATH，再体检一次；找不到就写清楚，不空转。
"%NODEEXE%" -v >nul 2>&1
if errorlevel 1 goto :nonode

rem ---------- 重复驱动器检查（每次重拉之前都查一遍） ----------
rem  正常情况这里应该返回 alive=false（上一次的进程确实死了），所以不会拦住重拉。
rem  但如果某个实例其实还活着（上一次只是"看起来退了"），这里就不许再拉第二个：
rem  两个驱动器同时动一个页面 = 章节来回跳 + 白跑一趟。
set "DRV="
rem 【判活看退出码，不看 JSON 字符串（2026-10-11）】--status-exit：退出码 0 = 有一个身份验证通过的驱动器在跑。
rem 旧写法 findstr /c:"\"alive\":true" 实测在真实 cmd.exe 里匹配不上（引号+反斜杠不可移植），
rem 而且只判 alive 会漏掉 verified=false（PID 复用）那种最危险的误判。
"%NODEEXE%" "%~dp0..\runtime-processes.js" --status-exit --base "%BATCHDIR%" >nul 2>&1
if not errorlevel 1 goto :alreadyrunning

:launch
rem ---------- 伪心跳 60 倍速 ----------
rem 开关由控制台主菜单第 8 项写进 _内部\伪心跳开关.txt，内容就是倍速（0 = 关）。
rem 只有开了才传 --speed：不传的时候 driver.js 的行为跟以前一模一样。
set "HBS=0"
rem 用 for /f 而不是 set /p：for /f 会去掉行首尾的空白，手动编辑过这个文件也不怕。
if exist "_内部\伪心跳开关.txt" for /f "usebackq tokens=1" %%s in ("_内部\伪心跳开关.txt") do set "HBS=%%s"
set "HBARG="
if not "%HBS%"=="0" set "HBARG=--speed=%HBS%"
rem 每次都把批次标识再交给 driver.js 一次：它是"同一次运行"的凭据。
"%NODEEXE%" driver.js --run --next --force %HBARG% --batch=%DSH_BATCH% >> "运行日志.txt" 2>&1
if exist "_内部\停止标记.txt" goto :stopped
if %N% geq 60 goto :toomany
echo. >> "运行日志.txt"
echo [%DATE% %TIME%] 驱动器退出了（第 %N% 次）。15 秒后自动重新拉起，不用你管。 >> "运行日志.txt"
ping -n 16 127.0.0.1 >nul
goto :loop

:alreadyrunning
echo [%DATE% %TIME%] 检测到还有一个身份验证通过的驱动器在跑，本次不重复拉起；15 秒后再看。 >> "运行日志.txt"
ping -n 16 127.0.0.1 >nul
goto :loop

:nonode
echo. >> "运行日志.txt"
echo [%DATE% %TIME%] [错误] 找不到 node.exe，驱动器起不来。 >> "运行日志.txt"
echo   包目录里如果有 node\node.exe，会被自动找到。 >> "运行日志.txt"
echo   没有的话请去 https://nodejs.org 装一个 LTS 版本， >> "运行日志.txt"
echo   装完重新双击 控制台.cmd 点 1 即可。 >> "运行日志.txt"
echo.
echo ============================================================
echo   [错误] 找不到 node.exe，驱动器起不来。
echo.
echo   这个包如果带了 node 目录，里面的 node.exe 会被自动找到。
echo   没带的话请去 https://nodejs.org 装一个 LTS 版本，
echo   装完重新双击 控制台.cmd，点 1 开始。
echo ============================================================
pause
exit /b 1

:stopped
echo. >> "运行日志.txt"
echo [%DATE% %TIME%] 收到停止指令，不再自动重来。 >> "运行日志.txt"
exit /b 0

:toomany
echo. >> "运行日志.txt"
echo [%DATE% %TIME%] 已经重来 %N% 次了，页面可能真出问题了。停下来 —— 回控制台点 3 看日志。 >> "运行日志.txt"
exit /b 1
