/* run-bootstrap.test.js —— 离线验证「批次 + 日志轮转」这条启动链
 *
 * 覆盖：
 *   A. 批次标识：用户新启动 = 新批次；外套内部重拉（--reuse-env）= 沿用，不产生新批次；
 *   B. 日志轮转：旧 运行日志.txt 被归档到 日志\、最多留 12 份、**永不删除**旧日志，
 *      空日志 / 没有日志时安静跳过；
 *   C. 本次运行.json：批次 = sessionId、日志名、归档名都写对，界面靠它区分本轮/上轮；
 *   D. 两种启动入口共用同一份实现：网页控制台把 sessionId 当 DSH_BATCH 传给外套，
 *      开始.cmd 的 :startfresh 走 run-bootstrap.js 且不再 del 运行日志；
 *   E. --status-exit：给 cmd 用的机器可读判活（退出码 = 结论，且要求 alive && verified）。
 *
 * 全部写在系统临时目录里，退出时删掉自己建的那一个；不读任何真实记录/配置。
 *
 * 跑法：node --test tests\run-bootstrap.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const boot = require(path.join(ROOT, 'run-bootstrap.js'));
const wstate = require(path.join(ROOT, 'web-state.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-test-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

let seq = 0;
function mkBase() {
  const d = path.join(TMP, 'b' + (++seq));
  fs.mkdirSync(d, { recursive: true });
  assert.ok(path.resolve(d).startsWith(path.resolve(os.tmpdir()) + path.sep), '测试只能写临时目录');
  return d;
}
const readRun = (base) => JSON.parse(fs.readFileSync(path.join(base, '本次运行.json'), 'utf8'));
const listArchives = (base) => {
  const dir = path.join(base, wstate.LOG_DIR_NAME);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
};

/* ============================================================================
 * A. 批次标识
 * ==========================================================================*/

test('新启动（不带 --reuse-env）→ 永远生成新批次，不背环境里的旧批次', () => {
  const base = mkBase();
  const r1 = boot.prepareBatch({ baseDir: base, env: { DSH_BATCH: 'old-batch-1' }, makeBatchId: () => 'NEW-1' });
  assert.equal(r1.batch, 'NEW-1');
  assert.equal(r1.reused, false, '开始.cmd 是新启动入口：双击它就是要开新的一轮');
  assert.equal(readRun(base).sessionId, 'NEW-1', '本次运行.json 里的批次必须就是回给 cmd 的那个');

  const r2 = boot.prepareBatch({ baseDir: base, env: { DSH_BATCH: 'NEW-1' }, makeBatchId: () => 'NEW-2' });
  assert.equal(r2.batch, 'NEW-2', '第二次新启动必须是新批次（否则会把上一批的账背过来）');
});

test('外套内部重拉（--reuse-env）→ 沿用同一个批次，绝不生成新的', () => {
  const base = mkBase();
  const r = boot.prepareBatch({ baseDir: base, env: { DSH_BATCH: 'keep-me-9' }, reuseEnv: true, makeBatchId: () => 'SHOULD-NOT-HAPPEN' });
  assert.equal(r.batch, 'keep-me-9');
  assert.equal(r.reused, true);
  assert.equal(readRun(base).sessionId, 'keep-me-9');
});

test('--reuse-env 但环境里没有合法批次时 → 兜底生成一个（不能空着）', () => {
  const base = mkBase();
  const r = boot.prepareBatch({ baseDir: base, env: {}, reuseEnv: true, makeBatchId: () => 'FALLBACK-1' });
  assert.equal(r.batch, 'FALLBACK-1');
  assert.equal(r.reused, false);
});

test('命令行默认（不带 --reuse-env）也是新批次', () => {
  const base = mkBase();
  const out = [];
  const r = boot.cliMain(['--base', base], {
    env: { DSH_BATCH: 'env-old' },
    makeBatchId: () => 'CLI-NEW',
    write: (s) => out.push(s),
    nowMs: 1750000000000,
  });
  assert.equal(r.result.batch, 'CLI-NEW');
  assert.ok(out.join('').indexOf('BATCH=CLI-NEW') >= 0);
  assert.ok(out.join('').indexOf('REUSED=0') >= 0);
});

/* ============================================================================
 * B. 日志轮转
 * ==========================================================================*/

test('旧运行日志被归档（不是删掉），并只保留最近 12 份', () => {
  const base = mkBase();
  const log = path.join(base, '运行日志.txt');
  /* 先造 20 份"更早的归档"，验证保留份数 */
  const dir = path.join(base, wstate.LOG_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i++) {
    const f = path.join(dir, '运行日志-20260101-0000' + String(i).padStart(2, '0') + '.txt');
    fs.writeFileSync(f, '旧的第 ' + i + ' 份\n', 'utf8');
    /* 时间戳拉开，保证排序稳定 */
    const t = new Date(2026, 0, 1, 0, 0, i);
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(log, '上一轮为什么挂——这句话不能被删掉\n', 'utf8');

  const r = boot.prepareBatch({ baseDir: base, env: {}, makeBatchId: () => 'B-ROT', nowMs: Date.now() });
  assert.equal(r.rotated, true, '旧日志必须被归档');
  assert.equal(r.rotateOk, true);
  assert.ok(listArchives(base).length <= wstate.LOG_ARCHIVE_KEEP,
    '归档最多保留 ' + wstate.LOG_ARCHIVE_KEEP + ' 份，实际 ' + listArchives(base).length);
  assert.equal(fs.existsSync(log), false, '归档走的是 rename：原文件位置应该空了（下一轮驱动会重新创建）');

  /* 归档内容还在（没被销毁） */
  const all = listArchives(base).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
  assert.match(all, /上一轮为什么挂/, '旧日志的内容必须还在某个归档里 —— 归档不是删除');
});

test('空日志 / 没有日志 → 安静跳过，不建空归档', () => {
  const base = mkBase();
  const log = path.join(base, '运行日志.txt');
  const r1 = boot.prepareBatch({ baseDir: base, env: {}, makeBatchId: () => 'B-1' });
  assert.equal(r1.rotated, false);
  assert.equal(r1.rotateOk, true);
  assert.deepEqual(listArchives(base), [], '第一次跑（没有日志）不该产生归档');

  fs.writeFileSync(log, '', 'utf8');
  const r2 = boot.prepareBatch({ baseDir: base, env: {}, makeBatchId: () => 'B-2' });
  assert.equal(r2.rotated, false);
  assert.match(r2.rotateReason, /空|没有/);
  assert.deepEqual(listArchives(base), [], '空日志不该被归档');
});

test('轮转失败要如实上报（绝不静默销毁/静默跳过）', () => {
  const base = mkBase();
  const log = path.join(base, '运行日志.txt');
  fs.writeFileSync(log, '内容\n', 'utf8');
  /* 把 日志\ 做成一个**文件**，让它 mkdir 失败 —— 模拟"归档不了" */
  fs.writeFileSync(path.join(base, wstate.LOG_DIR_NAME), 'not a dir', 'utf8');
  const r = boot.prepareBatch({ baseDir: base, env: {}, makeBatchId: () => 'B-FAIL' });
  assert.equal(r.rotateOk, false, '归档不了必须说出来');
  assert.equal(r.rotated, false);
  assert.ok(r.rotateReason.length > 0, '要给出原因');
  assert.equal(fs.existsSync(log), true, '归档失败时一个字节都不许动旧日志');
  assert.equal(fs.readFileSync(log, 'utf8'), '内容\n');
});

/* ============================================================================
 * C. 本次运行.json
 * ==========================================================================*/

test('本次运行.json：批次=sessionId、日志名、归档名都写对；读得回来', () => {
  const base = mkBase();
  const log = path.join(base, '运行日志.txt');
  fs.writeFileSync(log, '上一轮的内容\n', 'utf8');
  const r = boot.prepareBatch({ baseDir: base, env: {}, makeBatchId: () => 'B-RUN', nowMs: 1750000000000 });
  const rec = wstate.readRunRecord(path.join(base, '本次运行.json'));
  assert.ok(rec, '写出来的必须是可读的批次记录');
  assert.equal(rec.sessionId, 'B-RUN');
  assert.equal(rec.log, '运行日志.txt');
  assert.equal(rec.logArchive, r.archive);
  assert.ok(r.archive.length > 0);
  /* 界面判"本轮/上轮"靠的就是这几个字段 */
  const view = wstate.deriveLogView({
    exists: true, hasContent: true, logName: '运行日志.txt',
    logMtimeMs: 1750000001000, run: rec,
  });
  assert.equal(view.belongsToRun, true);
  assert.equal(view.stale, false);
});

/* ============================================================================
 * D. 两种启动入口共用同一份实现
 * ==========================================================================*/

test('网页控制台：把 本次运行.json 的 sessionId 当 DSH_BATCH 传给外套（env 其余字段保留）', () => {
  const src = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  const i = src.indexOf('function startDriverCore()');
  assert.ok(i > 0, 'startDriverCore 必须还在');
  const body = src.slice(i, i + 3000);
  assert.match(body, /wstate\.rotateRunLog\(/, '网页控制台也走共享的轮转（不自己删日志）');
  assert.match(body, /wstate\.makeRunRecord\(/);
  assert.match(body, /wstate\.writeRunRecord\(F\.run, rec\)/);
  assert.match(body, /DSH_BATCH:\s*rec\.sessionId/,
    '批次标识必须真的传给外套：否则 本次运行.json 记的批次和检查点文件名对不上');
  assert.match(body, /Object\.assign\(\{\}, process\.env,/, 'env 里其余字段要保留');
  assert.doesNotMatch(body, /unlinkSync\(F\.log\)/, '不许再直接删运行日志');
});

test('开始.cmd 的 :startfresh：不再 del 运行日志.txt，改成调 run-bootstrap.js', () => {
  const enc = new (require('node:util').TextDecoder ? require('node:util') : {}).TextDecoder;
  void enc;
  /* 开始.cmd 是 GBK936，按字节读出来做 ASCII 子串判断即可（它引用的是脚本名/变量名） */
  const buf = fs.readFileSync(path.join(ROOT, '_内部', '开始.cmd'));
  const ascii = buf.toString('latin1');
  assert.match(ascii, /run-bootstrap\.js/, '必须调用共享模块');
  assert.doesNotMatch(ascii, /del "运行日志\.txt"/, '不许再删运行日志（旧日志要能复盘）');
  assert.match(ascii, /--reuse-env/, '第一次调用要沿用环境里已有的批次');
  assert.match(ascii, /set "DSH_BATCH=!NEWBATCH!"/, '要把读回来的批次交下去');
});

test('驱动器循环.cmd：批次沿用同一个（内部重拉不产生新批次）', () => {
  const ascii = fs.readFileSync(path.join(ROOT, '_内部', '驱动器循环.cmd')).toString('latin1');
  assert.match(ascii, /--batch=%DSH_BATCH%/, '重拉时必须把同一个批次再交给 driver.js');
});

/* ============================================================================
 * E. --status-exit：给 cmd 用的机器可读判活
 * ==========================================================================*/

test('--status-exit：没有驱动器时退出码非 0（cmd 靠 if errorlevel 1 判）', () => {
  const base = mkBase();
  /* 沙箱里子进程的管道 stdio 会 EPERM（named pipe 被挡），所以这里直接测**契约本身**：
     exitCodeFor 把结论换算成退出码。退出码是这一条的全部要害 —— cmd 只看它，不看输出文本。
     输出格式（DRIVER=absent / DRIVER=alive）另外用静态断言盯着。 */
  const rp = require(path.join(ROOT, 'runtime-processes.js'));
  assert.equal(typeof rp.exitCodeFor, 'function', 'exitCodeFor 必须可离线测');
  assert.equal(rp.exitCodeFor({ running: false }, '--status-exit'), 1, '没在跑 -> 非 0');
  assert.equal(rp.exitCodeFor({ running: true }, '--status-exit'), 0, '在跑（alive && verified）-> 0');
  /* 别的模式仍按 ok 判：不要让这条新契约把 --status 的行为改掉 */
  assert.equal(rp.exitCodeFor({ ok: true }, '--status'), 0);
  assert.equal(rp.exitCodeFor({ ok: false }, '--status'), 1);
  /* 真跑一次：确认能起来、且退出码确实是没在跑那一档（沙箱不给 spawn 就只保留上面纯逻辑断言） */
  const r = spawnSync(process.execPath, [path.join(ROOT, 'runtime-processes.js'), '--status-exit', '--base', base], { stdio: 'ignore' });
  if (r.error) {
    assert.match(String(r.error.code || ''), /EPERM|EACCES|ENOENT/, '意外的 spawn 失败：' + r.error.message);
  } else {
    assert.notEqual(r.status, 0, '没有驱动器时必须是非 0 退出码');
  }
});

test('--status-exit 的 stdout 只有一行 DRIVER=alive|absent（机器可读）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'runtime-processes.js'), 'utf8');
  assert.match(src, /DRIVER=/, '那一行必须存在');
  assert.match(src, /'absent'/, '没在跑时写 absent');
  assert.match(src, /'alive'/, '在跑时写 alive');
  assert.match(src, /mode === '--status-exit' && r && r\.line/, '--status-exit 下只写那一行，不混 JSON');
});

test('--status-exit 的判据是 alive && verified，不是单看 PID 或 alive', () => {
  const src = fs.readFileSync(path.join(ROOT, 'runtime-processes.js'), 'utf8');
  assert.match(src, /mode === '--status-exit'/);
  assert.match(src, /const running = !!\(r\.alive && r\.verified\)/,
    '必须两个条件都成立才算"在跑"（PID 复用/身份不符时 verified=false）');
});

test('runtime-processes：失败原因里不许出现别的进程的完整命令行', () => {
  const rp = require(path.join(ROOT, 'runtime-processes.js'));
  const secret = '--token=SuperSecret1234 --user-data-dir=C:\\Users\\Someone\\private';
  rp.__setProcessHooksForTest({
    queryProcesses: () => ({
      ok: true,
      reason: '',
      list: [{ pid: 4242, name: 'node.exe', exe: process.execPath, cmdline: '"' + process.execPath + '" ' + secret, start: '1000' }],
    }),
    killPid: () => ({ ok: true, reason: '' }),
  });
  try {
    const base = mkBase();
    fs.writeFileSync(path.join(base, '驱动器锁.json'), JSON.stringify({
      v: 1, pid: 4242, start: '1000', exe: process.execPath,
      script: path.join(base, 'driver.js'), batch: 'b', token: 't',
    }), 'utf8');
    const r = rp.readVerifiedDriver(base, { driverScript: path.join(base, 'driver.js') });
    assert.equal(r.alive, false, '命令行里没有 driver.js 完整路径 → 身份不通过');
    assert.doesNotMatch(r.reason, /SuperSecret1234/, '失败原因绝不能把别人的命令行参数带出去：' + r.reason);
    assert.doesNotMatch(r.reason, /private/, '同上：不许泄漏别的进程路径：' + r.reason);
    assert.match(r.reason, /PID 4242/, '说清楚是哪个 PID 对不上就够了');
  } finally {
    rp.__resetProcessHooksForTest();
  }
});
