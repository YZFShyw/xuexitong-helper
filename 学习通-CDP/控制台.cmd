@echo off
chcp 65001 >nul
title 学习通助手 - 控制台
cd /d "%~dp0"
if not exist "控制台.ps1" (
  echo.
  echo   [没跑起来] 这里找不到 控制台.ps1 —— 多半是解压不完整，或文件名被转成了乱码。
  echo   请重新完整解压压缩包（用系统自带的 全部解压缩，或 7-Zip）。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0控制台.ps1"
if errorlevel 1 (
  echo.
  echo   [没跑起来] 上面就是 PowerShell 给出的原因（正常退出不会停在这里）。
  echo   把这一屏截图发回去即可。
  pause
)
