@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title 学习通助手 - 开始
cd /d "%~dp0.."
rem ------------------------------------------------------------
rem Prefer the node bundled in this folder (node\node.exe).
rem Falls back to whatever node is on PATH if it is not there.
rem ------------------------------------------------------------
set "NODEEXE=node"
if exist "%~dp0..\node\node.exe" set "NODEEXE=%~dp0..\node\node.exe"
set "RTP=%~dp0..\runtime-processes.js"
set "CDPPORT=9222"
set "SANDBOX=%LOCALAPPDATA%\Microsoft\Edge\User"

rem ============================================================
rem  本轮批次标识：由"新启动"生成，外套（驱动器循环.cmd）内部重启会沿用它。
rem  用途：跨外套重启把"这一章本轮填过题"这类账接上，避免同一章被重复填一遍。
rem  控制台点 1 时已经生成过一个；这里只是兜底（直接双击本文件的情况）。
rem ============================================================
if not defined DSH_BATCH set "DSH_BATCH=c%RANDOM%%RANDOM%-%RANDOM%"
rem 这一批的日志归档 + 批次记录统一走 run-bootstrap.js（和网页控制台同一份实现）：
rem 它把旧 运行日志.txt 归档到 日志\ 并只保留最近 12 份（不再删除旧日志），
rem 写 本次运行.json 记下这一批的开始时间，并把批次标识回给下面用（--reuse-env 沿用已有的）。
set "BSRESULT=%TEMP%\dsh-run-%RANDOM%%RANDOM%.txt"
if exist "!BSRESULT!" del "!BSRESULT!" >nul 2>&1
"%NODEEXE%" "%~dp0..\run-bootstrap.js" --base "%BATCHDIR%" --reuse-env > "!BSRESULT!" 2>&1
set "NEWBATCH="
if exist "!BSRESULT!" for /f "usebackq tokens=2 delims==" %%b in ("!BSRESULT!") do if not defined NEWBATCH set "NEWBATCH=%%b"
if exist "!BSRESULT!" del "!BSRESULT!" >nul 2>&1
if defined NEWBATCH set "DSH_BATCH=!NEWBATCH!"

echo ============================================================
echo   学习通助手 —— 开始
echo ============================================================
echo.

rem ==========================================================
rem  先问端口在不在。在的话说明浏览器已经是可调试的了，那就一个窗口都不动。
rem ==========================================================
powershell -NoProfile -Command "try{ $null=(Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3); exit 0 }catch{ exit 1 }"
if not errorlevel 1 goto :hasport

rem ==========================================================
rem  【2026-10-11 改动：不再 taskkill /f /im msedge.exe】
rem  旧版这里按映像名全杀，会把用户自己开着、可能还没保存的 Edge 窗口一起关掉 ——
rem  而助手用的本来就是**独立 profile**，完全可以另起一个实例，不用动人家那一个。
rem  现在：只启动"自己的那一个"，并把它的所有权记下来（PID + 创建时间 + 独立 profile + 端口）；
rem  以后「关浏览器」只关凭证里那一个，用户自己开的 Edge 一律不碰。
rem ==========================================================
echo [1/3] 调试端口不在，启动一个**专供助手**的浏览器实例（独立 profile）。
echo.
echo       不会关闭你现在开着的任何 Edge 窗口 —— 它用的是独立的用户数据目录，
echo       跟你平时那个 Edge 互不影响（登录状态也是分开的，需要在这个窗口里登录一次）。
echo.
echo       按任意键继续；不想启动就直接关掉这个窗口。
pause >nul


rem ============================================================
rem  【2026-10-11 修】"把助手那个 Edge 窗口露出来"的调用**已经挪到 :afteredge**
rem  （调试端口就绪之后）。
rem  原来这段就放在这里 —— "启动浏览器"之前。冷启动时浏览器进程还不存在，
rem  显示助手窗口.ps1 第一步就返回 NO_EDGE_PROCESS，露窗口空跑一场；
rem  更糟的是它照样打印"助手窗口已自动显示"，等于对用户说谎，把排查方向带偏。
rem  顺序错 + 无脑报成功，两个毛病这次一起改（见文件末尾 :ShowAssistantWindow）。
rem  它只按所有权记录里的 PID 找窗口，不碰用户自己的 Edge。
rem ============================================================

echo       正在启动浏览器 ...
set "URLARGS="
rem 要打开哪些网页，写在 "我的课程.txt" 里（一行一个，以 # 开头的行忽略）。
rem 别人的包可能没这个文件 —— 那就退回学习通首页，自己登录进去点课程。
set "HASURL=0"
if exist "我的课程.txt" (
  for /f "usebackq eol=# tokens=*" %%a in ("我的课程.txt") do (
    set "URLARGS=!URLARGS! --url "%%a""
    set "HASURL=1"
  )
)
if "!HASURL!"=="0" set URLARGS=--url "https://mooc1.chaoxing.com/"

rem 用 node 启动而不是 start 命令：cmd 的引号/代码页伺候不了带空格或中文的路径，
rem 而且 start 出去之后没人知道刚起来的是哪一个进程，也就没法记所有权。
"%NODEEXE%" "%RTP%" --launch-edge --base "%BATCHDIR%" --profile "%SANDBOX%" --port %CDPPORT% !URLARGS! > "%~dp0_启动浏览器结果.json" 2>&1

echo       正在等调试端口 ...
set "TRIES=0"
:waitport
set /a TRIES+=1
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try{ $null=(Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3); exit 0 }catch{ exit 1 }"
if errorlevel 1 if %TRIES% lss 25 goto :waitport
if errorlevel 1 goto :noport
echo       端口 OK
goto :afteredge

:hasport
echo [1/3] 调试端口已经在跑 —— 浏览器不用动，一个窗口都不会关。
timeout /t 2 /nobreak >nul

:afteredge
rem ============================================================
rem  【2026-10-11 修】"露窗口"挪到这里 —— 浏览器起来了、调试端口通了，它才有意义。
rem  冷启动（:waitport 走到"端口 OK"）和热启动（:hasport）最后都落到这个标签，
rem  所以只在这一处调用，就覆盖了冷启动和热启动两条路。
rem  （热启动那条路以前**根本没调过**它：浏览器在跑，但主窗口可能仍是隐藏的，
rem   用户照样看不到课程页。）
rem ============================================================
call :ShowAssistantWindow
echo.
echo [2/3] 等课程页加载 ...
timeout /t 8 /nobreak >nul

echo [3/3] 启动驱动器 ...
rem 先问共享模块：记录里那个 PID **到底是不是**驱动器（PID + 创建时间 + node + driver.js 完整路径）。
rem 旧版只 tasklist 看 PID 在不在，PID 被回收给别的进程之后会误判成"已经在跑"、
rem 或者反过来让「停止」去杀一个无关进程。
set "DRV="
rem 【判活改成"看退出码"（2026-10-11）】
rem 旧写法是 echo !DRV! | findstr /c:"\"alive\":true" —— 实测在真实 cmd.exe 里
rem 连"alive 明明是 true"的合成输出都匹配不上（引号+反斜杠的写法不可移植）。
rem 而且它只判 alive，会漏掉 verified=false（PID 复用）那种最危险的误判。
rem 现在问 runtime-processes.js --status-exit：退出码 0 = 有一个身份验证通过的驱动器在跑。
rem 下面那句 for /f 只把文字原因读回来，失败时好让人看明白为什么。
"%NODEEXE%" "%~dp0..\runtime-processes.js" --status-exit --base "%BATCHDIR%" >nul 2>&1
if not errorlevel 1 goto :running


:startfresh
rem 【这里以前是 del "运行日志.txt"】上一轮为什么挂，就在点「开始」的瞬间被抹掉了。
rem 现在改成归档：交给共享模块 run-bootstrap.js 轮转（日志\运行日志-时间戳.txt，
rem 只保留最近 12 份，永不静默销毁旧日志），它同时写 本次运行.json（批次记录），
rem 界面靠它区分「本轮 / 上一轮」。批次来自当前环境或新生成，读回来交给外套；
rem 外套（驱动器循环.cmd）内部重拉时沿用同一个，不会产生新批次。
"%NODEEXE%" "%~dp0..\run-bootstrap.js" --base "%BATCHDIR%" > "!BSRESULT!" 2>&1
set "NEWBATCH="
if exist "!BSRESULT!" for /f "usebackq tokens=2 delims==" %%b in ("!BSRESULT!") do if not defined NEWBATCH set "NEWBATCH=%%b"
if exist "!BSRESULT!" del "!BSRESULT!" >nul 2>&1
if defined NEWBATCH set "DSH_BATCH=!NEWBATCH!"
del "_内部\停止标记.txt" >nul 2>&1
start "学习通驱动器" /min cmd /c "_内部\驱动器循环.cmd"
timeout /t 8 /nobreak >nul
set "NP="
if exist "运行中.pid" set /p NP=<运行中.pid
if not defined NP goto :startfail
rem 起来之后同样要**验证身份**（不只是 PID 在不在）：--status-exit 退出码 0 = alive && verified
"%NODEEXE%" "%~dp0..\runtime-processes.js" --status-exit --base "%BATCHDIR%" >nul 2>&1
if not errorlevel 1 goto :started
goto :startfail

:started
echo       驱动器已启动（PID !NP!，身份已验证）。
goto :done

:startfail
echo       [失败] 没看到驱动器起来。回控制台点 3 看日志里写了什么。
pause
exit /b 1

:running
echo       驱动器已经在跑了，不重复启动。
echo       （判断依据：锁文件里的 PID + 进程创建时间 + driver.js 完整路径全部对上）

:done
echo.
echo ============================================================
echo   已经在跑了。
echo.
echo     看进度   回控制台点 3
echo     停止     回控制台点 2
echo.
echo   这个窗口本身现在关掉没关系（按键马上关；不管它，60 秒后自己也会关）。
echo ============================================================
rem 【修 2026-10-11】这里原来是一个**裸 pause**。它会跟 控制台.ps1 里的 -Wait 互相死等：
rem   -Wait 在等本脚本退出，本脚本在等用户在这个窗口按键，而用户正盯着控制台 ——
rem   结果那个控制台再也回不到菜单，看着就是"无响应"（实测两个进程一起挂住半小时）。
rem 现在换成**带超时、且允许按键跳过**的等待：timeout 不带 /nobreak，
rem 按任意键立刻走；没人管它，60 秒后也自己走。
rem 失败路径（:startfail / :noport）**保留裸 pause** —— 那是必须让人看见的错误；
rem 控制台那边也有 300 秒上限兜底，不会因为它再死等。
timeout /t 60 >nul
exit /b 0

:noport
echo.
echo [失败] 等不到调试端口。
echo   常见原因：9222 被别的程序占用，或者杀毒软件拦了。
echo   启动结果的原始回话在 _内部\_启动浏览器结果.json，可以打开看看。
pause
exit /b 1

rem ============================================================
rem  【2026-10-11 新增】露出助手窗口，并报**真实结论**。
rem  做成子过程的原因：冷启动（端口不在 → 现起浏览器 → 等到端口 OK）和热启动
rem  （:hasport）最后都会落到 :afteredge，在那里 call 一次就覆盖两条路。
rem  以前这段代码在"启动浏览器"之前 —— 冷启动时浏览器进程还不存在，脚本第一步
rem  就返回 NO_EDGE_PROCESS，白跑一场，却照样打印"助手窗口已自动显示"。
rem  它只按所有权记录里的 PID 找窗口，不碰用户自己的 Edge。
rem  结论（脚本输出的第一行第一个词）：
rem    SHOWN            已显示出来
rem    STILL_HIDDEN     调了但没变成可见
rem    NO_MAIN_WINDOW   找不到够大的主窗口（可能起得慢）
rem    NO_EDGE_PROCESS  按"独立 profile + 端口"找不到浏览器进程
rem    NO_OWNER_FILE    还没写下所有权记录
rem    NO_PID           所有权记录里没有 PID
rem  原始回话全文在 _内部\_显示窗口结果.txt。
rem ============================================================
:ShowAssistantWindow
if not exist "%~dp0显示助手窗口.ps1" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0显示助手窗口.ps1" > "%~dp0_显示窗口结果.txt" 2>&1
set "WSTAT="
if exist "%~dp0_显示窗口结果.txt" for /f "usebackq tokens=1" %%w in ("%~dp0_显示窗口结果.txt") do if not defined WSTAT set "WSTAT=%%w"
if not defined WSTAT set "WSTAT=UNKNOWN"
if /i "!WSTAT!"=="SHOWN"           echo       助手窗口已显示出来（!WSTAT!）。
if /i "!WSTAT!"=="STILL_HIDDEN"    echo       [注意] 窗口没能显示（!WSTAT!）—— 请在任务栏里手动找一下那个 Edge 窗口。
if /i "!WSTAT!"=="NO_MAIN_WINDOW"  echo       [注意] 还没找到助手窗口（!WSTAT!）—— 浏览器可能起得慢，等几秒再看一眼。
if /i "!WSTAT!"=="NO_EDGE_PROCESS" echo       [注意] 没找到助手那个浏览器进程（!WSTAT!）—— 课程页可能没打开。
if /i "!WSTAT!"=="NO_OWNER_FILE"   echo       [注意] 还没写下浏览器所有权记录（!WSTAT!）。
if /i "!WSTAT!"=="NO_PID"          echo       [注意] 所有权记录里没有 PID（!WSTAT!）。
if not "!WSTAT!"=="SHOWN"          echo       （结论 "!WSTAT!" 的原始回话在 _内部\_显示窗口结果.txt）
exit /b 0
