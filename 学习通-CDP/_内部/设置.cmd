@echo off
chcp 65001 >nul
title 答题助手 - 设置
cd /d "%~dp0.."
rem 真正的设置在 控制台.ps1 里，这里只是把它打开到那一屏。
rem 这样改配置只有一处实现，不会出现"两个界面改同一份配置"的问题。
if not exist "%~dp0..\控制台.ps1" (
  echo.
  echo   [没跑起来] 找不到 控制台.ps1 —— 多半是解压不完整，或文件名乱码。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\控制台.ps1" -Menu 设置
if errorlevel 1 (
  echo.
  echo   [没跑起来] 上面就是 PowerShell 给出的原因。截图发回去即可。
  pause
)
