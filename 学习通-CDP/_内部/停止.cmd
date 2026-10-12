@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title 学习通助手 - 停止
cd /d "%~dp0.."
set "NODEEXE=node"
if exist "%~dp0..\node\node.exe" set "NODEEXE=%~dp0..\node\node.exe"
set "RTP=%~dp0..\runtime-processes.js"
set "BATCHDIR=%~dp0.."
set "SANDBOX=%LOCALAPPDATA%\Microsoft\Edge\User"
set "CDPPORT=9222"

echo ============================================================
echo   学习通助手 —— 停止
echo ============================================================
echo.
rem 先立停止标记，外套（驱动器循环.cmd）看到它才不会又自动重来
echo stop > "_内部\停止标记.txt"

rem ==========================================================
rem  【2026-10-11 改动：不再拿 运行中.pid 里的 PID 直接 taskkill】
rem  旧版读一个 PID 就 /f 掉它。驱动器被强杀 / 崩溃时那个文件会残留，
rem  Windows 把 PID 回收给别的程序之后，这一下就杀了一个完全无关的进程。
rem  现在交给 runtime-processes.js：PID + 进程创建时间 + node 映像 +
rem  命令行里的完整 driver.js 路径，四样全对上才动手；对不上就什么都不杀。
rem ==========================================================
echo   正在停止驱动器 ...
set "STOPJSON="
for /f "delims=" %%j in ('call "%NODEEXE%" "%RTP%" --stop-driver --base "%BATCHDIR%" 2^>nul') do set "STOPJSON=%%j"
if not defined STOPJSON goto :stopfallback
echo   !STOPJSON!
echo !STOPJSON! | findstr /c:"\"ok\":true" >nul
if errorlevel 1 goto :killfail
goto :askedge

:stopfallback
rem 模块起不来（node 缺失/被杀软拦）—— 退回旧办法，但只认"这个 PID 是 node"才敢杀。
if not exist "运行中.pid" goto :nopid
set /p DPID=<运行中.pid
if not defined DPID goto :nopid
tasklist /fi "pid eq !DPID!" 2>nul | find "node.exe" >nul
if errorlevel 1 goto :stale
echo   正在停止驱动器（PID !DPID!，退回旧办法）...
taskkill /f /pid !DPID! >nul 2>&1
tasklist /fi "pid eq !DPID!" 2>nul | find "!DPID!" >nul
if not errorlevel 1 goto :killfail
del "运行中.pid" >nul 2>&1
echo   驱动器已停止。
goto :askedge

:stale
echo   运行中.pid 里的 PID !DPID! 不是驱动器（很可能只是残留记录），没有杀任何进程。
del "运行中.pid" >nul 2>&1
goto :askedge

:killfail
echo.
echo   [失败] 没能停掉驱动器。
echo   上面那行 JSON 里写了原因（比如"身份验证不通过，拒绝杀进程"）。
echo   办法：直接关掉那个最小化的「学习通驱动器」黑框。
echo.
pause
exit /b 1

:nopid
echo   没找到驱动器记录，它可能已经停了。
echo   如果还能看到那个最小化的「学习通驱动器」黑框，直接关掉它也一样。

:askedge
echo.
set "K="
set /p K=顺便关掉助手自己启动的那个浏览器吗？(y/N) 
if /i "%K%"=="y" goto :kedge
echo   浏览器留着不动（推荐：你正常用的那个 Edge 从头到尾都不会被碰）。
goto :end

:kedge
rem ==========================================================
rem  只关"我们自己启动的那个" Edge：凭证 = 主进程 PID + 创建时间 + 独立 profile + 端口。
rem  没有凭证、或者现场对不上 → 一个进程都不动（宁可不关，也不误关用户自己的窗口）。
rem  绝不 taskkill /im msedge.exe。
rem ==========================================================
set "EDGEJSON="
for /f "delims=" %%j in ('call "%NODEEXE%" "%RTP%" --stop-edge --base "%BATCHDIR%" --profile "%SANDBOX%" --port %CDPPORT% 2^>nul') do set "EDGEJSON=%%j"
if not defined EDGEJSON goto :edgefallback
echo   !EDGEJSON!
echo !EDGEJSON! | findstr /c:"\"ok\":true" >nul
if errorlevel 1 echo   没能确认那就是助手启动的浏览器 —— 所以一个进程都没关。
goto :end

:edgefallback
echo   浏览器管理模块没给出结论，为安全起见一个进程都不关。
echo   你自己那个 Edge 窗口不受影响；助手实例可以在任务管理器里手动结束。

:end
echo.
echo 完成。按任意键关闭。
pause >nul
exit /b 0
