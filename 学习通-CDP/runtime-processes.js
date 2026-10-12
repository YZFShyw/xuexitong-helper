/* 学习通助手 · 进程身份与所有权（driver.js / 控制台.ps1 / _内部\*.cmd 共用）
 *
 * 这个文件只做一件事：**在动一个进程之前，先证明它就是我们的那一个**。
 *
 * 为什么非要单独做一层（三次真实事故换来的）：
 *   ① 旧版"驱动器在不在跑"只看 运行中.pid + process.kill(pid, 0)。
 *      驱动器被强杀/崩溃时 pid 文件残留，Windows 把那个 PID 回收给别的程序之后：
 *        · 下一次启动被"已经有一个在跑了"挡住；
 *        · 点「停止」会 taskkill /f 一个完全无关的进程。
 *   ② 旧版关浏览器是 taskkill /f /im msedge.exe —— 按映像名全杀，
 *      连用户自己正在填表单的那个 Edge 一起关掉。
 *   ③ 只按端口 9222 判断"这是我的浏览器"也不成立：端口是用户可能自己开的，
 *      别的程序也可能占着。必须看**完整的 --user-data-dir 参数**。
 *
 * 所以这里的规矩是：
 *   · 认一个进程 = PID + 进程创建时间 + 映像名 + 命令行里的**完整路径参数**，四样都要对上；
 *   · 命令行参数按 Windows 规则解析（引号、反斜杠转义），不做"字符串包含"式匹配，
 *     否则 C:\a\b 会匹配到 C:\a\bc，C:\x\driver.js 会匹配到 C:\x\driver.js.bak；
 *   · 任何一步拿不到证据 → 一律**不杀**，把原因写清楚返回。
 *
 * 本模块 require 时没有任何副作用（不写文件、不起进程、不读配置）。
 * 平台：Windows。非 Windows 上所有查询返回"查不到"，调用方按"验证失败"处理（不杀）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/* 锁定/所有权文件一律落在"调用方给的目录"里，模块自己不留状态 */
const LOCK_FILE = '驱动器锁.json';
const LEGACY_PID_FILE = '运行中.pid';
const EDGE_OWN_FILE = '助手Edge所有权.json';

/* ---------------- 小工具 ---------------- */

/** 解析失败一律返回 ''，绝不抛 —— 调用方全靠它判断"有没有证据" */
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/^"|"$/g, '');
  if (!s) return '';
  try { s = path.resolve(s); } catch (e) { return ''; }
  /* Windows 上大小写不敏感，统一小写再比；分隔符统一成 \ */
  return s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 两个路径是不是同一个（精确，不做子串匹配） */
function pathEquals(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * 一个路径是不是"某个路径参数"本身（允许它下面，但**仍然**要求整段或整层相等）。
 * 绝不允许 C:\a\b 命中 C:\a\bc。
 */
function isSameOrInside(child, parent) {
  const nc = normalizePath(child);
  const np = normalizePath(parent);
  if (!nc || !np) return false;
  return nc === np || nc.startsWith(np + '\\');
}

/**
 * 按 Windows 命令行规则把一个 argv 串切回参数数组。
 *   "C:\Program Files\a\b.exe" --user-data-dir="C:\x y\p" --remote-debugging-port=9222
 * 规则：空格分参数；双引号成对；"" 在引号内表示一个字面引号；
 *       反斜杠只在自己后面紧跟引号时才是转义（这是 CommandLineToArgvW 的规则，
 *       所以路径末尾的 C:\ 不会把引号吃掉）。
 */
function parseWindowsCommandLine(cmdline) {
  const s = String(cmdline == null ? '' : cmdline);
  const out = [];
  let cur = '';
  let has = false;
  let inQuote = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) { cur += '"'; i++; } else { inQuote = !inQuote; i++; }
        has = true;
      } else {
        cur += '\\'.repeat(n);
        has = true;
      }
      continue;
    }
    if (ch === '"') { inQuote = !inQuote; has = true; i++; continue; }
    if (!inQuote && (ch === ' ' || ch === '\t')) {
      if (has || cur) { out.push(cur); cur = ''; has = false; }
      i++;
      continue;
    }
    cur += ch;
    has = true;
    i++;
  }
  if (has || cur) out.push(cur);
  /* 第一个参数是映像路径，单独放在 exe 里，剩下的才是开关 */
  return { exe: out.length ? out[0] : '', args: out.slice(1) };
}

/** 取 --flag=value 的 value（大小写不敏感；只认"整条相等"的 flag 名）
 *  取不到返回 null —— 调用方必须把 null 当"没有证据"，不要当空字符串用。
 *  注意：`--user-data-dir` 这种**必须带值**的开关，写成裸 `--user-data-dir`
 *  是畸形命令行，这里也返回 null（宁可认不出来，也不要拿一个空路径去比。 */
function argValue(args, flag) {
  if (!Array.isArray(args)) return null;
  const want = String(flag).toLowerCase().replace(/^--?/, '');
  for (const a of args) {
    const s = String(a);
    const eq = s.indexOf('=');
    /* 开关名要去掉前导的 -- 或 / 再比：Windows 上两种写法都合法（--flag / /flag），
       而且 cmd 里常写成 /flag=value。漏了这一步会让 --user-data-dir 永远匹配不上。 */
    const name = (eq >= 0 ? s.slice(0, eq) : s).toLowerCase().replace(/^\/+/, '').replace(/^--?/, '');
    if (name === want) return eq >= 0 ? s.slice(eq + 1) : null;
  }
  return null;
}

/** 有没有这个开关（--flag 或 --flag=...） */
function hasArg(args, flag) {
  if (!Array.isArray(args)) return false;
  const want = String(flag).toLowerCase().replace(/^--?/, '');
  for (const a of args) {
    const s = String(a);
    const eq = s.indexOf('=');
    const name = (eq >= 0 ? s.slice(0, eq) : s).toLowerCase().replace(/^\/+/, '').replace(/^--?/, '');
    if (name === want) return true;
  }
  return false;
}

/** 进程创建时间归一化：接受 Date / ISO 串 / 各种能 Date.parse 的串，失败返回 '' */
function normalizeStartTime(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return isFinite(v.getTime()) ? String(v.getTime()) : '';
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return s;              /* 已经是毫秒时间戳 */
  const t = Date.parse(s);
  return isFinite(t) ? String(t) : '';
}

/* ---------------- 查询本机进程（只读） ---------------- */

/* 读命令行的 C# 片段：走 NtQueryInformationProcess + ReadProcessMemory，
 * 读 PEB -> ProcessParameters(+0x20) -> CommandLine(+0x70)。
 * 这几个偏移是实测出来的（见文件头注释里的验证过程）：
 *   PEB.ProcessParameters 在 +0x20；RTL_USER_PROCESS_PARAMETERS.CommandLine 在 +0x70，
 *   那是个 UNICODE_STRING（Length/MaximumLength 在 +0，Buffer 指针在 +8）。
 * 为什么不用 WMI 的 CommandLine：WMI 在受限环境里直接被拒（整张表是空的）。
 * 为什么直接内嵌 C#：Add-Type 编译一次约 300~600ms，一次运行才查几次，
 *   不值得为它引入构建步骤或额外文件。编译失败也不致命 —— 那时候就是"读不到命令行"，
 *   调用方会按"没有证据"处理（拒绝杀进程），不会误杀。 */
const CS_CMD_READER = [
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class DshCmd {',
  '  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int p);',
  '  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);',
  '  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, IntPtr buf, IntPtr size, out IntPtr read);',
  '  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr info, int len, out int ret);',
  '  /* 一次开进程句柄，同时拿父 PID 和命令行：返回 "ppid|cmdline"。',
  '     单进程一次调用，避免为了 370 个进程开 700 次句柄。 */',
  '  public static string Info(int pid) {',
  '    IntPtr h = OpenProcess(0x0410, false, pid);',
  '    if (h == IntPtr.Zero) return "0|";',
  '    IntPtr bi = IntPtr.Zero, tmp = IntPtr.Zero, uni = IntPtr.Zero, buf = IntPtr.Zero, w64 = IntPtr.Zero;',
  '    try {',
  '      bi = Marshal.AllocHGlobal(64); tmp = Marshal.AllocHGlobal(64);',
  '      uni = Marshal.AllocHGlobal(16); buf = Marshal.AllocHGlobal(65536); w64 = Marshal.AllocHGlobal(8);',
  '      for (int i = 0; i < 64; i++) Marshal.WriteByte(bi, i, 0);',
  '      int rl;',
  '      if (NtQueryInformationProcess(h, 0, bi, 48, out rl) != 0) return "0|";',
  '      /* 父 PID 在 PROCESS_BASIC_INFORMATION 的 +0x28。',
  '         注意别读成 +0x14：那是 AffinityMask 的高 32 位（实测永远是 0），',
  '         照那个写会得到"所有进程的父 PID 都是 0"，看着像功能正常其实全是错的。 */',
  '      int ppid = Marshal.ReadInt32(bi, 0x28);',
  '      long peb = Marshal.ReadInt64(bi, 8);',
  '      /* 32 位进程（WOW64）的 PEB 布局不一样，宁可读不到也不要读出一堆垃圾 */',
  '      if (peb <= 0) return ppid + "|";',
  '      if (NtQueryInformationProcess(h, 26, w64, 8, out rl) == 0 && Marshal.ReadInt64(w64) != 0) return ppid + "|";',
  '      IntPtr got;',
  '      if (!ReadProcessMemory(h, (IntPtr)(peb + 0x20), tmp, (IntPtr)8, out got)) return ppid + "|";',
  '      long pp = Marshal.ReadInt64(tmp);',
  '      if (pp <= 0x1000) return ppid + "|";',
  '      if (!ReadProcessMemory(h, (IntPtr)(pp + 0x70), uni, (IntPtr)16, out got)) return ppid + "|";',
  '      int len = (int)(Marshal.ReadInt64(uni) & 0xffff);',
  '      long pb = Marshal.ReadInt64(uni, 8);',
  '      if (len <= 0 || len > 65534 || pb <= 0x1000) return ppid + "|";',
  '      if (!ReadProcessMemory(h, (IntPtr)pb, buf, (IntPtr)len, out got)) return ppid + "|";',
  '      return ppid + "|" + Marshal.PtrToStringUni(buf, len / 2);',
  '    } catch { return "0|"; } finally {',
  '      if (bi != IntPtr.Zero) Marshal.FreeHGlobal(bi);',
  '      if (tmp != IntPtr.Zero) Marshal.FreeHGlobal(tmp);',
  '      if (uni != IntPtr.Zero) Marshal.FreeHGlobal(uni);',
  '      if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);',
  '      if (w64 != IntPtr.Zero) Marshal.FreeHGlobal(w64);',
  '      CloseHandle(h);',
  '    }',
  '  }',
  '}',
].join('\n');

const PS_QUERY = [
  '$ErrorActionPreference="Continue"',
  "$srcPath = Join-Path $env:TEMP ('dsh-cmd-' + [guid]::NewGuid().ToString('N') + '.cs')",
  'try {',
  "  [System.IO.File]::WriteAllText($srcPath, $env:DSH_CMD_SRC, [System.Text.UTF8Encoding]::new($false))",
  '  Add-Type -Path $srcPath -ErrorAction Stop | Out-Null',
  '  $script:DshCmdOk = $true',
  '} catch { $script:DshCmdOk = $false }',
  'finally { try { Remove-Item -LiteralPath $srcPath -Force -ErrorAction SilentlyContinue } catch { } }',
  'function Dsh-Start([object]$p) {',
  '  try { if ($p.StartTime) { return $p.StartTime.ToUniversalTime().Ticks.ToString() } } catch { }',
  '  return ""',
  '}',
  '$rows = @()',
  'foreach ($p in (Get-Process)) {',
  '  $n = [string]$p.ProcessName',
  '  $exe = ""',
  '  try { $exe = [string]$p.Path } catch { }',
  '  $cl = ""; $ppid = 0',
  '  # 只给"可能是我们那几个"读父进程/命令行：node（驱动器）、msedge（助手浏览器）、',
  '  # cmd/powershell/pwsh（外套与启动脚本）。全表都读会白等（实测能拖到 20 秒以上）。',
  '  if ($script:DshCmdOk -and ($n -imatch "^(node|msedge|cmd|powershell|pwsh)$")) {',
  '    try {',
  '      $info = [string][DshCmd]::Info([int]$p.Id)',
  '      $i2 = $info.IndexOf("|")',
  '      if ($i2 -gt 0) {',
  '        $ppid = [int]$info.Substring(0, $i2)',
  '        $cl = $info.Substring($i2 + 1)',
  '      }',
  '    } catch { }',
  '  }',
  '  $rows += [pscustomobject]@{',
  '    pid     = [int]$p.Id',
  '    name    = [string]($n + ".exe")',
  '    exe     = $exe',
  '    cmdline = [string]$cl',
  '    ppid    = [int]$ppid',
  '    start   = (Dsh-Start $p)',
  '  }',
  '}',
  'ConvertTo-Json -InputObject $rows -Compress -Depth 3',
].join('\n');

/* 【为什么不直接 spawnSync(..., {encoding:'utf8'})】
 * 那样 Node 会开匿名管道去接输出，而匿名管道在受限环境里会被拒绝（EPERM），
 * 报出来的错还长得像"PowerShell 不存在"，很容易被误判成系统问题。
 * 这里改成把 stdout/stderr 重定向到临时文件，对沙箱/杀软都友好，
 * 也不受管道缓冲区大小限制（几千行进程信息完全够）。 */
function runCapture(exe, args, timeoutMs, extraEnv) {
  let dir = '';
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proc-')); } catch (e) { dir = ''; }
  const outFile = path.join(dir || os.tmpdir(), 'out-' + process.pid + '-' + Date.now() + '.txt');
  const errFile = path.join(dir || os.tmpdir(), 'err-' + process.pid + '-' + Date.now() + '.txt');
  let fo = null, fe = null;
  try {
    fo = fs.openSync(outFile, 'w');
    fe = fs.openSync(errFile, 'w');
    const env = Object.assign({}, process.env, extraEnv || {});
    const r = spawnSync(exe, args, {
      stdio: ['ignore', fo, fe],
      windowsHide: true,
      env,
      timeout: Math.max(1000, Number(timeoutMs) || 15000),
    });
    fs.closeSync(fo); fo = null;
    fs.closeSync(fe); fe = null;
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
    return {
      ok: !r.error,
      error: r.error || null,
      status: r.status,
      timedOut: !!(r.error && (r.error.code === 'ETIMEDOUT' || r.signal)),
      stdout: read(outFile),
      stderr: read(errFile),
    };
  } catch (e) {
    return { ok: false, error: e, status: null, timedOut: false, stdout: '', stderr: '' };
  } finally {
    if (fo !== null) { try { fs.closeSync(fo); } catch (e) {} }
    if (fe !== null) { try { fs.closeSync(fe); } catch (e) {} }
    for (const f of [outFile, errFile]) { try { fs.unlinkSync(f); } catch (e) {} }
    if (dir) { try { fs.rmdirSync(dir); } catch (e) {} }
  }
}

function runPowershell(script, timeoutMs, extraEnv) {
  const exe = process.env.DSH_POWERSHELL || 'powershell.exe';
  /* 【不要加 \uFEFF】-EncodedCommand 会把解出来的字符串直接当命令开头，
     前面多一个 BOM 就变成 "﻿Write-Output : 无法将该项识别为 cmdlet" 这种怪错。
     脚本里的中文用不着 BOM —— 参数是 UTF-16LE 给的，编码本来就不会错。 */
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return runCapture(exe, args, timeoutMs, extraEnv);
}

/* 默认的杀进程实现：**只按 PID**（绝不 /IM），并且不接管任何管道 */
function defaultKillPid(pid, force) {
  const args = ['/PID', String(pid)];
  if (force) args.unshift('/F');
  try {
    const r = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    return { ok: !r.error && r.status === 0, reason: r.error ? r.error.message : ('taskkill 退出码 ' + r.status) };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

/** 只读地列出本机进程；失败返回 {ok:false, reason, list:[]} */
function listProcesses() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: '不是 Windows，读不到进程表', list: [] };
  }
  const r = runPowershell(PS_QUERY, 60000, { DSH_CMD_SRC: CS_CMD_READER });
  if (!r || r.error) {
    return { ok: false, reason: '进程查询失败：' + ((r && r.error && r.error.message) || '未知'), list: [] };
  }
  const raw = String(r.stdout || '').trim();
  if (!raw) {
    return { ok: false, reason: '进程查询没返回内容（PowerShell 可能被禁用）', list: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, reason: '进程查询结果不是 JSON', list: [] }; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const list = [];
  for (const p of arr) {
    if (!p) continue;
    const pid = Number(p.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    list.push({
      pid,
      name: String(p.name || ''),
      exe: String(p.exe || ''),
      cmdline: String(p.cmdline || ''),
      ppid: Number.isInteger(Number(p.ppid)) ? Number(p.ppid) : 0,
      start: normalizeStartTime(p.start),
    });
  }
  return { ok: true, reason: '', list };
}

/* 测试钩子：只在测试里替换。生产代码永远走上面那条真实查询。 */
let queryProcesses = listProcesses;
let killPid = defaultKillPid;
function __setProcessHooksForTest(hooks) {
  if (!hooks || typeof hooks !== 'object') return;
  if (typeof hooks.queryProcesses === 'function') queryProcesses = hooks.queryProcesses;
  if (typeof hooks.killPid === 'function') killPid = hooks.killPid;
  invalidateCache();   /* 换了进程表来源，缓存必须作废（否则测试之间会串味） */
}
function __resetProcessHooksForTest() {
  queryProcesses = listProcesses;
  killPid = defaultKillPid;
  invalidateCache();
}

/* 一次查询同时给多个判断用（driver 的一个启动周期里会问好几次）。
   注意：**危险操作（stop*）永远强制实时查**，不吃这个缓存。 */
const CACHE_MS = 1500;
let cache = { at: 0, value: null };
function listProcessesCached() {
  const now = Date.now();
  if (cache.value && (now - cache.at) < CACHE_MS) return cache.value;
  const v = queryProcesses();
  cache = { at: now, value: v };
  return v;
}
function invalidateCache() { cache = { at: 0, value: null }; }

function findByPid(pid, list) {
  for (const p of list) if (p.pid === pid) return p;
  return null;
}

/* ---------------- 驱动器锁 ---------------- */

function lockPath(baseDir) { return path.join(baseDir, LOCK_FILE); }
function legacyPidPath(baseDir) { return path.join(baseDir, LEGACY_PID_FILE); }
function edgeOwnPath(baseDir) { return path.join(baseDir, EDGE_OWN_FILE); }

function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return { ok: false, reason: '文件是空的' };
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: '文件不存在' };
    return { ok: false, reason: '读不出来：' + ((e && e.message) || e) };
  }
}

/* 原子写：先写同目录的临时文件（同目录才能保证同一卷，rename 才是原子的），
   再 rename 顶上去。中途崩了也只会留下 .tmp，不会留下半截的正式文件。 */
function atomicWriteJson(file, obj) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) {}
    throw e;
  }
}

/** 这个锁记录自己的身份：PID + 创建时间 + 程序路径 + 驱动器脚本路径 */
function lockIdentity(lock) {
  if (!lock || typeof lock !== 'object') return null;
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const start = normalizeStartTime(lock.start);
  if (!start) return null;                 /* 没有创建时间 = 无法防 PID 复用，不算身份 */
  return {
    pid,
    start,
    exe: String(lock.exe || ''),
    script: String(lock.script || ''),
    batch: String(lock.batch || ''),
  };
}

/**
 * 判断"锁里记的那个进程"现在是不是仍然是同一个进程。
 * proc 为 null（进程不存在）→ ok:false。
 * 只有 PID 活着、但映像名/命令行/创建时间对不上 → 一律 ok:false（PID 复用）。
 */
function verifyDriverProcess(lock, proc, expectScript) {
  const id = lockIdentity(lock);
  if (!id) return { ok: false, reason: '锁里没有可验证的身份（缺 pid / 创建时间），不能认定它在跑' };
  if (!proc) return { ok: false, reason: 'PID ' + id.pid + ' 现在不存在（陈旧记录）' };
  const name = String(proc.name || '').toLowerCase();
  if (name !== 'node.exe') {
    return { ok: false, reason: 'PID ' + id.pid + ' 现在是 ' + (proc.name || '未知进程') + '，不是 node.exe（PID 被复用了）' };
  }
  const procStart = normalizeStartTime(proc.start);
  if (!procStart || procStart !== id.start) {
    return {
      ok: false,
      reason: 'PID ' + id.pid + ' 的创建时间跟锁里记的不一致（记 ' + id.start + '，实际 ' + (procStart || '读不到') + '）——PID 被复用了',
    };
  }
  const cmd0 = String(proc.cmdline || '');
  const parsed = parseWindowsCommandLine(cmd0);
  /* 命令行里必须有一个参数**正好是** driver.js 的完整路径。
     不接受"包含 driver.js 字样"：C:\x\driver.js.bak、C:\x\notdriver.js 都会命中，
     那正是最危险的误杀。 */
  const wantScript = normalizePath(expectScript || id.script);
  const allArgs = [parsed.exe].concat(parsed.args);
  let scriptOk = false;
  if (wantScript) {
    for (const a of allArgs) {
      if (pathEquals(a, wantScript)) { scriptOk = true; break; }
    }
  }
  if (!scriptOk) {
    /* 这里**不能**把 proc.cmdline 贴出来：那句话会原样进界面和日志，
       别人的进程参数（路径、命令行里的凭据、别的脚本名）就跟着泄出去了。
       说清楚"预期的身份对不上"和 PID 就够了 —— 判据本来就是完整路径相等。 */
    return {
      ok: false,
      reason: 'PID ' + id.pid + ' 的 node 命令行里没有预期的驱动脚本参数（' +
              path.basename(String(expectScript || id.script || 'driver.js')) +
              ' 的完整路径对不上）——身份验证不通过，不认定它是驱动器',
    };
  }
  /* 映像路径也对一下。**只在一方读得到时才算证据**：
     普通用户读别的用户的进程 Path 会失败（读成空），那种情况不能当成"身份不符"，
     否则一次正常的启动会被误判成 PID 复用。真正防 PID 复用的是创建时间。 */
  if (proc.exe && id.exe && !pathEquals(proc.exe, id.exe)) {
    return { ok: false, reason: 'PID ' + id.pid + ' 的 node 映像路径跟锁里记的不一样（' + proc.exe + ' ≠ ' + id.exe + '）' };
  }
  return { ok: true, reason: '身份验证通过（PID ' + id.pid + '，创建于 ' + id.start + '）' };
}

/**
 * 同步读"驱动器在不在跑"。**不会因为 PID 活着就认定驱动器**。
 * 返回 {pid, alive, verified, reason}
 *   alive   —— 现在是否还有一个**身份验证通过**的驱动器进程
 *   verified—— 上面那句话是否建立在完整身份验证上（true 才允许据此杀进程）
 *   pid     —— 记录的 PID（可能为 0 = 没记录）
 *
 * 注意：这里允许用短缓存（1.5 秒），因为它只用于"显示/判断能不能启动"。
 * **任何要杀进程的路径都必须走 stopVerifiedDriver（强制实时重查）。**
 */
function readVerifiedDriver(baseDir, opts) {
  const o = opts || {};
  const dir = baseDir || '.';
  const expectScript = o.driverScript || path.join(dir, 'driver.js');
  const lp = lockPath(dir);
  const read = readJsonFile(lp);
  if (!read.ok) {
    /* 没有锁文件：退回旧的 运行中.pid，但**只当线索**，必须重新验证身份 */
    const legacy = readLegacyPidHint(dir, expectScript);
    if (legacy.pid) return legacy;
    return { pid: 0, alive: false, verified: false, reason: '没有锁文件（' + read.reason + '）' };
  }
  const lock = read.value;
  const id = lockIdentity(lock);
  if (!id) {
    return { pid: Number(lock && lock.pid) || 0, alive: false, verified: false,
             reason: '锁文件内容不完整，无法确认身份', lockCorrupt: true };
  }
  const res = o.fresh ? queryProcesses() : listProcessesCached();
  if (!res.ok) {
    /* 查不到进程表：绝不说"没在跑"，也绝不说"在跑" —— 交给调用方处理 */
    return { pid: id.pid, alive: false, verified: false, reason: '查不到进程表，无法判活：' + res.reason,
             probeFailed: true, batch: id.batch };
  }
  const proc = findByPid(id.pid, res.list);
  const v = verifyDriverProcess(lock, proc, expectScript);
  return { pid: id.pid, alive: !!v.ok, verified: !!v.ok, reason: v.reason, batch: id.batch };
}

/** 旧 运行中.pid：只当线索，读到 PID 之后照样要验身份 */
function readLegacyPidHint(dir, expectScript) {
  const fp = legacyPidPath(dir);
  let raw = '';
  try { raw = fs.readFileSync(fp, 'utf8').trim(); } catch (e) {
    return { pid: 0, alive: false, verified: false, reason: '旧 运行中.pid 也读不到（' + ((e && e.code) || e.message) + '）' };
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid: 0, alive: false, verified: false, reason: '旧 运行中.pid 内容不是合法 PID（' + raw.slice(0, 20) + '）' };
  }
  const res = listProcessesCached();
  if (!res.ok) {
    return { pid, alive: false, verified: false, probeFailed: true, reason: '查不到进程表，无法判活：' + res.reason };
  }
  const proc = findByPid(pid, res.list);
  if (!proc) return { pid, alive: false, verified: false, reason: '旧 运行中.pid 里的 PID ' + pid + ' 已经不存在（陈旧记录）' };
  const name = String(proc.name || '').toLowerCase();
  if (name !== 'node.exe') {
    return { pid, alive: false, verified: false,
             reason: '旧 运行中.pid 里的 PID ' + pid + ' 现在是 ' + (proc.name || '未知进程') + '，不是驱动器（PID 被复用了）' };
  }
  const parsed = parseWindowsCommandLine(String(proc.cmdline || ''));
  const allArgs = [parsed.exe].concat(parsed.args);
  const want = normalizePath(expectScript);
  let scriptOk = false;
  for (const a of allArgs) if (want && pathEquals(a, want)) { scriptOk = true; break; }
  if (!scriptOk) {
    return { pid, alive: false, verified: false,
             reason: '旧 运行中.pid 里的 PID ' + pid + ' 是 node，但命令行里没有预期的驱动脚本参数（' +
                     path.basename(String(expectScript || 'driver.js')) + ' 的完整路径对不上，不是驱动器）' };
  }
  /* 没有创建时间可比 —— 只能说"看起来是"，不算完全验证 */
  return { pid, alive: true, verified: false, legacy: true,
           reason: '旧 运行中.pid 指向的 node 驱动着 ' + path.basename(expectScript) + '，但没有创建时间可比，只当线索',
           proc };
}

/**
 * 抢占驱动器锁（原子）。返回
 *   {ok:true,  tookOver:boolean, reason}
 *   {ok:false, reason, holder:{pid,reason}}   —— 已经有一个真的在跑，本次不许启动
 *   {ok:false, reason, metaFailed:true}       —— 锁写不进去：**明确失败**，不静默继续
 */
function acquireDriverLock(baseDir, info) {
  const dir = baseDir || '.';
  const i = info || {};
  const me = Number(i.pid);
  if (!Number.isInteger(me) || me <= 0) {
    return { ok: false, metaFailed: true, reason: '本进程 PID 不是正常值（' + i.pid + '），不能写锁' };
  }
  const start = normalizeStartTime(i.start);
  if (!start) {
    return { ok: false, metaFailed: true, reason: '读不到本进程的创建时间，"防 PID 复用"的前提不成立，不能写锁' };
  }
  const script = i.driverScript || path.join(dir, 'driver.js');
  const payload = {
    v: 1,
    pid: me,
    start,
    exe: String(i.exe || process.execPath || ''),
    script,
    batch: String(i.batch || ''),
    token: String(i.token || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2))),
    at: new Date().toISOString(),
  };
  const lp = lockPath(dir);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const cur = readJsonFile(lp);
    if (cur.ok) {
      const id = lockIdentity(cur.value);
      const samePidStart = id && id.pid === me && id.start === start;
      if (!samePidStart) {
        const res = queryProcesses();
        if (!res.ok) {
          return { ok: false, reason: '读不到进程表，无法确认锁的主人是不是还在跑：' + res.reason };
        }
        const proc = id ? findByPid(id.pid, res.list) : null;
        const v = verifyDriverProcess(cur.value, proc, String((id && id.script) || script));
        if (v.ok) {
          return { ok: false, reason: '已经有一个驱动器在跑（PID ' + id.pid + '，创建于 ' + id.start + '）',
                   holder: { pid: id.pid, start: id.start, batch: id.batch } };
        }
        /* 验证不过 = 陈旧锁。删掉再抢。删不动也不算致命：下面 rename 会顶上去，
           但一定要把原因写进日志（绝不能悄悄变成"两个实例一起跑"）。 */
        const staleWhy = v.reason;
        try { fs.unlinkSync(lp); } catch (e) {
          if (e && e.code !== 'ENOENT') {
            return { ok: false, metaFailed: true,
                     reason: '发现一个无法验证身份的旧锁（' + staleWhy + '），又删不掉它：' + e.message };
          }
        }
      }
    } else if (cur.reason !== '文件不存在') {
      /* 锁文件坏了。它可能是别人正在写的半截内容 —— 先给它一点时间，
         但绝不能让"文件坏了"变成"那就一起跑吧"。 */
      if (attempt < 4) {
        const wait = 40 * attempt;
        const until = Date.now() + wait;
        while (Date.now() < until) { /* 同步等一小会：启动路径上就这么几毫秒 */ }
        continue;
      }
      try { fs.unlinkSync(lp); } catch (e) {
        return { ok: false, metaFailed: true, reason: '锁文件已损坏（' + cur.reason + '）且删不掉：' + e.message };
      }
    }

    try {
      atomicWriteJson(lp, payload);
    } catch (e) {
      return { ok: false, metaFailed: true, reason: '写锁失败：' + ((e && e.message) || e) };
    }
    /* rename 之后再读回来确认里面的 token 还是我的 —— 防"两个进程同时抢、后写的赢" */
    const back = readJsonFile(lp);
    if (back.ok && back.value && back.value.token === payload.token && Number(back.value.pid) === me) {
      return { ok: true, tookOver: false, reason: '锁已取得' };
    }
    /* 被抢了：退一步重来（重来时如果对方已经是"验证通过的在跑"，上面会直接拒绝启动） */
    const until = Date.now() + 120 * attempt;
    while (Date.now() < until) { /* 退避 */ }
  }
  return { ok: false, reason: '抢锁连续失败（另一个进程在同时启动），本次不启动' };
}

/** 退出时只清自己的锁：内容不是我的就一个字节都不动 */
function releaseDriverLock(baseDir, opts) {
  const dir = baseDir || '.';
  const o = opts || {};
  const lp = lockPath(dir);
  const cur = readJsonFile(lp);
  if (!cur.ok) return { ok: true, removed: false, reason: '没有锁文件（' + cur.reason + '）' };
  const samePid = Number(cur.value && cur.value.pid) === Number(o.pid);
  const sameToken = o.token ? String(cur.value && cur.value.token) === String(o.token) : true;
  if (!samePid || !sameToken) {
    return { ok: false, removed: false, reason: '锁现在不是本进程的（pid=' + (cur.value && cur.value.pid) + '），不动它' };
  }
  try {
    fs.unlinkSync(lp);
    return { ok: true, removed: true, reason: '已清掉自己的锁' };
  } catch (e) {
    return { ok: false, removed: false, reason: '删锁失败：' + ((e && e.message) || e) };
  }
}

/** 兼容显示用：把当前驱动器 PID 写进旧的 运行中.pid（内容校验交给调用方） */
function writeLegacyPidFile(baseDir, pid) {
  try {
    fs.writeFileSync(legacyPidPath(baseDir), String(pid), 'utf8');
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: '写 运行中.pid 失败：' + ((e && e.message) || e) };
  }
}
function removeLegacyPidFileIfOwn(baseDir, pid) {
  try {
    const fp = legacyPidPath(baseDir);
    if (Number(fs.readFileSync(fp, 'utf8').trim()) === Number(pid)) { fs.unlinkSync(fp); return { ok: true }; }
    return { ok: false, reason: '内容不是本进程的，不动它' };
  } catch (e) { return { ok: false, reason: String((e && e.code) || e.message) }; }
}

/** 现读本进程的创建时间（写锁要用；读不到就返回 ''，调用方据此拒绝启动） */
function currentProcessStart() {
  invalidateCache();
  const res = queryProcesses();
  if (!res.ok) return { ok: false, reason: res.reason };
  const me = findByPid(process.pid, res.list);
  if (!me) return { ok: false, reason: '进程表里找不到自己（PID ' + process.pid + '）' };
  const start = normalizeStartTime(me.start);
  if (!start) return { ok: false, reason: '自己的创建时间读不到' };
  return { ok: true, start, exe: me.exe || process.execPath || '', reason: '' };
}

/* ---------------- 驱动器停止 ---------------- */

/**
 * 停止"身份验证通过的驱动器"。**任何一步对不上就什么都不杀。**
 * 返回 {ok, pid, reason, killed}
 * 验证内容：node.exe 映像 + 创建时间 == 锁里记的 + 命令行里有完整 driver.js 路径。
 * 注意：这里**强制实时重查进程表**（不吃缓存）—— 杀进程是危险动作。
 */
async function stopVerifiedDriver(baseDir, opts) {
  const dir = baseDir || '.';
  const o = opts || {};
  const expectScript = o.driverScript || path.join(dir, 'driver.js');
  const fresh = readVerifiedDriver(dir, { driverScript: expectScript, fresh: true });
  if (!fresh.pid) return { ok: true, killed: false, pid: 0, reason: '没有驱动器记录，不用停（' + fresh.reason + '）' };
  if (fresh.probeFailed) return { ok: false, killed: false, pid: fresh.pid, reason: '查不到进程表，拒绝杀进程：' + fresh.reason };
  if (!fresh.alive) {
    /* 记录还在、但它已经**不是**驱动器了（陈旧记录 / PID 被复用 / 指向别的进程）。
       这时候顺手把作废的记录清掉 —— 不清的话，控制台会一直显示一条没用的记录，
       用户也会以为"没在跑却停不掉"。清之前确认过：它确实没通过身份验证。
       注意：如果旧 pid 文件指向的进程**看起来还是** node+driver.js（只是没有创建时间可比），
       那就不动它 —— 那可能是另一个正在自己启动/收尾的驱动器写的。 */
    let cleaned = false;
    if (!fresh.legacy) {
      const lockRead2 = readJsonFile(lockPath(dir));
      if (lockRead2.ok) {
        const id2 = lockIdentity(lockRead2.value);
        const live2 = queryProcesses();
        const still = (id2 && live2.ok)
          ? verifyDriverProcess(lockRead2.value, findByPid(id2.pid, live2.list), expectScript)
          : { ok: false };
        if (!still.ok) { try { fs.unlinkSync(lockPath(dir)); cleaned = true; } catch (e) {} }
      }
      /* 旧 pid 文件：只有在"确实没有活着的驱动器"时才清（fresh.legacy 为假说明上面查过） */
      try { fs.unlinkSync(legacyPidPath(dir)); } catch (e) {}
    }
    return { ok: true, killed: false, pid: fresh.pid,
             reason: '记录里的 PID ' + fresh.pid + ' 不是驱动器（' + fresh.reason + '），一个进程都没动' +
                     (cleaned ? '；那条作废的记录已经清掉' : '') };
  }
  /* 再来一次完全独立的实时核验（防止上面那次和这次之间进程被换掉） */
  const res = queryProcesses();
  if (!res.ok) return { ok: false, killed: false, pid: fresh.pid, reason: '实时复查失败，拒绝杀进程：' + res.reason };
  const lockRead = readJsonFile(lockPath(dir));
  const lock = lockRead.ok ? lockRead.value : null;
  if (lock) {
    const proc = findByPid(fresh.pid, res.list);
    const v2 = verifyDriverProcess(lock, proc, expectScript);
    if (!v2.ok) return { ok: false, killed: false, pid: fresh.pid, reason: '复查不通过，拒绝杀进程：' + v2.reason };
  }
  const force = o.force !== false;
  const r = killPid(fresh.pid, force);
  invalidateCache();
  if (r.ok) return { ok: true, killed: true, pid: fresh.pid, reason: '已停止驱动器 PID ' + fresh.pid + '（身份验证通过）' };
  /* 第一下用强杀失败时再试一次温和的；两个都不成才报失败 */
  if (force) {
    const soft = killPid(fresh.pid, false);
    if (soft.ok) return { ok: true, killed: true, pid: fresh.pid, reason: '已停止驱动器 PID ' + fresh.pid + '（温和结束）' };
  }
  /* 【taskkill 报错 ≠ 没停成】
     实测会碰到这种情况：进程其实刚刚已经退出了，taskkill 只是"找不到该进程"而返回非 0。
     如果这时一律报失败，调用方（停止.cmd / 控制台）会以为"没能停掉"，
     于是残留的锁一直留着，下一次启动永远被"已经有一个在跑了"挡住 —— 一个死结。
     所以这里再实时看一次：**那个身份已经不在进程表里了**，就按"已经停了"算，
     顺手把作废的记录清掉（清之前会再确认一次身份，绝不误删别人的锁）。 */
  const after = queryProcesses();
  if (after.ok && lock) {
    const proc = findByPid(fresh.pid, after.list);
    /* 进程没了，或者那个 PID 现在换成了别的进程 —— 都算"驱动器已经不在了"。
       （lock 为 null 的情况上面已经按"复查不通过"拒过了，这里不会走到。） */
    const gone = !proc || !verifyDriverProcess(lock, proc, expectScript).ok;
    if (gone) {
      if (lockRead.ok) { try { fs.unlinkSync(lockPath(dir)); } catch (e) {} }
      try { fs.unlinkSync(legacyPidPath(dir)); } catch (e) {}
      return { ok: true, killed: false, pid: fresh.pid,
               reason: 'taskkill 报错（' + (r.reason || '未知') + '），但实时复查显示那个驱动器已经不在进程表里了 —— 按已停止处理，并清掉作废的记录' };
    }
  }
  return { ok: false, killed: false, pid: fresh.pid, reason: 'taskkill 失败：' + (r.reason || '未知') };
}

/* ---------------- 助手 Edge 的所有权 ---------------- */

/** 判断一条 msedge 命令行是不是"我们那个助手实例"
 * 要求：exe 是 msedge.exe；有 --user-data-dir 且**正好等于** profileDir；
 *       如果给了 port，则 --remote-debugging-port 必须等于它。
 *       （只给端口不认 —— 用户自己开的调试端口是合法用法，不能据此关人家的浏览器。）
 * 注意：msedge 的**子进程会继承父进程的 --user-data-dir**，所以这里不加 --type
 *       的过滤会在别处区分主进程（见 pickOwnedEdge）。 */
function classifyEdgeCommandLine(proc, profileDir, port) {
  const name = String((proc && proc.name) || '').toLowerCase();
  const { exe, args } = parseWindowsCommandLine((proc && proc.cmdline) || '');
  const exePath = String((proc && proc.exe) || exe || '');
  const base = exePath.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (base !== 'msedge.exe' || name !== 'msedge.exe') {
    return { ok: false, reason: '不是 msedge.exe 主进程（' + (name || base || '未知') + '）' };
  }
  const udd = argValue(args, '--user-data-dir');
  if (!udd) return { ok: false, reason: '命令行里没有 --user-data-dir' };
  if (!pathEquals(udd, profileDir)) {
    return { ok: false, reason: '--user-data-dir 不是我们那个独立 profile（' + udd + ' ≠ ' + profileDir + '）' };
  }
  if (port != null && port !== '') {
    const rp = argValue(args, '--remote-debugging-port');
    if (String(rp) !== String(port)) {
      return { ok: false, reason: '--remote-debugging-port 不是 ' + port + '（实际 ' + (rp || '没有') + '）' };
    }
  }
  return { ok: true, reason: '命令行与独立 profile 完全对上', isMain: !hasArg(args, '--type') };
}

/** 从一堆进程里挑出"唯一那个"助手 Edge：多一个候选就拒绝（宁可不关）
 *  Chromium 的规矩很好用：**只有主进程没有 --type**，渲染/GPU/网络等子进程都带
 *  --type=renderer|gpu-process|utility|...（虽然它们会继承 --user-data-dir）。
 *  先按这个挑；挑不出来再退回"父进程也在候选里"那套，最后宁可拒绝也不猜。 */
function pickOwnedEdge(list, profileDir, port) {
  const matched = [];
  let rejected = [];
  for (const p of list) {
    /* 只按映像名挑候选。**不做"命令行里含 msedge 字样"这种模糊匹配** ——
       那种写法会把 msedgewebview2.exe、或者别的恰好提到 msedge 的进程也拉进来。 */
    if (String(p.name || '').toLowerCase() !== 'msedge.exe') continue;
    const c = classifyEdgeCommandLine(p, profileDir, port);
    if (c.ok) matched.push(Object.assign({}, p, { __isMain: !!c.isMain }));
    else rejected.push({ pid: p.pid, why: c.reason });
  }
  if (matched.length === 0) {
    return { ok: false, reason: '没有进程的命令行对上 ' + profileDir + (port ? (' / 端口 ' + port) : ''), rejected };
  }
  const mains = matched.filter((p) => p.__isMain);
  const roots = mains.length
    ? mains
    : (() => {
        const pids = new Set(matched.map((p) => p.pid));
        const r = matched.filter((p) => !pids.has(p.ppid));
        return r.length ? r : matched;
      })();
  if (roots.length !== 1) {
    return { ok: false, reason: '对上的进程有 ' + roots.length + ' 个（分不清哪一个是助手主进程），拒绝认领',
             candidates: roots.map((p) => p.pid) };
  }
  return { ok: true, proc: roots[0], reason: '唯一对上' + (mains.length ? '（无 --type 的那个主进程）' : '（按父子关系）'), rejected };
}

/**
 * 记下"这个 msedge 主进程是我们自己启动的"。
 * 必须能明确认出来才记；认不出来就 ok:false（调用方据此在停止时拒绝关浏览器）。
 */
async function recordOwnedEdge(opts) {
  const o = opts || {};
  const dir = o.baseDir || '.';
  const profileDir = o.profileDir;
  const port = o.port;
  if (!profileDir) return { ok: false, reason: '没有给 profileDir，无法确认身份' };
  const res = queryProcesses();
  if (!res.ok) return { ok: false, reason: '查不到进程表：' + res.reason };
  const list = res.list;
  const found = o.pid
    ? (() => {
        const p = findByPid(Number(o.pid), list);
        if (!p) return { ok: false, reason: 'PID ' + o.pid + ' 不在进程表里' };
        const c = classifyEdgeCommandLine(p, profileDir, port);
        return c.ok ? { ok: true, proc: p, reason: '指定 PID 也对上' } : { ok: false, reason: c.reason };
      })()
    : pickOwnedEdge(list, profileDir, port);
  if (!found.ok) return { ok: false, reason: '认不出助手 Edge 主进程，不记所有权：' + found.reason };
  const proc = found.proc;
  const start = normalizeStartTime(proc.start);
  if (!start) return { ok: false, reason: '读不到 msedge 的创建时间，无法防 PID 复用，不记所有权' };
  const rec = {
    v: 1,
    pid: proc.pid,
    start,
    exe: proc.exe || '',
    profileDir: String(profileDir),
    port: (port == null || port === '') ? null : Number(port),
    cmdline: String(proc.cmdline || '').slice(0, 2000),
    at: new Date().toISOString(),
    baseDir: dir,
  };
  try {
    atomicWriteJson(edgeOwnPath(dir), rec);
  } catch (e) {
    return { ok: false, reason: '写所有权记录失败：' + ((e && e.message) || e) };
  }
  return { ok: true, pid: proc.pid, reason: '已记下助手 Edge 主进程 PID ' + proc.pid + '（创建于 ' + start + '，profile ' + profileDir + '）' };
}

/** 列出某个 PID 的全部后代（只按父子关系走，不按名字） */
function descendantsOf(pid, list) {
  const out = [];
  const seen = new Set([pid]);
  let frontier = [pid];
  while (frontier.length) {
    const next = [];
    for (const p of list) {
      if (seen.has(p.pid)) continue;
      if (frontier.indexOf(p.ppid) >= 0) { seen.add(p.pid); out.push(p); next.push(p.pid); }
    }
    frontier = next;
  }
  return out;
}

/**
 * 关掉"我们自己启动的"助手 Edge。
 * 返回 {ok, count, reason}
 *   · 只按记录里的 PID + 创建时间 + 命令行（独立 profile）认进程，再带上它的进程树；
 *   · 绝不 taskkill /im msedge.exe；绝不只凭端口或"命令行里有 9222"归属；
 *   · 没有所有权记录、或者记录跟现场对不上 → ok:false 并且**一个进程都不动**。
 */
async function stopOwnedEdge(opts) {
  const o = opts || {};
  const dir = o.baseDir || '.';
  const profileDir = o.profileDir;
  const port = o.port;
  if (!profileDir) return { ok: false, count: 0, reason: '没有给 profileDir，拒绝关闭（无法证明哪一个 Edge 是我们的）' };
  const recRead = readJsonFile(edgeOwnPath(dir));
  let rec = recRead.ok ? recRead.value : null;
  let adopted = false;
  if (rec) {
    if (!pathEquals(rec.profileDir, profileDir)) {
      return { ok: false, count: 0, reason: '所有权记录里的 profile（' + rec.profileDir + '）跟这次请求的（' + profileDir + '）不一致，拒绝关闭' };
    }
    if (port != null && port !== '' && rec.port != null && String(rec.port) !== String(port)) {
      return { ok: false, count: 0, reason: '所有权记录里的端口（' + rec.port + '）跟这次请求的（' + port + '）不一致，拒绝关闭' };
    }
  }
  const res = queryProcesses();
  if (!res.ok) return { ok: false, count: 0, reason: '查不到进程表，拒绝关闭：' + res.reason };
  const list = res.list;

  if (!rec) {
    /* 没有凭证：只有**严格唯一对上**才认领；否则拒绝。 */
    const found = pickOwnedEdge(list, profileDir, port);
    if (!found.ok) {
      return { ok: false, count: 0, reason: '没有所有权记录（' + recRead.reason + '），现场也确认不了是哪一个 Edge：' + found.reason + '。一个进程都没动。' };
    }
    rec = { pid: found.proc.pid, start: normalizeStartTime(found.proc.start), exe: found.proc.exe || '', profileDir, port };
    adopted = true;
  }

  const proc = findByPid(Number(rec.pid), list);
  if (!proc) return { ok: true, count: 0, reason: '记录的助手 Edge（PID ' + rec.pid + '）已经不在了，不用关' };
  const start = normalizeStartTime(proc.start);
  if (!start || start !== normalizeStartTime(rec.start)) {
    return { ok: false, count: 0, reason: 'PID ' + rec.pid + ' 的创建时间跟记录不一致（记 ' + rec.start + '，实际 ' + (start || '读不到') + '）—— PID 被复用了，拒绝关闭' };
  }
  const c = classifyEdgeCommandLine(proc, profileDir, port);
  if (!c.ok) return { ok: false, count: 0, reason: '现场这个 PID 已经不是我们那个 Edge：' + c.reason + '。拒绝关闭' };
  if (rec.exe && proc.exe && !pathEquals(proc.exe, rec.exe)) {
    return { ok: false, count: 0, reason: 'msedge 映像路径与记录不一致（' + proc.exe + ' ≠ ' + rec.exe + '），拒绝关闭' };
  }

  const kids = descendantsOf(proc.pid, list);
  /* 子进程按 PID 精确杀，且只杀"确实挂在它底下"的那些 */
  const targets = kids.map((k) => k.pid).reverse().concat([proc.pid]);
  let killed = 0;
  const failed = [];
  for (const pid of targets) {
    const r = killPid(pid, true);
    if (r.ok) killed++; else failed.push(pid + '(' + (r.reason || '?') + ')');
  }
  invalidateCache();
  if (killed === 0) {
    return { ok: false, count: 0, reason: 'taskkill 没能结束任何进程：' + (failed.join(' ') || '未知') };
  }
  /* 关成功了就把凭证删掉（下次要用会重新记）；部分失败则保留凭证，方便再试 */
  if (failed.length === 0) {
    try { fs.unlinkSync(edgeOwnPath(dir)); } catch (e) {}
    return { ok: true, count: killed, adopted, reason: '已关闭助手 Edge（主进程 PID ' + proc.pid + ' 及其 ' + kids.length + ' 个子进程' + (adopted ? '，凭证是现场严格对上后认领的' : '') + '）' };
  }
  return { ok: true, count: killed, adopted, partial: true, reason: '关掉了 ' + killed + ' 个，还有 ' + failed.length + ' 个没关掉：' + failed.join(' ') };
}

/* ---------------- 助手 Edge：启动与记录所有权 ----------------
 *
 * 为什么把"启动浏览器"也放在这个模块里：
 *   以前 _内部\开始.cmd 里是 `taskkill /f /im msedge.exe` + `start "" msedge.exe ...`，
 *   两个毛病：
 *     ① 按映像名全杀，会把用户自己正在填表单/看文档的 Edge 一起关掉；
 *     ② start 出去之后**没人知道刚起来的是哪一个进程**，于是"关浏览器"只能再全杀一次。
 *   现在改成：不关任何 Edge，直接用独立 --user-data-dir 起一个新的；
 *   起完把"主进程 PID + 创建时间 + 独立 profile + 调试端口"记下来当所有权凭证，
 *   以后只关凭证里那一个（和它的进程树）。
 *
 *   放到 node 里做还有个好处：cmd 的引号/代码页太难伺候，
 *   而这里能用 argv 数组，路径里有空格或中文都不会出错。
 */
function findEdgeExe(explicit) {
  const cands = [];
  if (explicit) cands.push(String(explicit));
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  cands.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  cands.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (local) cands.push(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return { ok: true, exe: c }; } catch (e) {}
  }
  return { ok: false, reason: '找不到 msedge.exe（找过：' + cands.filter(Boolean).join(' ; ') + '）' };
}

/** 起一个"只属于助手"的 Edge（独立 profile + 独立调试端口），并尽力记下所有权 */
async function launchOwnedEdge(opts) {
  const o = opts || {};
  const dir = o.baseDir || '.';
  const profileDir = o.profileDir;
  const port = Number(o.port || 9222);
  if (!profileDir) return { ok: false, reason: '没有给 profileDir —— 不用独立 profile 就等于会跟用户自己的 Edge 抢，拒绝启动' };
  const found = findEdgeExe(o.edgeExe);
  if (!found.ok) return { ok: false, reason: found.reason };
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) {}
  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1500,1050',
    '--disable-session-crashed-bubble',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=msEdgeFirstRunImport,SwitchIntranetSitesToWorkProfile,msEdgeSharedData,' +
      'msEdgeDeleteBrowsingDataOnExit,CalculateWindowOcclusion,UseEcoQoSForBackgroundProcess',
  ];
  /* 【本地服务地址一律不打开 —— 2026-10-11 修】
     起因（用户实报的"屏幕上有块白、点了没反应"）：
       我的课程.txt 里被人加过一行 `http://127.0.0.1:3080`（那是 DSH 网页版的端口），
       而 3080 没在跑 → Edge 打开它只会得到「拒绝连接」，整块浏览器窗口就是一片白。
       用户看不出原因，只能当成"卡死"。
     为什么在代码层拦、而不是只删那一行：
       地址清单是人手维护的，下次还会被加回来；而"课程页"天然不该是本地回环地址。
     判据：只放过真正的远程 http(s) 地址；127.0.0.1 / localhost / ::1 一律忽略，
       并在返回值里如实说明忽略了什么（调用方会打印出来，不静默）。
     真要开本地服务页面（比如 DSH 网页版），请直接自己复制到浏览器地址栏 ——
       它的生命周期跟课程页根本不是一回事，不该混在课程清单里。 */
  const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)(:|\/|$)/i.test(u);
  const allUrls = Array.isArray(o.urls) ? o.urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim())) : [];
  const urls = allUrls.filter((u) => !isLoopback(u.trim()));
  const skippedLoopback = allUrls.filter((u) => isLoopback(u.trim())).map((u) => u.trim());
  for (const u of urls) args.push(u.trim());
  let child = null;
  try {
    child = spawn(found.exe, args, {
      detached: true,
      stdio: 'ignore',      /* 不接管任何管道：受限环境里管道会被拒（EPERM） */
      /* 【修 2026-10-11】这里原来开着 windowsHide（把它去掉了，别再按"统一风格"加回来）。
         实测（A/B 对照，唯一变量就是这个字段，本机 Windows 11 + Edge 155）：
           开着它 → msedge 主窗口 class=Chrome_WidgetWin_1 visible=False
           关掉它 → 同一个窗口 visible=True
         机制：Windows 上 windowsHide 会给子进程的 STARTUPINFO 打上
           STARTF_USESHOWWINDOW + SW_HIDE；对 msedge.exe 这种 GUI 子系统程序，
           效果就是"主窗口出生即隐藏"，而 detached 之后父进程撒手不管，
           再没有任何代码把它显回来 —— 用户屏幕上什么都看不到，只会问"课程页呢"。
         msedge 是 GUI 程序，本来就不带控制台窗口，去掉这个字段不会闪黑框
         （A/B 里 false 那一组实测没有黑框）。
         兜底仍在：_内部\开始.cmd 会在调试端口就绪之后调一次 显示助手窗口.ps1。 */
    });
    if (child && typeof child.unref === 'function') child.unref();
  } catch (e) {
    return { ok: false, reason: '启动 msedge 失败：' + ((e && e.message) || e) };
  }
  /* 记所有权要等主进程起来并且命令行可读。最多等 ~24 秒（首启动较慢）。
     注意：**不拿 spawn 返回的 pid 当依据** —— Chromium 的启动器可能自己退出、
     把活干交给一个已经存在的浏览器进程（那种时候返回的 PID 立刻就没了）。
     所以这里一律按"独立 profile + 端口"在整个进程表里找，找不找得到由证据说话。 */
  let last = '';
  for (let i = 0; i < 24; i++) {
    await sleepMs(i === 0 ? 1500 : 1000);
    const rec = await recordOwnedEdge({ baseDir: dir, profileDir, port });
    if (rec.ok) {
      return {
        ok: true, pid: rec.pid, reason: rec.reason, launched: true,
        /* 被忽略的本地地址要如实带出去（调用方会写进 _启动浏览器结果.json）。
           实测教训：静默丢弃比丢错更糟 —— 用户会以为"写进清单了却没打开"，查不出为什么。 */
        ...(skippedLoopback.length ? { skippedLoopback, skippedWhy: '本地回环地址（服务不在就只会得到"拒绝连接"白页）' } : {}),
      };
    }
    last = rec.reason;
  }
  /* 浏览器起来了但认不出所有权：**照实说**，并且不要伪造凭证。
     这种情况下"关浏览器"会拒绝执行（宁可不关，也不误关用户自己的窗口）。 */
  return { ok: false, launched: true, pid: (child && child.pid) || 0,
           ...(skippedLoopback.length ? { skippedLoopback, skippedWhy: '本地回环地址（服务不在就只会得到"拒绝连接"白页）' } : {}),
           reason: '浏览器已经启动，但没能确认它的所有权（' + last + '）。' +
                   '这意味着以后「关浏览器」会拒绝执行（宁可不关，也不误关你自己的 Edge）。' };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 命令行入口 ----------------
 * 给 cmd / PowerShell 用的薄封装：它们不方便调 JS 函数，但很方便起一个 node 读一行 JSON。
 * 所有输出都是**一行 JSON**，便于调用方 ConvertFrom-Json / find 解析。
 */
async function cliMain(argv) {
  const args = argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    if (i < 0) return dflt;
    const v = args[i + 1];
    return (v === undefined || v.startsWith('--')) ? dflt : v;
  };
  const has = (name) => args.indexOf(name) >= 0;
  const baseDir = flag('--base', process.cwd());
  const port = Number(flag('--port', '9222'));
  const profileDir = flag('--profile', '');
  const mode = args[0] || '';

  if (mode === '--status') {
    const r = readVerifiedDriver(baseDir, { driverScript: path.join(baseDir, 'driver.js') });
    return { ok: true, pid: r.pid, alive: !!r.alive, verified: !!r.verified, reason: r.reason, batch: r.batch || '' };
  }
  /* 【给 cmd 用的"驱动器在不在跑"】——只认退出码，不认字符串。
     为什么要有它：cmd 里判 JSON 得写 `findstr /c:"\"alive\":true"` 这种
     引号+反斜杠的写法，好不好使全看 cmd 的解析心情；而且只判 alive 会漏掉
     verified=false（PID 复用、映像/命令行对不上）的情况 —— 那正是最危险的误判。
     这里的契约最简单：**0 = 有一个身份验证通过的驱动器在跑；非 0 = 没有**。
     标准输出只有 DRIVER=alive 或 DRIVER=absent 这一行，方便人肉核对。 */
  if (mode === '--status-exit') {
    const r = readVerifiedDriver(baseDir, { driverScript: path.join(baseDir, 'driver.js') });
    const running = !!(r.alive && r.verified);
    return { running: running, line: 'DRIVER=' + (running ? 'alive' : 'absent'), pid: r.pid, verified: !!r.verified, reason: r.reason };
  }
  if (mode === '--stop-driver') {
    const r = await stopVerifiedDriver(baseDir, { driverScript: path.join(baseDir, 'driver.js') });
    return { ok: !!r.ok, killed: !!r.killed, pid: r.pid || 0, reason: r.reason };
  }
  if (mode === '--record-edge') {
    const r = await recordOwnedEdge({ baseDir, profileDir, port, pid: Number(flag('--pid', '0')) || undefined });
    return { ok: !!r.ok, pid: r.pid || 0, reason: r.reason };
  }
  if (mode === '--stop-edge') {
    const r = await stopOwnedEdge({ baseDir, profileDir, port });
    return { ok: !!r.ok, count: r.count || 0, reason: r.reason };
  }
  if (mode === '--launch-edge') {
    const urls = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--url' && args[i + 1]) urls.push(args[i + 1]);
    }
    const r = await launchOwnedEdge({ baseDir, profileDir, port, urls, edgeExe: flag('--edge', '') });
    return r;
  }
  if (has('--help') || !mode) {
    return {
      ok: false,
      reason: '用法：node runtime-processes.js <--status|--status-exit|--stop-driver|--record-edge|--stop-edge|--launch-edge> ' +
              '[--base 目录] [--profile 独立profile目录] [--port 9222] [--pid N] [--url URL ...]',
    };
  }
  return { ok: false, reason: '未知参数：' + mode };
}

/* --status-exit 的约定和别的模式不同：**退出码本身就是结论**。
   0 = 有一个身份验证通过的驱动器在跑（alive && verified）；
   非 0 = 没有 / 查不出来 —— cmd 只需要 `if errorlevel 1`，不用解析 JSON 字符串。
   标准输出只留一行 DRIVER=alive|absent，给日志和人看。 */
function exitCodeFor(r, mode) {
  if (mode === '--status-exit') return (r && r.running) ? 0 : 1;
  return (r && r.ok) ? 0 : 1;
}

if (require.main === module) {
  /* 模式就是命令行里第一个以 -- 开头的参数（cliMain 用的也是这个）。
     不写死 argv[2]：node 自己也可能占掉前面的位置（比如各种 --xxx 标志）。 */
  const mode = process.argv.slice(2).find((a) => a.startsWith('--')) || '';
  cliMain(process.argv).then((r) => {
    try {
      process.stdout.write((mode === '--status-exit' && r && r.line ? (r.line + '\n') : (JSON.stringify(r) + '\n')));
    } catch (e) {}
    process.exit(exitCodeFor(r, mode));
  }).catch((e) => {
    try { process.stdout.write(JSON.stringify({ ok: false, reason: '内部错误：' + ((e && e.message) || e) }) + '\n'); } catch (x) {}
    process.exit(1);
  });
}

module.exports = {
  /* 仅测试用：把 CLI 结论换算成退出码（--status-exit 的契约） */
  exitCodeFor,
  /* 驱动器锁 / 判活 */
  readVerifiedDriver,
  acquireDriverLock,
  releaseDriverLock,
  stopVerifiedDriver,
  currentProcessStart,
  writeLegacyPidFile,
  removeLegacyPidFileIfOwn,
  /* 助手 Edge 所有权 */
  recordOwnedEdge,
  stopOwnedEdge,
  launchOwnedEdge,
  findEdgeExe,
  /* 路径与命令行工具（也供测试直接用） */
  parseWindowsCommandLine,
  pathEquals,
  isSameOrInside,
  normalizePath,
  normalizeStartTime,
  argValue,
  hasArg,
  classifyEdgeCommandLine,
  pickOwnedEdge,
  listProcesses,
  /* 常量 */
  LOCK_FILE,
  LEGACY_PID_FILE,
  EDGE_OWN_FILE,
  /* 仅测试用 */
  __setProcessHooksForTest,
  __resetProcessHooksForTest,
};
