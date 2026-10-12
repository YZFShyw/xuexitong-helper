@echo off
chcp 65001 >nul
title 学习通助手 - 控制台
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0控制台.ps1"
