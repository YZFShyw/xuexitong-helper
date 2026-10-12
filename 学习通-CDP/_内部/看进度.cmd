@echo off
chcp 936 >nul
title 学习通助手 - 进度
cd /d "%~dp0.."
if not exist "运行日志.txt" goto :nolog
echo 实时进度（会一直刷新）。按 Ctrl+C 退出。
echo.
powershell -NoProfile -Command "Get-Content '运行日志.txt' -Tail 45 -Wait -Encoding UTF8"
exit /b 0

:nolog
echo 还没有日志。请先回控制台点 1 开始。
pause