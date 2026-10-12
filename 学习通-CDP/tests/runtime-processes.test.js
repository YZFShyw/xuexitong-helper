'use strict';

/* runtime-processes.js 的离线测试 —— 全部用**假进程表 + 假 taskkill**，
 * 不查真实进程、不杀任何东西、不碰用户目录（只在系统临时目录里建自己的锁文件）。
 *
 * 这里锁的是几条"错了就会出人命"的规矩：
 *   · 判活必须看"创建时间 + 映像名 + 命令行里完整的 driver.js 路径"，
 *     只凭 PID 活着不算（PID 复用会把无关进程当成驱动器）；
 *   · 归属助手 Edge 必须看 **完整的 --user-data-dir 参数**，
 *     不许按端口猜、不许按"命令行里含 9222"猜；
 *   · 任何一步证据不足 → 一个进程都不许杀；
 *   · 单实例锁是原子的，并发启动只能有一个赢；退出只清自己的锁。
 *
 *     node tests/runtime-processes.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const rp = require('../runtime-processes.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rp-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

const DRIVER_SCRIPT = 'C:\\助手\\学习通-CDP\\driver.js';
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = 'C:\\Users\\Tester\\AppData\\Local\\Microsoft\\Edge\\User';

function mkdir(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function proc(o) {
  return {
    pid: o.pid,
    name: o.name || 'node.exe',
    exe: o.exe || NODE_EXE,
    cmdline: o.cmdline || '',
    ppid: o.ppid || 0,
    start: o.start || '1000',
  };
}

/** 装一套假进程表 + 假杀进程，并记录"谁被杀了" */
function withFakeWorld(list) {
  const killed = [];
  rp.__setProcessHooksForTest({
    queryProcesses: () => ({ ok: true, reason: '', list }),
    killPid: (pid) => { killed.push(pid); return { ok: true, reason: '' }; },
  });
  return { killed, list };
}

function writeLock(dir, lock) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, rp.LOCK_FILE), JSON.stringify(lock), 'utf8');
}

function driverLock(over) {
  return Object.assign({
    v: 1,
    pid: 4242,
    start: '1000',
    exe: NODE_EXE,
    script: DRIVER_SCRIPT,
    batch: 'b-1',
    token: 'tok',
  }, over || {});
}

test.afterEach(() => { rp.__resetProcessHooksForTest(); });

/* ---------------- 命令行解析 ---------------- */

test('Windows 命令行解析：引号、空格、反斜杠转义', () => {
  const r = rp.parseWindowsCommandLine('"C:\\Program Files\\nodejs\\node.exe" --run --user-data-dir="C:\\a b\\c" --remote-debugging-port=9222');
  assert.equal(r.exe, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(r.args, ['--run', '--user-data-dir=C:\\a b\\c', '--remote-debugging-port=9222']);
  /* 命令行里的反斜杠转义（CommandLineToArgvW 规则）：
     "C:\dir\\" 里的两个反斜杠 + 引号 = 一个字面反斜杠 + 结束引号。 */
  const r2 = rp.parseWindowsCommandLine('"C:\\dir\\\\" x');
  assert.equal(r2.exe, 'C:\\dir\\');
  assert.deepEqual(r2.args, ['x']);
  /* 一个反斜杠 + 引号在参数里表示字面引号（不是结束引号）。
     注意这个函数的输入永远是"完整命令行"（第一个 token 是映像路径），
     所以这里也照真实形状写。 */
  const r3 = rp.parseWindowsCommandLine('"C:\\x\\node.exe" a\\"b --flag');
  assert.deepEqual(r3.args, ['a"b', '--flag']);
});

test('路径比较是"整条相等"，不是子串包含', () => {
  assert.equal(rp.pathEquals('C:\\a\\b\\driver.js', 'c:/A/B/DRIVER.JS'), true, '大小写与斜杠要归一');
  assert.equal(rp.pathEquals('C:\\a\\b\\driver.js', 'C:\\a\\b\\driver.js.bak'), false);
  assert.equal(rp.pathEquals('C:\\a\\b', 'C:\\a\\bc'), false);
  assert.equal(rp.pathEquals('C:\\a\\b', 'C:\\a\\b\\c'), false);
  assert.equal(rp.pathEquals('', 'C:\\a'), false, '空路径永远是"不相等"');
});

test('argValue 只认整条相等的开关名，且畸形（裸开关）返回 null', () => {
  const args = ['--user-data-dir=C:\\x', '--remote-debugging-port=9222', '--no-first-run'];
  assert.equal(rp.argValue(args, '--user-data-dir'), 'C:\\x');
  assert.equal(rp.argValue(args, '--user-data-dir-extra'), null);
  assert.equal(rp.argValue(args, '--no-first-run'), null, '裸开关没有值，不能当成空字符串');
  assert.equal(rp.hasArg(args, '--no-first-run'), true);
});

/* ---------------- 驱动器身份 ---------------- */

test('判活：PID 活着但映像名不对（PID 被复用）→ 不算驱动器', () => {
  const dir = mkdir('reuse-name');
  writeLock(dir, driverLock());
  withFakeWorld([proc({ pid: 4242, name: 'explorer.exe', exe: 'C:\\Windows\\explorer.exe',
    cmdline: '"C:\\Windows\\explorer.exe"', start: '1000' })]);
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, false);
  assert.equal(r.verified, false);
  assert.match(r.reason, /不是 node\.exe|PID 被复用/);
});

test('判活：映像名对、命令行也对，但创建时间不一致（PID 复用）→ 不算驱动器', () => {
  const dir = mkdir('reuse-time');
  writeLock(dir, driverLock({ start: '1111' }));
  withFakeWorld([proc({ pid: 4242, start: '2222', cmdline: '"' + NODE_EXE + '" "' + DRIVER_SCRIPT + '"' })]);
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, false);
  assert.match(r.reason, /创建时间/);
});

test('判活：node 命令行里只是"含有 driver.js 字样"（.bak / 别的目录）→ 不算驱动器', () => {
  const dir = mkdir('substring');
  writeLock(dir, driverLock());
  withFakeWorld([
    proc({ pid: 4242, cmdline: '"' + NODE_EXE + '" "' + DRIVER_SCRIPT + '.bak"' }),
  ]);
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, false, 'C:\\x\\driver.js.bak 绝不能当成 C:\\x\\driver.js');

  const dir2 = mkdir('substring2');
  writeLock(dir2, driverLock());
  withFakeWorld([
    proc({ pid: 4242, cmdline: '"' + NODE_EXE + '" "C:\\别的目录\\driver.js"' }),
  ]);
  assert.equal(rp.readVerifiedDriver(dir2, { driverScript: DRIVER_SCRIPT }).alive, false);
});

test('判活：四样全对上才算"在跑"', () => {
  const dir = mkdir('ok');
  writeLock(dir, driverLock());
  withFakeWorld([
    proc({ pid: 4242, start: '1000', cmdline: '"' + NODE_EXE + '" --run --next "' + DRIVER_SCRIPT + '"' }),
  ]);
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, true);
  assert.equal(r.verified, true);
  assert.equal(r.pid, 4242);
});

test('判活：进程表查不到时不许下结论（probeFailed），更不许据此杀进程', () => {
  const dir = mkdir('probe-fail');
  writeLock(dir, driverLock());
  rp.__setProcessHooksForTest({ queryProcesses: () => ({ ok: false, reason: 'PowerShell 被禁用', list: [] }) });
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, false);
  assert.equal(r.probeFailed, true);
  assert.equal(r.verified, false);
});

test('旧 运行中.pid 只能当线索：指向活着的非 node 进程 → alive=false', () => {
  const dir = mkdir('legacy');
  fs.writeFileSync(path.join(dir, rp.LEGACY_PID_FILE), '777', 'utf8');
  withFakeWorld([proc({ pid: 777, name: 'chrome.exe', exe: 'C:\\chrome.exe', cmdline: '"C:\\chrome.exe"' })]);
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, false);
  assert.match(r.reason, /不是驱动器|PID 被复用/);
});

test('旧 运行中.pid 指向一个已经不在的 PID → 陈旧记录，不算在跑', () => {
  const dir = mkdir('legacy-stale');
  fs.writeFileSync(path.join(dir, rp.LEGACY_PID_FILE), '779', 'utf8');
  withFakeWorld([proc({ pid: 1, name: 'init.exe' })]);
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, false);
  assert.match(r.reason, /不存在|陈旧/);
});

test('旧 运行中.pid 指向真的驱动着 driver.js 的 node → 只当线索（verified=false）', () => {
  const dir = mkdir('legacy2');
  fs.writeFileSync(path.join(dir, rp.LEGACY_PID_FILE), '778', 'utf8');
  withFakeWorld([proc({ pid: 778, cmdline: '"' + NODE_EXE + '" "' + DRIVER_SCRIPT + '"' })]);
  const r = rp.readVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.alive, true);
  assert.equal(r.verified, false, '没有创建时间可比，只能说"看起来是"，不能算完全验证');
  assert.equal(r.legacy, true);
});

/* ---------------- 停止驱动器 ---------------- */

test('停止：PID 指向无关进程时，一个进程都不杀', async () => {
  const dir = mkdir('stop-safe');
  writeLock(dir, driverLock());
  const w = withFakeWorld([proc({ pid: 4242, name: 'notepad.exe', exe: 'C:\\notepad.exe',
    cmdline: '"C:\\notepad.exe"', start: '1000' })]);
  const r = await rp.stopVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.killed, false);
  assert.deepEqual(w.killed, [], '绝不能杀无关进程');
  assert.equal(r.pid, 4242);
});

test('停止：身份验证通过才杀，而且只按 PID 杀', async () => {
  const dir = mkdir('stop-ok');
  writeLock(dir, driverLock());
  const w = withFakeWorld([
    proc({ pid: 4242, start: '1000', cmdline: '"' + NODE_EXE + '" "' + DRIVER_SCRIPT + '"' }),
  ]);
  const r = await rp.stopVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.ok, true);
  assert.equal(r.killed, true);
  assert.deepEqual(w.killed, [4242]);
});

test('停止：没有记录时什么都不杀（也不报错）', async () => {
  const dir = mkdir('stop-none');
  const w = withFakeWorld([]);
  const r = await rp.stopVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.killed, false);
  assert.deepEqual(w.killed, []);
});

test('停止：taskkill 报错但进程其实已经退出 → 按"已停止"算，并清掉作废记录（否则会永久挡住启动）', async () => {
  const dir = mkdir('stop-gone');
  writeLock(dir, driverLock());
  const live = [proc({ pid: 4242, start: '1000', cmdline: '"' + NODE_EXE + '" "' + DRIVER_SCRIPT + '"' })];
  let calls = 0;
  rp.__setProcessHooksForTest({
    /* 第一次查（判活）看得见进程；taskkill 之后它已经不在了 */
    queryProcesses: () => { calls++; return { ok: true, reason: '', list: calls <= 2 ? live : [] }; },
    killPid: () => ({ ok: false, reason: 'taskkill 退出码 1（找不到该进程）' }),
  });
  const r = await rp.stopVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.ok, true, '进程已经不在了就不能报"没停成"');
  assert.equal(r.killed, false);
  assert.match(r.reason, /已经不在进程表里/);
  assert.equal(fs.existsSync(path.join(dir, rp.LOCK_FILE)), false, '作废的记录要清掉，否则下次启动永远被挡住');
});

test('停止：taskkill 报错且进程还活着 → 如实报失败，绝不假装停掉了', async () => {
  const dir = mkdir('stop-fail');
  writeLock(dir, driverLock());
  const live = [proc({ pid: 4242, start: '1000', cmdline: '"' + NODE_EXE + '" "' + DRIVER_SCRIPT + '"' })];
  rp.__setProcessHooksForTest({
    queryProcesses: () => ({ ok: true, reason: '', list: live }),
    killPid: () => ({ ok: false, reason: '拒绝访问' }),
  });
  const r = await rp.stopVerifiedDriver(dir, { driverScript: DRIVER_SCRIPT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /taskkill 失败/);
  assert.equal(fs.existsSync(path.join(dir, rp.LOCK_FILE)), true, '进程还在，锁必须留着');
});

/* ---------------- 助手 Edge 的归属 ---------------- */

test('Edge 归属：只认完整的 --user-data-dir 参数，不认"命令行里含 9222"', () => {
  const ok = rp.classifyEdgeCommandLine(proc({
    pid: 10, name: 'msedge.exe', exe: EDGE_EXE,
    cmdline: '"' + EDGE_EXE + '" --remote-debugging-port=9222 --user-data-dir="' + PROFILE + '"',
  }), PROFILE, 9222);
  assert.equal(ok.ok, true);
  assert.equal(ok.isMain, true);

  /* 端口对上、但没有独立 profile → 不认（普通 Edge 也可能开调试端口） */
  const noProfile = rp.classifyEdgeCommandLine(proc({
    pid: 11, name: 'msedge.exe', exe: EDGE_EXE,
    cmdline: '"' + EDGE_EXE + '" --remote-debugging-port=9222',
  }), PROFILE, 9222);
  assert.equal(noProfile.ok, false);

  /* profile 是另一个目录 → 不认 */
  const other = rp.classifyEdgeCommandLine(proc({
    pid: 12, name: 'msedge.exe', exe: EDGE_EXE,
    cmdline: '"' + EDGE_EXE + '" --remote-debugging-port=9222 --user-data-dir="' + PROFILE + '2"',
  }), PROFILE, 9222);
  assert.equal(other.ok, false, 'C:\\...\\User 不能命中 C:\\...\\User2');
});

test('Edge 归属：子进程（带 --type）不算主进程；只有一个主进程才认领', () => {
  const list = [
    proc({ pid: 100, name: 'msedge.exe', exe: EDGE_EXE, ppid: 1,
      cmdline: '"' + EDGE_EXE + '" --user-data-dir="' + PROFILE + '" --remote-debugging-port=9222' }),
    proc({ pid: 101, name: 'msedge.exe', exe: EDGE_EXE, ppid: 100,
      cmdline: '"' + EDGE_EXE + '" --type=renderer --user-data-dir="' + PROFILE + '" --remote-debugging-port=9222' }),
    proc({ pid: 102, name: 'msedge.exe', exe: EDGE_EXE, ppid: 100,
      cmdline: '"' + EDGE_EXE + '" --type=gpu-process --user-data-dir="' + PROFILE + '" --remote-debugging-port=9222' }),
  ];
  const r = rp.pickOwnedEdge(list, PROFILE, 9222);
  assert.equal(r.ok, true);
  assert.equal(r.proc.pid, 100);

  /* 两个主进程长得一样 → 分不清，拒绝 */
  const ambiguous = rp.pickOwnedEdge(list.concat([
    proc({ pid: 200, name: 'msedge.exe', exe: EDGE_EXE, ppid: 1,
      cmdline: '"' + EDGE_EXE + '" --user-data-dir="' + PROFILE + '" --remote-debugging-port=9222' }),
  ]), PROFILE, 9222);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.reason, /分不清|2 个/);
});

test('停止助手 Edge：没有凭证、现场也认不出来 → 拒绝，且一个都不杀', async () => {
  const dir = mkdir('edge-nocred');
  const w = withFakeWorld([
    proc({ pid: 500, name: 'msedge.exe', exe: EDGE_EXE, cmdline: '"' + EDGE_EXE + '" --user-data-dir="C:\\别人的\\User"' }),
  ]);
  const r = await rp.stopOwnedEdge({ baseDir: dir, profileDir: PROFILE, port: 9222 });
  assert.equal(r.ok, false);
  assert.equal(r.count, 0);
  assert.deepEqual(w.killed, []);
  assert.match(r.reason, /一个进程都没动|拒绝/);
});

test('停止助手 Edge：凭证里的 profile 跟请求不一致 → 拒绝', async () => {
  const dir = mkdir('edge-mismatch');
  fs.writeFileSync(path.join(dir, rp.EDGE_OWN_FILE), JSON.stringify({
    v: 1, pid: 500, start: '1000', exe: EDGE_EXE, profileDir: PROFILE, port: 9222,
  }), 'utf8');
  const w = withFakeWorld([
    proc({ pid: 500, name: 'msedge.exe', exe: EDGE_EXE, cmdline: '"' + EDGE_EXE + '" --user-data-dir="' + PROFILE + '"' }),
  ]);
  const r = await rp.stopOwnedEdge({ baseDir: dir, profileDir: 'C:\\别的\\User', port: 9222 });
  assert.equal(r.ok, false);
  assert.deepEqual(w.killed, []);
});

test('停止助手 Edge：凭证有效 → 只杀这个主进程和它的后代，绝不 /IM', async () => {
  const dir = mkdir('edge-ok');
  fs.writeFileSync(path.join(dir, rp.EDGE_OWN_FILE), JSON.stringify({
    v: 1, pid: 500, start: '1000', exe: EDGE_EXE, profileDir: PROFILE, port: 9222,
  }), 'utf8');
  const w = withFakeWorld([
    proc({ pid: 500, name: 'msedge.exe', exe: EDGE_EXE, ppid: 1, start: '1000',
      cmdline: '"' + EDGE_EXE + '" --user-data-dir="' + PROFILE + '" --remote-debugging-port=9222' }),
    proc({ pid: 501, name: 'msedge.exe', exe: EDGE_EXE, ppid: 500, cmdline: '"' + EDGE_EXE + '" --type=renderer' }),
    proc({ pid: 502, name: 'msedge.exe', exe: EDGE_EXE, ppid: 501, cmdline: '"' + EDGE_EXE + '" --type=utility' }),
    /* 用户自己的 Edge（别的 profile）：绝不能被碰 */
    proc({ pid: 900, name: 'msedge.exe', exe: EDGE_EXE, ppid: 1, start: '999',
      cmdline: '"' + EDGE_EXE + '" --user-data-dir="C:\\Users\\Tester\\AppData\\Local\\Microsoft\\Edge\\User"' }),
    /* 跟助手 Edge 无关的进程：就算它挂在同一个父进程下也不算"它的树" */
    proc({ pid: 901, name: 'notepad.exe', exe: 'C:\\notepad.exe', ppid: 1, cmdline: '"C:\\notepad.exe"' }),
  ]);
  const r = await rp.stopOwnedEdge({ baseDir: dir, profileDir: PROFILE, port: 9222 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.deepEqual(w.killed.slice().sort((a, b) => a - b), [500, 501, 502]);
  assert.equal(w.killed.includes(900), false, '用户自己的 Edge 不能被杀');
  assert.equal(w.killed.includes(901), false, '不属于它的进程不能跟着被杀');
  assert.equal(fs.existsSync(path.join(dir, rp.EDGE_OWN_FILE)), false, '关成功要把凭证清掉');
});

test('停止助手 Edge：PID 复用（创建时间对不上）→ 拒绝', async () => {
  const dir = mkdir('edge-reuse');
  fs.writeFileSync(path.join(dir, rp.EDGE_OWN_FILE), JSON.stringify({
    v: 1, pid: 500, start: '1000', exe: EDGE_EXE, profileDir: PROFILE, port: 9222,
  }), 'utf8');
  const w = withFakeWorld([
    proc({ pid: 500, name: 'msedge.exe', exe: EDGE_EXE, start: '2000',
      cmdline: '"' + EDGE_EXE + '" --user-data-dir="' + PROFILE + '" --remote-debugging-port=9222' }),
  ]);
  const r = await rp.stopOwnedEdge({ baseDir: dir, profileDir: PROFILE, port: 9222 });
  assert.equal(r.ok, false);
  assert.deepEqual(w.killed, []);
  assert.match(r.reason, /PID 被复用/);
});

/* ---------------- 单实例锁 ---------------- */

test('抢锁：没有锁文件时能拿到，并且记下创建时间与 driver.js 路径', () => {
  const dir = mkdir('lock-fresh');
  const r = rp.acquireDriverLock(dir, {
    pid: process.pid, start: '12345', exe: NODE_EXE, driverScript: DRIVER_SCRIPT, batch: 'b-1',
  });
  assert.equal(r.ok, true);
  const j = JSON.parse(fs.readFileSync(path.join(dir, rp.LOCK_FILE), 'utf8'));
  assert.equal(j.pid, process.pid);
  assert.equal(j.start, '12345');
  assert.equal(j.script, DRIVER_SCRIPT);
  assert.ok(j.token, '要有 token 才能验证"锁还是不是我的"');
});

test('抢锁：已经有一个验证通过的驱动器在跑 → 拒绝启动（并发启动只准一个）', () => {
  const dir = mkdir('lock-busy');
  writeLock(dir, driverLock());
  withFakeWorld([
    proc({ pid: 4242, start: '1000', cmdline: '"' + NODE_EXE + '" "' + DRIVER_SCRIPT + '"' }),
  ]);
  const r = rp.acquireDriverLock(dir, {
    pid: process.pid, start: '5555', exe: NODE_EXE, driverScript: DRIVER_SCRIPT,
  });
  assert.equal(r.ok, false);
  assert.equal(r.holder.pid, 4242);
  assert.match(r.reason, /已经有一个驱动器在跑/);
});

test('抢锁：陈旧锁（主人验证不过）会被接管，不会挡住启动', () => {
  const dir = mkdir('lock-stale');
  writeLock(dir, driverLock());
  withFakeWorld([
    /* PID 被回收给了一个完全无关的进程 */
    proc({ pid: 4242, name: 'svchost.exe', exe: 'C:\\svchost.exe', cmdline: '"C:\\svchost.exe"', start: '1000' }),
  ]);
  const r = rp.acquireDriverLock(dir, {
    pid: process.pid, start: '5555', exe: NODE_EXE, driverScript: DRIVER_SCRIPT,
  });
  assert.equal(r.ok, true);
  const j = JSON.parse(fs.readFileSync(path.join(dir, rp.LOCK_FILE), 'utf8'));
  assert.equal(j.pid, process.pid, '陈旧锁必须被自己的记录顶掉');
});

test('抢锁：锁文件损坏且删不掉时要**明确失败**，不许静默继续', () => {
  const dir = mkdir('lock-corrupt');
  fs.writeFileSync(path.join(dir, rp.LOCK_FILE), '{ 这不是 JSON', 'utf8');
  /* 用一个"删不掉的"目录冒充锁文件：unlink 一个目录会失败 */
  const dir2 = mkdir('lock-corrupt2');
  fs.mkdirSync(path.join(dir2, rp.LOCK_FILE));
  withFakeWorld([]);
  const r = rp.acquireDriverLock(dir2, {
    pid: process.pid, start: '5555', exe: NODE_EXE, driverScript: DRIVER_SCRIPT,
  });
  assert.equal(r.ok, false);
  assert.equal(r.metaFailed, true);
  assert.match(r.reason, /损坏|删不掉|写锁失败/);

  /* 正常的"坏 JSON"文件应该能被删掉并重新抢到 */
  const r2 = rp.acquireDriverLock(dir, {
    pid: process.pid, start: '5555', exe: NODE_EXE, driverScript: DRIVER_SCRIPT,
  });
  assert.equal(r2.ok, true);
});

test('抢锁：PID 不是正常值 / 没有创建时间 → 明确失败（不写坏锁）', () => {
  const dir = mkdir('lock-badmeta');
  const a = rp.acquireDriverLock(dir, { pid: -1, start: '1', driverScript: DRIVER_SCRIPT });
  assert.equal(a.ok, false);
  assert.equal(a.metaFailed, true);
  const b = rp.acquireDriverLock(dir, { pid: process.pid, start: '', driverScript: DRIVER_SCRIPT });
  assert.equal(b.ok, false);
  assert.equal(b.metaFailed, true);
  assert.equal(fs.existsSync(path.join(dir, rp.LOCK_FILE)), false);
});

test('解锁：只清自己的锁，内容不是自己的一个字节都不动', () => {
  const dir = mkdir('lock-release');
  writeLock(dir, driverLock({ pid: 9999, token: 'other' }));
  const r = rp.releaseDriverLock(dir, { pid: process.pid, token: 'mine' });
  assert.equal(r.removed, false);
  assert.equal(fs.existsSync(path.join(dir, rp.LOCK_FILE)), true, '别人的锁不许删');

  const dir2 = mkdir('lock-release2');
  const acq = rp.acquireDriverLock(dir2, {
    pid: process.pid, start: '5555', exe: NODE_EXE, driverScript: DRIVER_SCRIPT,
  });
  assert.equal(acq.ok, true);
  const j = JSON.parse(fs.readFileSync(path.join(dir2, rp.LOCK_FILE), 'utf8'));
  const r2 = rp.releaseDriverLock(dir2, { pid: process.pid, token: j.token });
  assert.equal(r2.removed, true);
  assert.equal(fs.existsSync(path.join(dir2, rp.LOCK_FILE)), false);
});

test('旧 运行中.pid：只有内容是自己写的才会被删', () => {
  const dir = mkdir('legacy-own');
  rp.writeLegacyPidFile(dir, 4321);
  assert.equal(rp.removeLegacyPidFileIfOwn(dir, 1).ok, false);
  assert.equal(fs.existsSync(path.join(dir, rp.LEGACY_PID_FILE)), true);
  assert.equal(rp.removeLegacyPidFileIfOwn(dir, 4321).ok, true);
  assert.equal(fs.existsSync(path.join(dir, rp.LEGACY_PID_FILE)), false);
});
