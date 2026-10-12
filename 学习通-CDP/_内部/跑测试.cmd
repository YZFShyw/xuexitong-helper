@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
set "ROOT=%CD%"
set "RUNNER=%ROOT%\tests\run-offline-tests.js"

rem ==================================================================
rem  Offline test launcher - one click, no browser, no user files.
rem
rem  This .cmd is deliberately pure ASCII and only ever prints ASCII.
rem  The code page is set to 65001 (UTF-8) and every Chinese line comes
rem  from tests\run-offline-tests.js (a UTF-8 file) or from the encoded
rem  PowerShell one-liners below. ASCII bytes mean the same thing in GBK
rem  and in UTF-8, so this file cannot turn into mojibake, and the UTF-8
rem  output from node is never mixed with GBK batch text.
rem
rem  What runs: every tests\*.test.js, each in its own node process.
rem  The scripts under the experiment folder are NOT run from here.
rem
rem  Exit code is passed straight through:
rem    0 = all tests passed
rem    1 = some test failed, or a test file could not start
rem    2 = nothing to run / bad arguments / launcher problem
rem
rem  Usage:  double-click                     run, then wait for a key
rem          this file --no-pause              run, exit immediately
rem          this file --only=web,quiz         only matching files
rem          this file --list                  list files, run nothing
rem ==================================================================

rem ---- should we wait for a key at the end? (--no-pause = no) ----
set "WAIT=1"
if not "%~1"=="" for %%A in (%*) do if /i "%%~A"=="--no-pause" set "WAIT=0"

rem ---- find node.exe: copy inside this package first, then this PC ----
set "NODEEXE="
if exist "%ROOT%\node\node.exe" set "NODEEXE=%ROOT%\node\node.exe"
if not defined NODEEXE if exist "%~dp0node\node.exe" set "NODEEXE=%~dp0node\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE (
	for %%N in (node.exe) do if not defined NODEEXE set "NODEEXE=%%~$PATH:N"
)

if not defined NODEEXE goto :nonode
if not exist "%RUNNER%" goto :norunner

rem ==================================================================
rem  Run it. Always pass --no-pause down: the pause is done right here,
rem  after the exit code has been captured, so waiting for a key can
rem  never hide the real exit code.
rem  Arguments are passed through, so --only= / --list / --help work too.
rem ==================================================================
"%NODEEXE%" "%RUNNER%" --no-pause %*
set "RC=%ERRORLEVEL%"

echo.
if "%WAIT%"=="1" pause
exit /b %RC%

rem ==================================================================
rem  node.exe not found. One ASCII line first (always readable), then
rem  the same hint in Chinese from an encoded PowerShell command.
rem  Regenerate such a blob with:
rem    $s = "...."; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($s))
rem ==================================================================
:nonode
echo.
echo   [X] node.exe not found - the offline tests need Node.js to run.
powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "VwByAGkAdABlAC0ASABvAHMAdAAgACcAJwA7ACAAVwByAGkAdABlAC0ASABvAHMAdAAgACcAIAAgAKFsCWd+YjBSIABuAG8AZABlAC4AZQB4AGUAIAAUIBQgIAC7eb9+S23Vi4GJYJcgAE4AbwBkAGUALgBqAHMAIABNYv2A0Y0CMCcAOwAgAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAnACAAIADFiH1ZDlTNkbBlzFP7USxnh2X2TnNT71Mb/19O71PlTopiIABuAG8AZABlAC4AZQB4AGUAIAA+ZduPLGcFU4R2IABuAG8AZABlACAAh2X2TjlZAjAnADsAIABXAHIAaQB0AGUALQBIAG8AcwB0ACAAJwAgACAAC059jzBXQFca/2gAdAB0AHAAcwA6AC8ALwBuAG8AZABlAGoAcwAuAG8AcgBnAC8AJwA7ACAAVwByAGkAdABlAC0ASABvAHMAdAAgACcAJwA=" 2>nul
echo.
if "%WAIT%"=="1" pause
exit /b 1

rem ==================================================================
rem  The runner file itself is missing - put it back from the package.
rem ==================================================================
:norunner
echo.
echo   [X] Missing file: tests\run-offline-tests.js
powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "VwByAGkAdABlAC0ASABvAHMAdAAgACcAJwA7ACAAVwByAGkAdABlAC0ASABvAHMAdAAgACcAIAAgABFchk4gAHQAZQBzAHQAcwBcAHIAdQBuAC0AbwBmAGYAbABpAG4AZQAtAHQAZQBzAHQAcwAuAGoAcwAM/9mPKk5lUeNTMVzqU2lSg1sATipOgYnRjYR2HE5/iQIwJwA7ACAAVwByAGkAdABlAC0ASABvAHMAdAAgACcAIAAgAM5OB1n9ThZii1MpfwVTzJGKYiAAdABlAHMAdABzAFwAcgB1AG4ALQBvAGYAZgBsAGkAbgBlAC0AdABlAHMAdABzAC4AagBzACAAPmXeVmVnMVxMiAIwJwA7ACAAVwByAGkAdABlAC0ASABvAHMAdAAgACcAJwA=" 2>nul
echo.
if "%WAIT%"=="1" pause
exit /b 1
