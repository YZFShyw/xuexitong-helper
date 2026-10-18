@echo off
chcp 936 >nul
title 启动助手浏览器（手动备用）
rem ============================================================
rem 手动备用启动：只做一件事 —— 用「助手专用 profile + 9222」拉起 Edge。
rem 不做端口探测、不做自检、不判断"是否已经开着"：少一步判断，少一个失败点。
rem 用在「开始.cmd 自动拉起浏览器被安全软件拦掉」的时候。
rem 顺序：双击本脚本 -> 登录 -> 切到课程页 -> 再启动 控制台.cmd 点 1
rem （控制台会先探 9222；端口已通就跳过"自己拉起浏览器"这一步）
rem ============================================================

set "CDPPORT=9222"
set "SANDBOX=%LOCALAPPDATA%\Microsoft\Edge\User"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto :found
set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto :found
set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto :found
echo.
echo 找不到 msedge.exe（这三个位置都没有）：
echo   %ProgramFiles(x86)%\Microsoft\Edge\Application
echo   %ProgramFiles%\Microsoft\Edge\Application
echo   %LOCALAPPDATA%\Microsoft\Edge\Application
echo 先把 Edge 装好再试。
pause
exit /b 1

:found
if not exist "%SANDBOX%" mkdir "%SANDBOX%" >nul 2>&1
start "" "%EDGE%" --remote-debugging-port=%CDPPORT% --user-data-dir="%SANDBOX%" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --window-size=1500,1050 --disable-session-crashed-bubble --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows
echo.
echo 已经交给系统启动，本窗口可以关掉。
echo 接下来：登录 -^> 切到要刷的课程页 -^> 启动 控制台.cmd 点 1
ping -n 4 127.0.0.1 >nul 2>&1
exit /b 0
