/* 学习通助手 · 新批次的启动引导（给 开始.cmd / 控制台 用）
 *
 * 两种启动入口（网页控制台点「开始」、直接双击 开始.cmd / 控制台.cmd 点 1）
 * 必须对"这一批"有**同一个定义**，否则界面说的"本轮"和驱动器记账用的批次
 * 是两码事。这个模块就是那一个定义，两边都调它，不各写一套。
 *
 * 它做三件事（顺序不能换）：
 *   1. 生成 / 沿用批次标识（有合法的 DSH_BATCH 就沿用，那是外套内部重拉）；
 *   2. 轮转旧运行日志（web-state.js 里那份已经过测试的实现，最多留 12 份），
 *      **不删**旧日志；轮转失败也要说出来，绝不默默把旧日志销毁；
 *   3. 写 本次运行.json（批次标识 = sessionId），界面靠它区分「本轮 / 上一轮」。
 *
 * 输出永远是**一行一行的 key=value**，不打印任何别的东西 ——
 * cmd 的 `for /f` 会把每一行都当成一个值，混进额外输出就会把批次读错。
 * 退出码：0 = 可以继续启动；非 0 = 批准备失败，调用方**不应该**继续（但这不代表
 * 驱动器不能跑，只是这一批没有身份记录）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const wstate = require('./web-state.js');
const checkpoint = require('./driver-checkpoint.js');

const KEEP = wstate.LOG_ARCHIVE_KEEP;   /* 12 份，和 web-state 的默认值同一个来源 */

/**
 * 纯逻辑：这一批用哪个批次标识？
 *   · 默认（o.reuseEnv 为真、比如 --reuse-env）：合法的 DSH_BATCH 就沿用
 *     —— 那是"外套内部重拉/控制台已经定好的这一批"，绝不生成新批次；
 *   · 默认之外：**永远生成新的**。
 *     开始.cmd 的 :startfresh 走这条：双击它 = 用户要开新的一轮。
 *     这条比"自己去猜外套在不在跑"可靠得多（猜错了就会把上一批的账背过来，
 *     同一章的题被重复填一遍 = 白花 API 钱）。
 */
function pickBatch(env, make, reuseEnv) {
  const gen = typeof make === 'function' ? make : checkpoint.newBatchId;
  if (reuseEnv !== true) return { batch: gen(), reused: false };
  const fromEnv = checkpoint.batchFromEnv(env || {});
  if (fromEnv) return { batch: fromEnv, reused: true };
  return { batch: gen(), reused: false };
}

/**
 * 准备一批：轮转日志 + 写 本次运行.json。
 * 返回 {ok, batch, reused, log, archive, rotated, rotateOk, rotateReason, wrote, writeError}
 * —— 永远不抛：这里任何一步失败都不该让"开始跑"这件事整个失败，
 *    但调用方必须能看见到底哪一步没成。
 */
function prepareBatch(opts) {
  const o = opts || {};
  const baseDir = o.baseDir || '.';
  const logPath = o.logPath || path.join(baseDir, '运行日志.txt');
  const runPath = o.runPath || path.join(baseDir, '本次运行.json');
  const logDir = o.logDir || path.join(baseDir, wstate.LOG_DIR_NAME);
  const keep = Number.isInteger(o.keep) && o.keep >= 0 ? o.keep : KEEP;
  const now = Number.isFinite(Number(o.nowMs)) ? Number(o.nowMs) : Date.now();

  const picked = pickBatch(o.env, o.makeBatchId, o.reuseEnv === true);
  const batch = picked.batch;

  const rot = wstate.rotateRunLog({
    logPath: logPath,
    dir: logDir,
    keep: keep,
    baseName: o.baseName || path.basename(logPath).replace(/\.txt$/i, ''),
    atMs: now,
  });

  const rec = wstate.makeRunRecord({
    log: path.basename(logPath),
    logArchive: rot.archive || '',
    sessionId: batch,
    startedAtMs: now,
  });
  const wr = wstate.writeRunRecord(runPath, rec);

  return {
    ok: true,
    batch: batch,
    reused: picked.reused,
    log: path.basename(logPath),
    runFile: runPath,
    archive: rot.archive || '',
    kept: rot.kept || 0,
    rotated: rot.action === 'archived',
    rotateOk: !!rot.ok,
    rotateReason: rot.reason || '',
    wrote: !!wr.ok,
    writeError: wr.ok ? '' : (wr.error || '未知'),
  };
}

/* ---------------- 命令行入口 ----------------
 * 输出（每行一条，顺序固定，方便 cmd 逐行读）：
 *   BATCH=<批次标识>
 *   REUSED=1|0
 *   ROTATE=<archived|skipped|failed>
 *   KEEP=<保留份数>
 *   RUNFILE=<本次运行.json 的完整路径>
 *   NOTE=<一句人话说明，可能为空>（只在有值得说的事情时出现）
 */
function formatResult(r) {
  const lines = [
    'BATCH=' + r.batch,
    'REUSED=' + (r.reused ? '1' : '0'),
    'ROTATE=' + (r.rotateOk ? (r.rotated ? 'archived' : 'skipped') : 'failed'),
    'KEEP=' + r.kept,
    'RUNFILE=' + r.runFile,
  ];
  if (r.rotated) lines.push('NOTE=旧的运行日志已归档到 日志\\' + path.basename(r.archive) + '（保留最近 ' + r.keep + ' 份）');
  else if (!r.rotateOk) lines.push('NOTE=旧日志没能归档：' + r.rotateReason + '（没有删任何日志）');
  else if (r.rotateReason) lines.push('NOTE=' + r.rotateReason);
  if (!r.wrote) lines.push('NOTE2=本次运行.json 没写成：' + r.writeError + '（不影响跑，界面会退回按时间判断）');
  return lines;
}

/* 给调用方（含测试）用的完整入口：prepareBatch + 打印 */
function cliMain(argv, deps) {
  const args = Array.isArray(argv) ? argv : [];
  const d = deps || {};
  const out = d.write || ((s) => process.stdout.write(s));
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    if (i < 0) return dflt;
    const v = args[i + 1];
    return (v === undefined || v.startsWith('--')) ? dflt : v;
  };
  const baseDir = flag('--base', process.cwd());
  const r = prepareBatch({
    baseDir: baseDir,
    logPath: flag('--log', path.join(baseDir, '运行日志.txt')),
    runPath: flag('--run', path.join(baseDir, '本次运行.json')),
    env: d.env || process.env,
    reuseEnv: d.reuseEnv === true || args.indexOf('--reuse-env') >= 0,
    makeBatchId: d.makeBatchId,
    nowMs: d.nowMs,
  });
  const lines = formatResult(r);
  out(lines.join('\n') + '\n');
  return { code: 0, result: r, lines: lines };
}

if (require.main === module) {
  let r;
  try {
    r = cliMain(process.argv.slice(2));
  } catch (e) {
    try { process.stdout.write('BATCH=\nNOTE=批次准备失败：' + ((e && e.message) || e) + '\n'); } catch (x) {}
    process.exit(1);
  }
  process.exit(r.code);
}

module.exports = {
  KEEP,
  pickBatch,
  prepareBatch,
  formatResult,
  cliMain,
};
