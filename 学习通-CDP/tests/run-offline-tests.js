#!/usr/bin/env node
/* run-offline-tests.js —— 一键离线测试入口
 *
 * 干什么：
 *   1. 自动发现 tests\ 下**所有** *.test.js（只认这一层、这一组）；
 *   2. 每个文件用 `node --test <完整路径>` 单开一个进程跑（互相不串味）；
 *   3. 汇总真实数字：文件级通过/失败 + 用例级通过/失败；
 *   4. 有任何一个文件失败、或根本没跑起来，退出码非零。
 *
 * 退出码：
 *   0 = 全部通过
 *   1 = 有测试失败，或有文件没能跑起来（加载出错/超时/进程崩了）
 *   2 = 没文件可跑 / 参数写错 / 入口自己出错
 *
 * 这一版只跑 tests\*.test.js。_实验\ 下面的脚本是另一套东西（不在隔离环境里、
 * 不带假浏览器和临时目录），不从这里跑，别把外面的真实环境带进来。
 *
 * 本文件不连浏览器、不读用户设置/课程/题库/日志、不写任何用户文件；
 * 子进程的工作目录固定成仓库根目录，跟原来双击 cmd 的行为一致。
 *
 * 被 require 时**没有任何副作用**（只有 require.main === module 时才跑 main）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

/* ------------------------------------------------------------------ 常量 */

const TESTS_DIR = __dirname;                              // 本文件就住在 tests\ 里
const PROJECT_ROOT = path.dirname(__dirname);             // 仓库根目录（测试的工作目录）
const TEST_FILE_RE = /\.test\.js$/i;

const EXIT_OK = 0;
const EXIT_FAILED = 1;          // 有测试失败，或有文件没跑起来
const EXIT_CANNOT_RUN = 2;      // 没文件可跑 / 参数错 / 内部错

const DEFAULT_FILE_TIMEOUT_MS = 180000;   // 单个测试文件最多跑 3 分钟
const KILL_GRACE_MS = 2000;               // 超时后等它自己咽气的上限
const MAX_DETAIL_LINES = 400;             // 失败详情最多回显多少行原始输出
const MAX_DETAIL_CHARS = 40000;

const STATUS_LABEL = {
  pass: '[OK]',
  fail: '[X]',
  'not-started': '[X]',
  crashed: '[X]',
  timeout: '[X]',
};

const STATUS_TEXT = {
  fail: '有测试失败',
  'not-started': '没跑起来',
  crashed: '进程被打断',
  timeout: '超时',
};

const HELP_TEXT = [
  '学习通助手 · 一键离线测试入口',
  '',
  '用法：',
  '  node tests\\run-offline-tests.js [参数]',
  '',
  '  不带参数：发现 tests\\ 下所有 *.test.js，每个文件用独立进程跑一遍。',
  '  全部通过 → 退出码 0；有失败或没跑起来 → 1；没文件可跑 / 参数写错 → 2。',
  '',
  '参数：',
  '  --no-pause           跑完不等回车（自动化、CI 用这个）',
  '  --pause              跑完一定等回车（即使在管道里）',
  '  --only=<关键字>       只跑名字里含关键字的文件，逗号分隔，例如 --only=web,quiz',
  '  --list               只列出会跑哪些文件，不执行',
  '  --node=<路径>         指定用哪个 node.exe 跑子进程（默认就用当前这个）',
  '  --timeout-ms=<毫秒>   单个文件最长耗时，超时就结束它（0 = 不限时，默认 180000）',
  '  --help               看这段说明',
  '',
  '约定：只跑 tests\\*.test.js（每个文件独立进程）；_实验\\ 下的脚本不在这里跑；',
  '      不连浏览器、不读你的设置、不改你的文件。',
].join('\n');

/* ------------------------------------------------------- 发现 / 选择（纯） */

/** 发现 tests 目录下第一层的 *.test.js，返回按文件名排序的**完整路径**。 */
function discoverTestFiles(testsDir = TESTS_DIR, deps = {}) {
  const readdir = deps.readdir || fs.readdirSync;
  let entries;
  try {
    entries = readdir(testsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];   // 目录不在 = 没得跑，交给上层报 2
    throw err;
  }
  const files = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry.isFile !== 'function' || !entry.isFile()) continue;
    if (!TEST_FILE_RE.test(entry.name)) continue;
    files.push(path.resolve(testsDir, entry.name));
  }
  files.sort((a, b) => {
    const x = path.basename(a).toLowerCase();
    const y = path.basename(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;   // 不依赖 locale，保证顺序稳定
  });
  return files;
}

/** 把 --only 拆成关键字数组（支持数组、逗号分隔的字符串、空）。 */
function normalizeOnly(only) {
  const parts = Array.isArray(only) ? only : String(only == null ? '' : only).split(',');
  return parts.map(p => String(p).trim()).filter(Boolean);
}

/** 按关键字挑文件：区分大小写的子串匹配 basename（*.test.js 后缀可有可无）。 */
function selectTestFiles(files, only) {
  const patterns = normalizeOnly(only);
  if (!patterns.length) return { selected: (files || []).slice(), unmatched: [] };

  const selected = [];
  const unmatched = [];
  for (const pattern of patterns) {
    const needle = pattern.toLowerCase();
    const hits = (files || []).filter(f => path.basename(f).toLowerCase().includes(needle));
    if (!hits.length) { unmatched.push(pattern); continue; }
    for (const hit of hits) if (!selected.includes(hit)) selected.push(hit);
  }
  // 回到发现时的顺序，跟 --only 的书写顺序无关
  selected.sort((a, b) => files.indexOf(a) - files.indexOf(b));
  return { selected, unmatched };
}

/* ------------------------------------------------------------ 参数（纯） */

function parseArgs(argv) {
  const opts = {
    pause: null,          // null = 看是不是真控制台再决定
    list: false,
    help: false,
    only: '',
    node: '',
    timeoutMs: DEFAULT_FILE_TIMEOUT_MS,
  };
  for (const raw of argv || []) {
    const arg = String(raw);
    if (arg === '--no-pause') { opts.pause = false; continue; }
    if (arg === '--pause') { opts.pause = true; continue; }
    if (arg === '--list') { opts.list = true; continue; }
    if (arg === '--help' || arg === '-h' || arg === '/?') { opts.help = true; continue; }
    if (arg.startsWith('--only=')) { opts.only = arg.slice('--only='.length); continue; }
    if (arg.startsWith('--node=')) { opts.node = arg.slice('--node='.length); continue; }
    if (arg.startsWith('--timeout-ms=')) {
      const value = arg.slice('--timeout-ms='.length).trim();
      const ms = Number(value);
      if (!value || !Number.isInteger(ms) || ms < 0) {
        throw new Error('--timeout-ms 需要一个 >= 0 的整数，收到：' + value);
      }
      opts.timeoutMs = ms;
      continue;
    }
    throw new Error('不认识的参数：' + arg);
  }
  return opts;
}

/* ------------------------------------------------- 解析子进程输出（纯） */

function cleanTestName(name) {
  return String(name)
    .replace(/\s+#\s*(?:time|duration)=.*$/i, '')
    .replace(/\s+#\s*(?:TODO|SKIP)\s*$/i, '')
    .trim();
}

/**
 * 从 node --test 的输出里读真实统计。
 * TAP 是 "# tests 11"，spec 是 "ℹ tests 11"，两种都认；读不到就把 hasSummary 置 false。
 */
function summarizeNodeTestOutput(text) {
  const counters = {};
  const failedNames = [];
  let durationMs = null;
  let hasSummary = false;

  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const trimmed = line.trim();
    const counter = /^(?:#|\u2139|i)?\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)$/.exec(trimmed);
    if (counter) {
      const key = counter[1];
      const value = Number(counter[2]);
      if (key === 'duration_ms') durationMs = value;
      else { counters[key] = value; if (key === 'tests') hasSummary = true; }
      continue;
    }
    const tapFail = /^not ok \d+ - (.*)$/.exec(trimmed);
    if (tapFail) { failedNames.push(cleanTestName(tapFail[1])); continue; }
    const specFail = /^(?:\u2716|\u00d7)\s+(.*)$/.exec(trimmed);
    if (specFail) failedNames.push(cleanTestName(specFail[1]));
  }

  return {
    counters,
    hasSummary,
    durationMs,
    tests: counters.tests || 0,
    suites: counters.suites || 0,
    pass: counters.pass || 0,
    fail: counters.fail || 0,
    skipped: counters.skipped || 0,
    todo: counters.todo || 0,
    failedNames: failedNames.filter(Boolean).slice(0, 8),
  };
}

/** 给子进程结果定性。退出码是权威：看不懂输出也照样按退出码判。 */
function classifyChild(result) {
  const r = result || {};
  if (r.timedOut) return 'timeout';
  if (r.spawnError) return 'not-started';
  if (r.signal) return 'crashed';
  if (r.code === 0) return 'pass';
  const stats = r.stats || summarizeNodeTestOutput(r.output);
  if (stats.hasSummary && stats.tests > 0) return 'fail';
  return 'not-started';   // 一个用例都没报，还非零退出 = 文件根本没加载起来
}

/** 汇总数字（纯）：文件级 + 用例级，读不到的统计单独记账，绝不瞎凑。 */
function buildSummary({ testsDir, discovered, selected, results, unmatched, problems }) {
  const totals = {
    files: (results || []).length,
    passed: 0,
    failed: 0,
    notStarted: 0,
    crashed: 0,
    timedOut: 0,
    statsUnavailable: 0,
    emptyFiles: 0,
    cases: { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 },
  };

  for (const result of results || []) {
    if (result.status === 'pass') totals.passed += 1;
    else if (result.status === 'fail') totals.failed += 1;
    else if (result.status === 'not-started') totals.notStarted += 1;
    else if (result.status === 'crashed') totals.crashed += 1;
    else if (result.status === 'timeout') totals.timedOut += 1;

    const stats = result.stats;
    if (stats && stats.hasSummary) {
      totals.cases.tests += stats.tests;
      totals.cases.pass += stats.pass;
      totals.cases.fail += stats.fail;
      totals.cases.skipped += stats.skipped;
      totals.cases.todo += stats.todo;
      if (result.status === 'pass' && stats.tests === 0) totals.emptyFiles += 1;
    } else if (result.status === 'pass') {
      totals.statsUnavailable += 1;
    }
  }

  return {
    testsDir,
    discovered: discovered || [],
    selected: selected || [],
    results: results || [],
    unmatched: unmatched || [],
    problems: problems || [],
    totals,
  };
}

/** 退出码（纯）：非零就是非零，绝不被 pause 之类的东西盖掉。 */
function computeExitCode(totals) {
  const t = totals || {};
  if (!t.files) return EXIT_CANNOT_RUN;
  if (t.failed || t.notStarted || t.crashed || t.timedOut) return EXIT_FAILED;
  return EXIT_OK;
}

/* -------------------------------------------------------------- 显示（纯） */

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '耗时未知';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + ' 秒' : Math.round(ms) + ' 毫秒';
}

const SPAWN_ERROR_HINT = {
  EPERM: '系统/杀毒/沙箱拦了 node 子进程，放行 node.exe 或换个目录再试',
  EACCES: '没有执行权限，检查 node.exe 的权限或杀毒拦截',
  ENOENT: '这个 node.exe 路径不存在了',
  EMFILE: '句柄太多，关掉一些程序再试',
  EAGAIN: '进程太多，等一会儿再试',
};

function describeCode(result) {
  if (result.spawnError) {
    const err = result.spawnError;
    const code = err.code || '';
    const hint = SPAWN_ERROR_HINT[code];
    return '启动失败：' + (code || err.message || '未知原因') + (hint ? '（' + hint + '）' : '');
  }
  return result.code == null ? '无' : String(result.code);
}

function formatHeader({ testsDir, discovered, nodeExe, version }) {
  const lines = [];
  lines.push('');
  lines.push('  学习通助手 · 离线测试（不连浏览器、不读你的设置、不改你的文件）');
  lines.push('  ' + '-'.repeat(62));
  lines.push('  Node : ' + nodeExe + (version ? '  ' + version : ''));
  lines.push('  范围 : ' + testsDir);
  lines.push('  数量 : 发现 ' + (discovered || []).length + ' 个 *.test.js，每个文件单独一个进程');
  lines.push('  说明 : 只跑 tests\\*.test.js；_实验\\ 下的脚本不在这里跑。');
  lines.push('');
  return lines.join('\n') + '\n';
}

function formatFilePrefix(index, total, file) {
  const width = String(total).length;
  return '  [' + String(index).padStart(width) + '/' + total + '] ' + path.basename(file).padEnd(48);
}

/**
 * Node 把"文件自己加载不起来"（语法错、require 出错）报成一条用例失败，
 * 用例名就是文件路径。认出这种情况，好在界面上讲清楚"没跑起来"。
 */
function failingNameIsFile(result) {
  const stats = result.stats;
  if (!stats || !stats.hasSummary) return false;
  if (stats.tests !== 1 || stats.fail !== 1 || stats.pass !== 0) return false;
  const name = String(stats.failedNames[0] || '').replace(/\\\\/g, '\\').trim();
  const base = path.basename(result.file || '');
  if (!base || !name) return false;
  return name === result.file || name.endsWith(base);
}

/** 失败详情标题里那句短语。 */
function statusBrief(result) {
  if (result.status === 'fail' && failingNameIsFile(result)) return '文件加载就报错了';
  return STATUS_TEXT[result.status] || result.status;
}

function describeFileResult(result) {
  const stats = result.stats;
  if (result.status === 'pass') {
    if (stats && stats.hasSummary) return '通过 ' + stats.tests + ' 项（' + formatMs(result.durationMs) + '）';
    return '通过（该文件没有输出用例统计，按退出码判定）';
  }
  if (result.status === 'timeout') {
    return '超时未结束（超过 ' + formatMs(result.timeoutMs) + '，已结束该进程）';
  }
  if (result.status === 'not-started') {
    return '没能跑起来（退出码 ' + describeCode(result) + '）';
  }
  if (result.status === 'crashed') {
    return '进程被信号打断：' + result.signal;
  }
  if (failingNameIsFile(result)) {
    return '没能跑起来：文件加载就报错了（退出码 ' + describeCode(result) + '）';
  }
  if (stats && stats.hasSummary) {
    return '失败 ' + stats.fail + ' 项 / 通过 ' + stats.pass + ' 项';
  }
  return '失败（退出码 ' + describeCode(result) + '）';
}

function formatFileStatus(result) {
  return (STATUS_LABEL[result.status] || '[?]') + ' ' + describeFileResult(result);
}

function formatFileLine(index, total, file, result) {
  return formatFilePrefix(index, total, file) + formatFileStatus(result);
}

function clampOutput(text) {
  const src = String(text == null ? '' : text).replace(/\s+$/, '');
  let lines = src.split(/\r?\n/);
  let clipped = false;
  if (lines.length > MAX_DETAIL_LINES) {
    lines = lines.slice(-MAX_DETAIL_LINES);
    clipped = true;
  }
  let out = lines.join('\n');
  if (out.length > MAX_DETAIL_CHARS) {
    out = out.slice(-MAX_DETAIL_CHARS);
    clipped = true;
  }
  return { text: out, clipped };
}

function formatFailureDetail(result) {
  const lines = [];
  lines.push('');
  lines.push('  ======== 失败详情：' + path.basename(result.file) + '（' + statusBrief(result) + '） ========');
  const stats = result.stats;
  if (stats && stats.failedNames.length) {
    lines.push('  失败用例：');
    for (const name of stats.failedNames) lines.push('    x ' + name);
  }
  const quoted = result.args.map(a => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  lines.push('  命令行：node ' + quoted);
  lines.push('  —— 原始输出 ——');
  const clamped = clampOutput(result.output);
  if (clamped.clipped) lines.push('  （输出太长，这里只留最后一段）');
  if (clamped.text) lines.push(clamped.text);
  lines.push('  —— 原始输出结束 ——');
  return lines.join('\n') + '\n';
}

function formatProblems(summary) {
  const lines = [];
  for (const problem of summary.problems) {
    if (problem === 'no-tests') {
      lines.push('  [X] 在 ' + summary.testsDir + ' 里没找到任何 *.test.js —— 没东西可跑。');
    } else if (problem === 'no-match') {
      lines.push('  [X] --only= 没匹配到任何文件：' + summary.unmatched.join(', '));
    } else {
      lines.push('  [X] ' + problem);
    }
  }
  return lines.join('\n');
}

function formatSummary(summary, exitCode) {
  const t = summary.totals;
  const failedFiles = t.failed + t.crashed + t.timedOut + t.notStarted;
  const lines = [];
  lines.push('  ' + '-'.repeat(62));
  lines.push('  文件：通过 ' + t.passed + ' / 失败 ' + failedFiles + ' / 共 ' + t.files);
  lines.push('  用例：通过 ' + t.cases.pass + ' 项 · 失败 ' + t.cases.fail + ' 项'
    + (t.cases.skipped ? ' · 跳过 ' + t.cases.skipped + ' 项' : '')
    + (t.cases.todo ? ' · 待办 ' + t.cases.todo + ' 项' : '')
    + '（共 ' + t.cases.tests + ' 项）');
  if (t.statsUnavailable) {
    lines.push('  注意：' + t.statsUnavailable + ' 个文件没有输出用例统计，那些文件只按退出码判定。');
  }
  if (t.emptyFiles) {
    lines.push('  注意：' + t.emptyFiles + ' 个文件报了 0 个用例，可能测试根本没注册上。');
  }
  if (exitCode === EXIT_OK) {
    lines.push('  结果：全部通过   退出码 0');
  } else if (exitCode === EXIT_CANNOT_RUN) {
    lines.push('  结果：没跑成（原因见上面那行 [X]）   退出码 ' + exitCode);
  } else {
    lines.push('  结果：有失败   退出码 ' + exitCode);
    lines.push('  把上面 [X] 那几段的原始输出发给我就行。');
  }
  lines.push('  ' + '-'.repeat(62));
  return lines.join('\n');
}

/* ------------------------------------------------------------ 跑子进程 */

function childEnv(env) {
  const copy = Object.assign({}, env || process.env);
  delete copy.NODE_OPTIONS;         // 用户设的 NODE_OPTIONS 不该影响离线测试
  delete copy.NODE_TEST_CONTEXT;    // 别让子进程以为自己是测试运行器的孩子
  copy.NO_COLOR = '1';
  /* 【把"工作区那份用户数据"物理隔离掉】2026-10-12 别人报的缺陷 2：
     整套跑 3 次偶发挂 1 次 —— 有某条路径绕过 withTmpCache，把工作区的真实
     答题答案缓存.json 改了一下（mtime 变了）。单独跑那个文件永远绿 ⇒
     漏点在别处、而且时间点不确定。
     这里给所有测试子进程一个环境变量：答案缓存的**默认路径**指到临时文件。
     产品代码只**读**这个变量（不写任何用户环境变量 —— 那是 10-09 的教训）。
     这样即使还有漏网路径，伤的也是临时文件；工作区那份一个字节都不会变。 */
  try {
    const os = require('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-offline-cache-'));
    copy.DSH_ANSWER_CACHE_FILE = path.join(tmpDir, '答题答案缓存.json');
  } catch (e) { /* 建不出临时目录就算了：宁可保持原行为，也不要因为这点事跑不了测试 */ }
  return copy;
}

function makeResult(fields) {
  const output = fields.output || '';
  const result = Object.assign({
    code: null,
    signal: null,
    output: '',
    spawnError: null,
    timedOut: false,
    durationMs: 0,
  }, fields);
  result.output = output;
  result.stats = summarizeNodeTestOutput(output);
  return result;
}

/**
 * 跑一个 node 子进程。
 * 参数走数组、不走 shell —— 带空格和中文的完整路径原样传过去，不会被引号/代码页坑到。
 */
function spawnOnce(nodeExe, args, opts, deps) {
  const spawnImpl = deps.spawn || spawn;
  const cwd = deps.cwd || PROJECT_ROOT;
  const limit = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_FILE_TIMEOUT_MS;

  return new Promise(resolve => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawnImpl(nodeExe, args, {
        cwd,
        windowsHide: true,
        env: childEnv(deps.env),
      });
    } catch (err) {
      resolve(makeResult({ spawnError: err, durationMs: Date.now() - startedAt }));
      return;
    }

    const chunks = [];
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let graceTimer = null;

    const collect = chunk => {
      if (chunk == null) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    };
    const finish = extra => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(makeResult(Object.assign({
        output: Buffer.concat(chunks).toString('utf8'),
        timedOut,
        durationMs: Date.now() - startedAt,
      }, extra)));
    };

    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', collect);
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', collect);
    child.on('error', err => finish({ spawnError: err }));
    child.on('close', (code, signal) => finish({ code, signal }));

    if (limit > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (err) { /* 可能已经自己退了 */ }
        graceTimer = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), KILL_GRACE_MS);
      }, limit);
    }
  });
}

/** 老 Node 不认 --test-reporter，退回裸 --test 再跑一次；这不是测试失败。 */
function shouldRetryWithoutReporter(result) {
  if (result.spawnError || result.timedOut) return false;
  if (result.stats && result.stats.hasSummary) return false;
  return /bad option|unknown option|invalid.*--test|--test-reporter/i.test(result.output || '');
}

async function runOneFile(file, opts, deps = {}) {
  const nodeExe = opts.node || deps.node || process.execPath;
  const attempts = [
    ['--test', '--test-reporter=tap', file],   // 明确要 TAP：统计好解析，也躲开控制台代码页
    ['--test', file],
  ];
  let result = null;
  for (const args of attempts) {
    result = await spawnOnce(nodeExe, args, opts, deps);
    result.file = file;
    result.args = args;
    result.timeoutMs = opts.timeoutMs;
    result.status = classifyChild(result);
    if (!shouldRetryWithoutReporter(result)) break;
  }
  return result;
}

/**
 * 发现 → 选择 → 逐个独立进程跑 → 打印真实统计。
 * 返回 { summary, exitCode }；异常都转成 problem，不往调用方扔。
 */
async function runOfflineTests(opts = {}, deps = {}) {
  const log = deps.log || (s => process.stdout.write(s));
  const testsDir = deps.testsDir || TESTS_DIR;
  const nodeExe = opts.node || deps.node || process.execPath;

  const discovered = discoverTestFiles(testsDir, deps);
  const { selected, unmatched } = selectTestFiles(discovered, opts.only);

  const problems = [];
  if (!discovered.length) problems.push('no-tests');
  if (unmatched.length) problems.push('no-match');

  log(formatHeader({
    testsDir,
    discovered,
    nodeExe,
    version: deps.version === undefined ? process.version : deps.version,
  }));

  const results = [];
  if (!problems.length) {
    const total = selected.length;
    /* 【盯住工作区那份用户数据】2026-10-12 别人报的缺陷 2：整套跑偶发红，
       说是"工作区的答题答案缓存.json 被改了"。现在子进程的默认缓存路径已经指到临时文件
       （childEnv 里那个环境变量），但万一还有漏网路径，就在这儿**按文件点名**：
       跑完一个文件就核一次，变了就把这个文件标红 —— 比"只报整个文件碰过"精确得多。 */
    const watchdogFile = path.join(PROJECT_ROOT, '答题答案缓存.json');
    const stampOf = () => {
      try { const st = fs.statSync(watchdogFile); return st.mtimeMs + '/' + st.size; } catch (e) { return ''; }
    };
    let watchBase = stampOf();
    for (let i = 0; i < total; i += 1) {
      log(formatFilePrefix(i + 1, total, selected[i]));
      const result = await runOneFile(selected[i], opts, deps);
      const now = stampOf();
      if (watchBase && now && now !== watchBase) {
        result.workspaceTouched = true;
        result.workspaceDetail = selected[i] + ' 跑完后，工作区的 答题答案缓存.json 变了（' + watchBase + ' → ' + now +
          '）—— 说明这个文件里有路径绕过了隔离，碰了用户数据。';
        result.code = EXIT_FAILED;
        result.stats = result.stats || {};
      }
      watchBase = now || watchBase;
      results.push(result);
      log(formatFileStatus(result) + '\n');
    }
  }

  const summary = buildSummary({ testsDir, discovered, selected, results, unmatched, problems });
  const exitCode = problems.length ? EXIT_CANNOT_RUN : computeExitCode(summary.totals);

  for (const result of results) {
    if (result.status !== 'pass') log(formatFailureDetail(result));
  }
  if (problems.length) log(formatProblems(summary) + '\n');
  log(formatSummary(summary, exitCode) + '\n');

  return { summary, exitCode };
}

/* -------------------------------------------------------------- 入口 */

function setConsoleTitle(title = '学习通助手 - 离线测试') {
  try {
    if (process.stdout.isTTY) process.title = title;
  } catch (err) { /* 设不上就算了 */ }
}

/** 该不该等回车：--no-pause 一定不等；默认只在真控制台里等（管道/CI 不会挂住）。 */
function shouldPause(opts, deps = {}) {
  if (opts && opts.pause === false) return false;
  if (opts && opts.pause === true) return true;
  const isTTY = deps.isTTY === undefined ? Boolean(process.stdin.isTTY) : deps.isTTY;
  return Boolean(isTTY);
}

function waitForEnter(deps = {}) {
  const input = deps.stdin || process.stdin;
  const output = deps.stdout || process.stdout;
  return new Promise(resolve => {
    let done = false;
    let rl = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (rl) rl.close(); } catch (err) { /* 关不上就算了 */ }
      resolve();
    };
    try {
      rl = readline.createInterface({ input, output });
    } catch (err) {
      resolve();
      return;
    }
    rl.on('close', finish);                       // stdin 提前结束也不会挂住
    try {
      rl.question('\n  按回车键关闭这个窗口 ...', () => finish());
    } catch (err) {
      finish();
    }
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || (s => process.stdout.write(s));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log('\n  参数不对：' + err.message + '\n\n' + HELP_TEXT + '\n');
    process.exitCode = EXIT_CANNOT_RUN;
    return { exitCode: EXIT_CANNOT_RUN };
  }

  if (opts.help) {
    log(HELP_TEXT + '\n');
    process.exitCode = EXIT_OK;
    return { exitCode: EXIT_OK };
  }

  setConsoleTitle();

  let exitCode = EXIT_CANNOT_RUN;
  try {
    const testsDir = deps.testsDir || TESTS_DIR;
    if (opts.list) {
      const files = discoverTestFiles(testsDir, deps);
      log('\n  会跑这 ' + files.length + ' 个文件（' + testsDir + '）：\n');
      for (const file of files) log('    ' + path.basename(file) + '\n');
      if (!files.length) log('  [X] 一个 *.test.js 都没发现。\n');
      exitCode = EXIT_OK;
    } else {
      const run = await runOfflineTests(opts, deps);
      exitCode = run.exitCode;
    }
  } catch (err) {
    log('\n  [X] 测试入口自己出错了（不是测试失败）：\n' + ((err && err.stack) || String(err)) + '\n');
    exitCode = EXIT_CANNOT_RUN;
  } finally {
    if (shouldPause(opts, deps)) {
      try { await waitForEnter(deps); } catch (err) { /* 关窗就算了 */ }
    }
  }

  process.exitCode = exitCode;    // 用 exitCode 而不是 process.exit()：保证输出写完
  return { exitCode };
}

module.exports = {
  TESTS_DIR,
  PROJECT_ROOT,
  DEFAULT_FILE_TIMEOUT_MS,
  EXIT_OK,
  EXIT_FAILED,
  EXIT_CANNOT_RUN,
  HELP_TEXT,
  discoverTestFiles,
  normalizeOnly,
  selectTestFiles,
  parseArgs,
  summarizeNodeTestOutput,
  classifyChild,
  failingNameIsFile,
  statusBrief,
  buildSummary,
  computeExitCode,
  formatHeader,
  formatFilePrefix,
  formatFileStatus,
  formatFileLine,
  formatFailureDetail,
  formatProblems,
  formatSummary,
  childEnv,
  shouldPause,
  waitForEnter,
  runOneFile,
  runOfflineTests,
  main,
};

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exitCode = EXIT_CANNOT_RUN;
  });
}
