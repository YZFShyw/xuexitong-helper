@echo off
chcp 936 >nul
title 学习通助手 - 网页控制台
cd /d "%~dp0"

rem ================================================================
rem  学习通助手 · 网页控制台
rem
rem  打开一个只监听本机 127.0.0.1 的网页，用来看和改：
rem    驱动器在不在跑 / 跑到哪一章 / 这一章的视频走到几分几秒
rem    答题助手设置（模式 / 读题方式 / 自动填 / 测验停 / 每章上限 / 模型 / key）
rem    伪心跳 60 倍速开关、实时日志、本轮账目
rem    开始 / 停止驱动器、解码乱码、测 key、环境自检
rem
rem  它和 控制台.cmd（那个文本菜单）是两套入口，改的是同一份 答题设置.json，
rem  两个都开着也不会打架 —— 写配置走的都是 答题助手.js 的 saveConfig。
rem
rem  加参数可以覆盖默认行为，例如：
rem    "网页控制台.cmd" --port=8899     换个端口（不开浏览器）
rem
rem  入口有闸门（挡"本机浏览器里的其它网页"和域名重绑定）：
rem    * Host 只认 localhost / 127.0.0.1 / [::1] 加本进程实际的端口；
rem    * 每次启动随机生成一个 token，页面自己带在 X-Dsh-Console-Token 头里；
rem    * POST 还要求 Origin 精确等于自身（含动态端口）+ Content-Type: application/json。
rem  所以"收藏夹里存着地址、回头再点开"在重启后会 403（token 已经换了）：
rem  重新双击这个 cmd，用窗口里打印的那个地址打开就行。
rem ================================================================

rem 优先用包里自带的 node\node.exe（分发包带了这个，收包的人不用自己装）
set "NODEEXE=node"
if exist "%~dp0node\node.exe" set "NODEEXE=%~dp0node\node.exe"
rem 中文文件名先在 936 区域读进变量 —— 切到 65001 之后那一行才是纯 ASCII，
rem 否则 cmd 会按 UTF-8 误读这一行，把乱码路径传给 node（'Cannot find module' 实测踩过）。
set "ENTRYJS=网页控制台.js"

"%NODEEXE%" -v >nul 2>&1
if errorlevel 1 goto :nonode

rem 默认自动弹浏览器；只要给了参数就不弹（方便脚本里调它）
set "OPENARG=--open"
if not "%~1"=="" set "OPENARG="

echo.
echo   ============================================================
echo     学习通助手 · 网页控制台
echo   ============================================================
echo.
echo   地址是  http://127.0.0.1:8898/    （端口被占会自动往后找，
echo   以这个窗口里打印的那一行为准）
echo.
echo   页面带一个每次启动都会变的随机 token（防别的网页乱调接口），
echo   所以请用下面打印出来的地址打开；重启后旧的收藏夹地址会 403。
echo.
echo   这个黑窗口别关 —— 关掉它，控制台就停了。
echo   （驱动器不受影响，该跑还是跑；要停驱动器去页面上按。）
echo.
rem 【这里必须切到 65001】node 的 stdout 是 UTF-8，控制台按 936 解释就是乱码。
chcp 65001 >nul
"%NODEEXE%" "%ENTRYJS%" %OPENARG% %*
chcp 936 >nul
echo.
echo   网页控制台已经关了。
pause
exit /b 0

:nonode
echo.
echo   ============================================================
echo     找不到 node —— 网页控制台起不来
echo   ============================================================
echo.
echo   这个助手是用 JavaScript 写的，需要一个叫 Node.js 的程序来跑它。
echo   它跟你平时用的浏览器、Office 是两回事，得单独装一次。
echo.
echo   分发包里如果带了 node\node.exe，上面的检查会自动找到它；
echo   没带的话（精简版），自己装一次：
echo.
echo     1. 打开  https://nodejs.org/zh-cn
echo     2. 点左边那个大按钮，下载「LTS」版
echo     3. 双击安装包，一路点「下一步」（默认选项就行）
echo     4. 装完关掉这个窗口，重新双击 网页控制台.cmd
echo.
echo   怎么确认装好了：按 Win+R，输入 cmd 回车，敲  node -v
echo   看到一个版本号（例如 v22.11.0）就算好了。
echo.
pause
exit /b 1
