@echo off
chcp 65001 >nul
title 学习通助手 - 解乱码
cd /d "%~dp0.."
rem ------------------------------------------------------------
rem Prefer the node bundled in this folder (node\node.exe).
rem Falls back to whatever node is on PATH if it is not there.
rem ------------------------------------------------------------
set "NODEEXE=node"
if exist "%~dp0node\node.exe" set "NODEEXE=%~dp0node\node.exe"
echo.
echo  把字体反爬的乱码翻回真字
echo.
echo  默认读 章节测验记录.txt，
echo  解码后打印出来，并另存为 章节测验记录-已解码.txt
echo.
echo  想解别的文字:  "%NODEEXE%" 解乱码.js --text "庘庝律"
echo.
pause
"%NODEEXE%" 解乱码.js
echo.
pause
