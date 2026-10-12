/* test-runner.test.js —— 离线验证"一键离线测试入口"自己的逻辑
 *
 * 这里只测纯函数和**注入的假进程**：不真的去跑 node --test、不连浏览器、
 * 不读任何用户配置、不碰 tests\ 目录以外的文件。
 * 临时目录只用 fs.mkdtempSync 建在系统 temp 里，删也只删自己建的那一个。
 *
 * 跑法：
 *   node --test tests\test-runner.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const RUNNER_PATH = path.join(__dirname, 'run-offline-tests.js');

/* ------------------------------------------------------- 临时目录（自己建、自己删） */

const TEMP_DIRS = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeFile(dir, name, text = '') {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return full;
}

test.after(() => {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  for (const dir of TEMP_DIRS) {
    // 只删"系统 temp 下、名字是我们自己起的"那一个目录，绝不递归删别的路径
    const full = path.resolve(dir);
    if (!full.startsWith(tempRoot)) continue;
    if (!path.basename(full).startsWith('dsh-runner-test-')) continue;
    fs.rmSync(full, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ 加载被测模块 */

let cached = null;
function loadRunner() {
  if (!cached) cached = require(RUNNER_PATH);
  return cached;
}

/* ------------------------------------------------------------ 假子进程 */

/** 造一个够用的 ChildProcess 替身：EventEmitter + stdout/stderr + kill()。 */
function makeFakeChild(spec = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    if (spec.onKill) spec.onKill(child);
    return true;
  };
  setImmediate(() => {
    if (spec.error) { child.emit('error', spec.error); return; }
    if (spec.stdout) child.stdout.emit('data', Buffer.from(spec.stdout, 'utf8'));
    if (spec.stderr) child.stderr.emit('data', Buffer.from(spec.stderr, 'utf8'));
    if (!spec.hang) child.emit('close', spec.code == null ? 0 : spec.code, spec.signal || null);
  });
  return child;
}

/** 按"目标文件名"给每个测试文件编一份假结果；calls 记下所有真实调用参数。 */
function fakeSpawn(script = {}) {
  const spawnImpl = (cmd, args, options) => {
    const key = path.basename(args[args.length - 1] || '');
    const spec = Object.prototype.hasOwnProperty.call(script, key) ? script[key] : (script['*'] || {});
    spawnImpl.calls.push({ cmd, args: args.slice(), options });
    return makeFakeChild(spec);
  };
  spawnImpl.calls = [];
  return spawnImpl;
}

/* ------------------------------------------------------------ TAP 样本 */

const tap = lines => lines.join('\n') + '\n';

const TAP_PASS_1 = tap([
  'TAP version 13',
  '# Subtest: demo',
  'ok 1 - demo',
  '  ---',
  '  duration_ms: 1.2',
  '  ...',
  '# tests 1',
  '# suites 0',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 12.5',
]);

const TAP_FAIL_3 = tap([
  'TAP version 13',
  '# Subtest: 保存',
  'ok 1 - 第一项',
  'ok 2 - 第二项',
  'not ok 3 - 保存后必须看到平台提示',
  '  ---',
  "  error: '没有看到平台提示'",
  '  ...',
  '# tests 3',
  '# suites 0',
  '# pass 2',
  '# fail 1',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 20',
]);

/* ============================================================ 1. require 无副作用 */

test('require 时没有副作用：不打印、不跑测试、不动 exitCode 和窗口标题', () => {
  const spent = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const beforeExit = process.exitCode;
  const beforeTitle = process.title;

  let fresh;
  process.stdout.write = chunk => { spent.push(String(chunk)); return true; };
  process.stderr.write = chunk => { spent.push(String(chunk)); return true; };
  try {
    delete require.cache[require.resolve(RUNNER_PATH)];
    fresh = require(RUNNER_PATH);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  assert.deepEqual(spent, [], 'require 不该打印任何东西');
  assert.equal(process.exitCode, beforeExit, 'require 不该动 process.exitCode');
  assert.equal(process.title, beforeTitle, 'require 不该改窗口标题');
  assert.equal(typeof fresh.runOfflineTests, 'function');
  assert.equal(typeof fresh.discoverTestFiles, 'function');
  assert.equal(typeof fresh.computeExitCode, 'function');
  assert.equal(typeof fresh.parseArgs, 'function');
});

/* ============================================================ 2. 发现 */

test('发现：只认第一层的 *.test.js，返回完整路径，顺序稳定', () => {
  const { discoverTestFiles } = loadRunner();
  const dir = tmpDir();
  writeFile(dir, 'b-second.test.js');
  writeFile(dir, 'a-first.test.js');
  writeFile(dir, '中文 名字.test.js');
  writeFile(dir, 'helper.js');                 // 不是 *.test.js
  writeFile(dir, 'notes.test.js.bak');         // 后缀不对
  writeFile(dir, 'nested/deep.test.js');       // 在子目录里，不递归
  fs.mkdirSync(path.join(dir, 'looks-like.test.js'));   // 目录不算文件

  const files = discoverTestFiles(dir);
  assert.deepEqual(files.map(f => path.basename(f)), [
    'a-first.test.js',
    'b-second.test.js',
    '中文 名字.test.js',
  ]);
  for (const file of files) {
    assert.ok(path.isAbsolute(file), '必须是完整路径：' + file);
    assert.ok(fs.existsSync(file), '报出来的路径要真的存在');
  }

  const missing = discoverTestFiles(path.join(dir, '不存在的目录'));
  assert.deepEqual(missing, [], '目录不在就是空列表，不抛异常');
});

/* ============================================================ 3. 选择 */

test('选择：--only 认子串、不区分大小写、逗号分隔，没匹配到的会报出来', () => {
  const { selectTestFiles } = loadRunner();
  const files = [
    '/t/a/cdp-connection.test.js',
    '/t/a/quiz-save.test.js',
    '/t/a/web-state.test.js',
  ];

  assert.deepEqual(selectTestFiles(files, '').selected, files);
  assert.deepEqual(selectTestFiles(files, []).unmatched, []);

  assert.deepEqual(selectTestFiles(files, 'QUIZ').selected, ['/t/a/quiz-save.test.js']);
  assert.deepEqual(selectTestFiles(files, 'quiz, web').selected, [
    '/t/a/quiz-save.test.js',
    '/t/a/web-state.test.js',
  ]);
  assert.deepEqual(selectTestFiles(files, 'web-state.test.js').selected, ['/t/a/web-state.test.js']);

  const none = selectTestFiles(files, '根本没有这个');
  assert.deepEqual(none.selected, []);
  assert.deepEqual(none.unmatched, ['根本没有这个']);

  const partial = selectTestFiles(files, 'web, 根本没有这个');
  assert.deepEqual(partial.selected, ['/t/a/web-state.test.js']);
  assert.deepEqual(partial.unmatched, ['根本没有这个']);
});

/* ============================================================ 4. 参数 */

test('参数：--no-pause / --list / --only / --timeout-ms 都认，重复不冲突，乱写要报错', () => {
  const { parseArgs, DEFAULT_FILE_TIMEOUT_MS } = loadRunner();

  assert.equal(parseArgs([]).pause, null, '默认看是不是真控制台');
  assert.equal(parseArgs(['--no-pause']).pause, false);
  assert.equal(parseArgs(['--no-pause', '--no-pause']).pause, false);
  assert.equal(parseArgs(['--pause']).pause, true);
  assert.equal(parseArgs(['--list']).list, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--only=web,quiz']).only, 'web,quiz');
  assert.equal(parseArgs(['--node=C:\\x\\node.exe']).node, 'C:\\x\\node.exe');
  assert.equal(parseArgs([]).timeoutMs, DEFAULT_FILE_TIMEOUT_MS);
  assert.equal(parseArgs(['--timeout-ms=1500']).timeoutMs, 1500);
  assert.equal(parseArgs(['--timeout-ms=0']).timeoutMs, 0);

  assert.throws(() => parseArgs(['--timeout-ms=x']), /整数/);
  assert.throws(() => parseArgs(['--timeout-ms=-1']), /整数/);
  assert.throws(() => parseArgs(['--没这个参数']), /不认识的参数/);
});

/* ============================================================ 5. 统计解析 */

test('统计：TAP 和 spec 两种形状都读得出来，读不到就说读不到', () => {
  const { summarizeNodeTestOutput } = loadRunner();

  const failure = summarizeNodeTestOutput(TAP_FAIL_3);
  assert.equal(failure.hasSummary, true);
  assert.equal(failure.tests, 3);
  assert.equal(failure.pass, 2);
  assert.equal(failure.fail, 1);
  assert.equal(failure.skipped, 0);
  assert.deepEqual(failure.failedNames, ['保存后必须看到平台提示']);

  const passed = summarizeNodeTestOutput(TAP_PASS_1);
  assert.equal(passed.tests, 1);
  assert.equal(passed.fail, 0);
  assert.equal(passed.durationMs, 12.5);

  const spec = summarizeNodeTestOutput('ℹ tests 5\nℹ pass 4\nℹ fail 1\nℹ duration_ms 12.5\n');
  assert.equal(spec.hasSummary, true);
  assert.equal(spec.tests, 5);
  assert.equal(spec.fail, 1);

  const junk = summarizeNodeTestOutput('SyntaxError: Unexpected token\n    at ...');
  assert.equal(junk.hasSummary, false);
  assert.equal(junk.tests, 0);
  assert.equal(summarizeNodeTestOutput('').hasSummary, false);
  assert.equal(summarizeNodeTestOutput(null).tests, 0);
});

/* ============================================================ 6. 定性 / 退出码 */

test('定性：退出码 0 才算通过；有统计+非零 = 测试失败；连统计都没有 = 没跑起来', () => {
  const { classifyChild } = loadRunner();

  assert.equal(classifyChild({ code: 0, output: TAP_PASS_1 }), 'pass');
  assert.equal(classifyChild({ code: 1, output: TAP_FAIL_3 }), 'fail');
  assert.equal(classifyChild({ code: 1, output: 'SyntaxError: Unexpected token' }), 'not-started');
  assert.equal(classifyChild({ code: null, signal: null, timedOut: true, output: '' }), 'timeout');
  assert.equal(classifyChild({ code: null, signal: 'SIGSEGV', output: '' }), 'crashed');
  assert.equal(classifyChild({ spawnError: new Error('ENOENT'), code: null }), 'not-started');
});

test('退出码：全过是 0；有失败或没跑起来都是非零；一个文件都没有是 2', () => {
  const { computeExitCode, EXIT_OK, EXIT_FAILED, EXIT_CANNOT_RUN } = loadRunner();
  const base = { files: 3, passed: 3, failed: 0, notStarted: 0, crashed: 0, timedOut: 0 };

  assert.equal(computeExitCode(base), EXIT_OK);
  assert.equal(computeExitCode(Object.assign({}, base, { passed: 2, failed: 1 })), EXIT_FAILED);
  assert.equal(computeExitCode(Object.assign({}, base, { passed: 2, notStarted: 1 })), EXIT_FAILED);
  assert.equal(computeExitCode(Object.assign({}, base, { passed: 2, timedOut: 1 })), EXIT_FAILED);
  assert.equal(computeExitCode(Object.assign({}, base, { passed: 2, crashed: 1 })), EXIT_FAILED);
  assert.equal(computeExitCode({ files: 0, passed: 0, failed: 0, notStarted: 0, crashed: 0, timedOut: 0 }), EXIT_CANNOT_RUN);
  assert.equal(computeExitCode(null), EXIT_CANNOT_RUN);
});

/* ============================================================ 7. 汇总文字不撒谎 */

test('加载失败：文件自己报错时，说明里要讲清楚"没跑起来"，不能装成用例失败', () => {
  const { summarizeNodeTestOutput, formatFileStatus, failingNameIsFile, buildSummary, computeExitCode } = loadRunner();
  const file = path.join(__dirname, '..', 'tests', 'fake-broken.test.js');
  const tapName = file.replace(/\\/g, '\\\\');   // Node 的 TAP 会把反斜杠转义

  const output = tap([
    'TAP version 13',
    '# Subtest: ' + tapName,
    'not ok 1 - ' + tapName,
    "  error: \"Unexpected identifier 'JS'\"",
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 0',
    '# fail 1',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ]);
  const stats = summarizeNodeTestOutput(output);
  assert.equal(stats.tests, 1);
  assert.equal(stats.fail, 1);

  const result = { file, status: 'fail', code: 1, output, stats, args: ['--test', file] };
  assert.equal(failingNameIsFile(result), true);
  assert.match(formatFileStatus(result), /没能跑起来/);

  // 而且是失败，不是通过
  const summary = buildSummary({ testsDir: 'tests', discovered: [file], selected: [file], results: [result] });
  assert.equal(summary.totals.failed, 1);
  assert.equal(computeExitCode(summary.totals), 1);

  // 普通的用例失败不能被误判成"加载失败"
  const normal = {
    file, status: 'fail', code: 1, output: TAP_FAIL_3,
    stats: summarizeNodeTestOutput(TAP_FAIL_3), args: ['--test', file],
  };
  assert.equal(failingNameIsFile(normal), false);
  assert.match(formatFileStatus(normal), /失败 1 项 \/ 通过 2 项/);
});

test('汇总：数字照实写，有失败时绝不出现"全部通过"', () => {
  const { formatSummary } = loadRunner();

  const failing = formatSummary({
    testsDir: 'tests',
    totals: {
      files: 2, passed: 1, failed: 1, notStarted: 0, crashed: 0, timedOut: 0,
      statsUnavailable: 0, emptyFiles: 0,
      cases: { tests: 5, pass: 4, fail: 1, skipped: 0, todo: 0 },
    },
  }, 1);
  assert.match(failing, /通过 1 \/ 失败 1 \/ 共 2/);
  assert.match(failing, /通过 4 项 · 失败 1 项/);
  assert.match(failing, /退出码 1/);
  assert.doesNotMatch(failing, /全部通过/);

  const ok = formatSummary({
    testsDir: 'tests',
    totals: {
      files: 1, passed: 1, failed: 0, notStarted: 0, crashed: 0, timedOut: 0,
      statsUnavailable: 0, emptyFiles: 0,
      cases: { tests: 3, pass: 3, fail: 0, skipped: 0, todo: 0 },
    },
  }, 0);
  assert.match(ok, /全部通过/);
  assert.match(ok, /退出码 0/);
  assert.match(ok, /共 3 项/);

  const vague = formatSummary({
    testsDir: 'tests',
    totals: {
      files: 1, passed: 1, failed: 0, notStarted: 0, crashed: 0, timedOut: 0,
      statsUnavailable: 1, emptyFiles: 0,
      cases: { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 },
    },
  }, 0);
  assert.match(vague, /只按退出码判定/, '统计读不到时要老实说');
});

/* ============================================================ 8. 暂停策略 */

test('暂停：--no-pause 一定不等；默认只在真控制台里等', async () => {
  const { shouldPause, waitForEnter } = loadRunner();

  assert.equal(shouldPause({ pause: false }, { isTTY: true }), false);
  assert.equal(shouldPause({ pause: false }, { isTTY: false }), false);
  assert.equal(shouldPause({ pause: null }, { isTTY: false }), false);
  assert.equal(shouldPause({ pause: null }, { isTTY: true }), true);
  assert.equal(shouldPause({ pause: true }, { isTTY: false }), true);

  // 收到回车就放行
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = waitForEnter({ stdin: input, stdout: output });
  input.write('\n');
  await waiting;

  // stdin 提前结束也不能挂住
  const ended = new PassThrough();
  ended.end();
  await waitForEnter({ stdin: ended, stdout: new PassThrough() });
});

/* ============================================================ 9. 跑一遍（假进程） */

test('跑一遍：一个文件一个进程、传完整路径（含空格和中文）、有失败就非零', { timeout: 20000 }, async () => {
  const { runOfflineTests, EXIT_FAILED } = loadRunner();
  const dir = tmpDir();
  writeFile(dir, 'aaa 中文 名字.test.js');
  writeFile(dir, 'bbb-plain.test.js');

  const spawnImpl = fakeSpawn({
    'aaa 中文 名字.test.js': { code: 0, stdout: TAP_PASS_1 },
    'bbb-plain.test.js': { code: 1, stdout: TAP_FAIL_3 },
  });
  const printed = [];

  const { summary, exitCode } = await runOfflineTests(
    { timeoutMs: 5000, node: 'C:\\假的 node\\node.exe', only: '' },
    {
      testsDir: dir,
      spawn: spawnImpl,
      log: chunk => printed.push(chunk),
      env: { NODE_OPTIONS: '--不该带下去', NODE_TEST_CONTEXT: 'child', PATH: 'x' },
      version: 'v-test',
    }
  );

  assert.equal(spawnImpl.calls.length, 2, '两个文件 = 两个独立进程');
  assert.deepEqual(
    spawnImpl.calls.map(call => path.basename(call.args[call.args.length - 1])),
    ['aaa 中文 名字.test.js', 'bbb-plain.test.js'],
    '顺序按文件名，且一个文件一个进程'
  );

  for (const call of spawnImpl.calls) {
    assert.equal(call.cmd, 'C:\\假的 node\\node.exe');
    assert.equal(call.args[0], '--test', '必须走 node --test');
    assert.ok(call.args.includes('--test-reporter=tap'), '要 TAP，统计才好解析');
    const target = call.args[call.args.length - 1];
    assert.ok(path.isAbsolute(target), '必须传完整路径：' + target);
    assert.ok(fs.existsSync(target), '传过去的路径要真的存在：' + target);
    assert.equal(path.resolve(call.options.cwd), path.resolve(__dirname, '..'), '工作目录是仓库根');
    assert.equal(call.options.env.NODE_OPTIONS, undefined, '外来的 NODE_OPTIONS 不该带下去');
    assert.equal(call.options.env.NODE_TEST_CONTEXT, undefined);
    assert.equal(call.options.env.PATH, 'x', '其它环境变量要留着');
  }

  assert.equal(summary.totals.files, 2);
  assert.equal(summary.totals.passed, 1);
  assert.equal(summary.totals.failed, 1);
  assert.equal(summary.totals.cases.tests, 4);
  assert.equal(summary.totals.cases.pass, 3);
  assert.equal(summary.totals.cases.fail, 1);
  assert.equal(exitCode, EXIT_FAILED);

  const text = printed.join('');
  assert.match(text, /退出码 1/);
  assert.doesNotMatch(text, /全部通过/, '有失败就不能说全部通过');
  assert.match(text, /保存后必须看到平台提示/, '失败用例名字要露出来');
});

test('选择：--only 只跑挑中的文件；挑不中就不跑并报错（退出码 2）', { timeout: 20000 }, async () => {
  const { runOfflineTests, EXIT_CANNOT_RUN, EXIT_OK } = loadRunner();
  const dir = tmpDir();
  writeFile(dir, 'web-state.test.js');
  writeFile(dir, 'quiz-save.test.js');
  writeFile(dir, 'runner.test.js');

  const spawnImpl = fakeSpawn({ '*': { code: 0, stdout: TAP_PASS_1 } });
  const printed = [];

  const picked = await runOfflineTests(
    { timeoutMs: 5000, only: 'web' },
    { testsDir: dir, spawn: spawnImpl, log: c => printed.push(c), env: {} }
  );
  assert.equal(picked.exitCode, EXIT_OK);
  assert.equal(spawnImpl.calls.length, 1);
  assert.equal(path.basename(spawnImpl.calls[0].args[2]), 'web-state.test.js');

  spawnImpl.calls.length = 0;
  const nothing = await runOfflineTests(
    { timeoutMs: 5000, only: '根本没有' },
    { testsDir: dir, spawn: spawnImpl, log: c => printed.push(c), env: {} }
  );
  assert.equal(nothing.exitCode, EXIT_CANNOT_RUN);
  assert.equal(spawnImpl.calls.length, 0, '挑不中就别乱跑');

  const emptyDir = tmpDir();
  const none = await runOfflineTests(
    { timeoutMs: 5000 },
    { testsDir: emptyDir, spawn: spawnImpl, log: c => printed.push(c), env: {} }
  );
  assert.equal(none.exitCode, EXIT_CANNOT_RUN);
  assert.equal(none.summary.totals.files, 0);
  assert.equal(spawnImpl.calls.length, 0);
  assert.match(printed.join(''), /没找到任何 \*\.test\.js/);
});

test('老 Node 不认 --test-reporter 时退回裸 --test，别把环境问题算成测试失败', { timeout: 20000 }, async () => {
  const { runOfflineTests, EXIT_OK } = loadRunner();
  const dir = tmpDir();
  writeFile(dir, 'old.test.js');

  let call = 0;
  const spawnImpl = (cmd, args, options) => {
    call += 1;
    spawnImpl.calls.push({ cmd, args: args.slice(), options });
    if (call === 1) {
      return makeFakeChild({ code: 9, stderr: 'node: bad option: --test-reporter=tap' });
    }
    return makeFakeChild({ code: 0, stdout: TAP_PASS_1 });
  };
  spawnImpl.calls = [];

  const { summary, exitCode } = await runOfflineTests(
    { timeoutMs: 5000 },
    { testsDir: dir, spawn: spawnImpl, log: () => {}, env: {} }
  );

  assert.equal(spawnImpl.calls.length, 2, '要重试一次');
  assert.ok(spawnImpl.calls[0].args.includes('--test-reporter=tap'));
  assert.ok(!spawnImpl.calls[1].args.includes('--test-reporter=tap'));
  assert.equal(spawnImpl.calls[1].args[0], '--test');
  assert.equal(summary.totals.passed, 1);
  assert.equal(summary.totals.notStarted, 0);
  assert.equal(exitCode, EXIT_OK);
});

test('卡死：超过时限就结束进程，并按失败算（绝不是通过）', { timeout: 20000 }, async () => {
  const { runOfflineTests, EXIT_FAILED } = loadRunner();
  const dir = tmpDir();
  writeFile(dir, 'hang.test.js');

  const spawnImpl = fakeSpawn({
    'hang.test.js': { hang: true, onKill: child => child.emit('close', null, 'SIGKILL') },
  });
  const printed = [];

  const { summary, exitCode } = await runOfflineTests(
    { timeoutMs: 30 },
    { testsDir: dir, spawn: spawnImpl, log: c => printed.push(c), env: {} }
  );

  assert.equal(summary.totals.timedOut, 1);
  assert.equal(exitCode, EXIT_FAILED);
  assert.match(printed.join(''), /超时/);
  assert.doesNotMatch(printed.join(''), /全部通过/);
});

/* ============================================================ 10. main：退出码与暂停 */

test('main：--list 只列文件不跑；--no-pause 不会去等回车', { timeout: 20000 }, async () => {
  const runner = loadRunner();
  const dir = tmpDir();
  writeFile(dir, 'web-state.test.js');
  writeFile(dir, 'quiz-save.test.js');

  const spawnImpl = fakeSpawn({ '*': { code: 0, stdout: TAP_PASS_1 } });
  const printed = [];
  const beforeExit = process.exitCode;
  const neverInput = new PassThrough();          // 永远不给输入：真去等就会挂住

  try {
    const result = await runner.main(['--list', '--no-pause'], {
      testsDir: dir,
      spawn: spawnImpl,
      log: c => printed.push(c),
      isTTY: true,
      stdin: neverInput,
      stdout: new PassThrough(),
      env: {},
    });
    assert.equal(result.exitCode, runner.EXIT_OK);
    assert.equal(spawnImpl.calls.length, 0, '--list 不许真跑测试');
    assert.match(printed.join(''), /web-state\.test\.js/);
    assert.match(printed.join(''), /quiz-save\.test\.js/);
  } finally {
    process.exitCode = beforeExit;
    neverInput.destroy();
  }
});

test('main：测试失败时退出码 1，而且 --pause 等回车不会把它盖掉', { timeout: 20000 }, async () => {
  const runner = loadRunner();
  const dir = tmpDir();
  writeFile(dir, 'bad.test.js');

  const printed = [];
  const input = new PassThrough();
  const beforeExit = process.exitCode;

  try {
    const running = runner.main(['--pause'], {
      testsDir: dir,
      spawn: fakeSpawn({ 'bad.test.js': { code: 1, stdout: TAP_FAIL_3 } }),
      log: c => printed.push(c),
      isTTY: false,
      stdin: input,
      stdout: new PassThrough(),
      env: {},
    });
    setTimeout(() => input.write('\n'), 20);     // 模拟用户按了一下回车
    const result = await running;

    assert.equal(result.exitCode, runner.EXIT_FAILED, '返回值要非零');
    assert.equal(process.exitCode, runner.EXIT_FAILED, 'process.exitCode 也要非零');
    assert.match(printed.join(''), /退出码 1/);
  } finally {
    process.exitCode = beforeExit;
    input.destroy();
  }
});

test('main：参数写错返回 2，并且把说明打出来（不抛异常）', async () => {
  const runner = loadRunner();
  const printed = [];
  const beforeExit = process.exitCode;
  try {
    const result = await runner.main(['--没有这个参数', '--no-pause'], {
      log: c => printed.push(c),
      isTTY: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
    assert.equal(result.exitCode, runner.EXIT_CANNOT_RUN);
    assert.equal(process.exitCode, runner.EXIT_CANNOT_RUN);
    assert.match(printed.join(''), /用法/);
  } finally {
    process.exitCode = beforeExit;
  }
});
