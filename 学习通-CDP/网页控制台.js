#!/usr/bin/env node
/* 学习通助手 · 网页控制台
 *
 * 一个只监听 127.0.0.1 的本地网页（Node 标准库，不装任何东西）。
 * 双击 网页控制台.cmd 打开；或者 node 网页控制台.js --port=8898
 *
 * 它管的事：
 *   * 一眼看到驱动器在不在跑、跑到哪一章、这一章的视频走到几分几秒
 *   * 改答题助手设置（模式 / 读题方式 / 自动填 / 测验停 / 每章上限 / 模型 / key）
 *   * 开关「伪心跳 60 倍速」
 *   * 实时看 运行日志.txt（3 秒自动刷新），警告行单独拎出来
 *   * 看本轮账目：本次运行-题目计数.txt / 本次运行-没做的题.txt
 *   * 开始 / 停止驱动器、解码乱码、测 key、环境自检
 *
 * ------------------------------------------------------------------
 * 设计上的四条硬规矩（都是踩过坑才立的）：
 *
 * 1. 写配置只走 答题助手.js 的 saveConfig —— 控制台绝不自己拼 JSON。
 *    理由跟 配置.js 一模一样：一份配置只能有一个写入口，否则迟早出现
 *    「界面显示 mode 1、驱动器读到 mode 0」。同理，本文件不 new 配置对象，
 *    只 loadConfig → 改字段 → saveConfig。
 *
 * 2. 保存之前先"严格读"一次原文件。loadConfig() 在 JSON 坏掉时会**静默返回默认值**，
 *    这时候要是接着 saveConfig，用户的 API key 就被一把抹掉了。
 *    所以写之前先 JSON.parse 验一遍，坏了就拒绝写、把错误显示出来。
 *
 * 3. 读日志要能扛住混合编码。运行日志.txt 里 driver.js 写的是 UTF-8，
 *    而外套（驱动器循环.cmd）在 chcp 936 下 >> 进去的行是 GBK 字节 ——
 *    同一个文件两种编码。按行判断：这一行当 UTF-8 读得通就用 UTF-8，
 *    读出一堆替换字符就退回 GBK 重解。别按整个文件猜。
 *
 * 4. 状态不是"有一个 status.json 可读"，得从好几处拼：
 *    运行中.pid（进程）+ 运行日志.txt 的修改时间（心跳）+ 日志尾部的锚点（章节/进度）。
 *    心跳这条最要紧：进程活着不等于在干活，卡住的时候日志是停的。
 * ------------------------------------------------------------------
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

/* 复用答题助手的读写法。这里 require 是安全的：
   答题助手.js 顶层只有常量和函数声明，没有副作用（配置.js 也是这么用的）。 */
const quiz = require('./答题助手.js');
/* 本地题库：控制台要能"粘贴一段题库码就能用"。
   码 = TIKU1: + gzip(只含键与答案的 JSON) 的 base64url —— 编解码都在 题库.js 里，纯函数。 */
const QBANK = require('./题库.js');
/* 图片指纹：题干里插图/公式图的"是不是同一张"（不看内容、只看像素）。
   表跟着题库码走 —— 对面机器对同一张图算出的 id 是一样的，所以拿码就能对上。 */
const IMGFP = require('./图片指纹.js');
const COURSE = require('./课程名.js');

/* 入口闸门（Host / Origin / token / Content-Type / 体积）——
   纯逻辑单独成文件，这样安全规则能离线测试，不用起真服务器。 */
const sec = require('./web-security.js');
/* 状态与日志的纯逻辑（日志正则契约 / 本次-上次 / 保存状态 / 日志轮转）。 */
const wstate = require('./web-state.js');

/* 进程与 Edge 的所有权判定由另一个模块提供（runtime-processes.js）。
   它可能还没到位 —— 那就**拒绝动手**并在界面上说清楚，绝不靠 PID 猜。 */
let PROC = null;
try { PROC = require('./runtime-processes.js'); } catch (e) { PROC = null; }

const BASE = __dirname;
const P = (...seg) => path.join(BASE, ...seg);

const F = {
  cfg: quiz.CFG_FILE,                     // 答题设置.json
  out: quiz.OUT_FILE,                     // 章节测验记录.txt
  fontTable: quiz.FONT_TABLE,             // _字体\对照表.json
  fontTtf: P('_字体', 'font-01-font-cxsecret.ttf'),
  pid: P('运行中.pid'),
  log: P('运行日志.txt'),
  todo: P('待办-未完成任务点.txt'),
  count: P('本次运行-题目计数.txt'),
  miss: P('本次运行-没做的题.txt'),
  courses: P('我的课程.txt'),
  lastCourse: P('_上次的课程.txt'),
  hbSwitch: P('_内部', '伪心跳开关.txt'),
  stopFlag: P('_内部', '停止标记.txt'),
  driverLoop: P('_内部', '驱动器循环.cmd'),
  decoder: P('解乱码.js'),
  cfgCli: P('配置.js'),
  run: P('本次运行.json'),                  // 这一批是什么时候开始的（区分本次/上次）
  logDir: P(wstate.LOG_DIR_NAME),           // 日志\ —— 旧运行日志归档在这里
};

/* 【页面版本自检】2026-10-12 立的：这一整天反复栽在"页面是旧的"上（改了代码、他那边还是老页面 ⇒
   看着像功能没做出来 ✗）。做法：页面里烙一个版本号（服务端渲染时填进去），
   每轮刷新状态跟服务端那份比，不一致就在顶上加一条红条让人按 Ctrl+F5。 */
const PAGE_VERSION = '2026-10-12.8';

const LOG_KEEP = wstate.LOG_ARCHIVE_KEEP;

const CDP_PORT = Number(process.env.CDP_PORT || 9222);

const argPort = process.argv.find((a) => a.startsWith('--port='));
const WANT_PORT = argPort ? Number(argPort.split('=')[1]) || 8898 : 8898;
const OPEN_BROWSER = process.argv.includes('--open');

const MODE_NAME = ['不做题（只放视频、翻节，测验一概不碰）', '记下题，不问 AI', '记下题 + 问 AI'];
const READ_MODE_NAME = {
  table: '只用解码表（快、免费；对方换字体就失效）',
  shot: '只用截图 + 看图模型（慢、要钱；不依赖字体）',
  auto: '自动（解码表有效就用表，失效就改用截图）',
};

/* ============================================================================
 * 一、读文件（编码要能扛）
 * ==========================================================================*/

function statSafe(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

function readBufTail(p, maxBytes) {
  const st = statSafe(p);
  if (!st || !st.isFile() || st.size === 0) return { buf: Buffer.alloc(0), st };
  const start = Math.max(0, st.size - maxBytes);
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { buf, st };
  } catch (e) {
    return { buf: Buffer.alloc(0), st };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 无所谓 */ } }
  }
}

/* 一行一行地判编码。实现在 web-state.js 里（那边能被离线测试喂虚构样本）。 */
const decodeLineSmart = wstate.decodeLineSmart;
const splitLines = wstate.splitLines;

/* 读文件尾部若干行。凭空读一个不存在的文件返回 []，不抛。 */
function tailLines(p, maxLines, maxBytes) {
  const { buf } = readBufTail(p, maxBytes || 512 * 1024);
  const lines = splitLines(buf);
  return maxLines && lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

/* 整个读一个小文件（配置、对照表这种），带 BOM 剥除。读不到返回 null。 */
function readTextFile(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    return null;
  }
}

/* 【规矩 2】保存前的严格读：JSON 坏掉就返回 null，让上层拒绝写。 */
function readConfigStrict() {
  const raw = readTextFile(F.cfg);
  if (raw === null) return null;              // 文件不在 —— 交给 loadConfig 给默认值
  if (!raw.trim()) return null;               // 空的：宁可拒绝写，也别覆盖成默认值
  try {
    const j = JSON.parse(raw);
    return (j && typeof j === 'object') ? j : null;
  } catch (e) {
    return null;
  }
}

/* ============================================================================
 * 二、进程与端口
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * 进程身份：一律问 runtime-processes.js，自己不猜
 *
 * 原来只认 PID —— `process.kill(n,0)` 说活着就当驱动器在跑，
 * 点「停止」就 `taskkill /f /pid n`。Windows 会回收 PID，于是"驱动器崩了留下
 * 一个陈旧的 运行中.pid"之后，那串数字可能已经属于别人的进程 ——
 * 判活会误报"已经在跑"，停止会**杀掉一个完全无关的进程**。
 *
 * runtime-processes.js 的契约：
 *   readVerifiedDriver(baseDir)  同步       -> {pid, alive, verified, reason}
 *   stopVerifiedDriver(baseDir)  async      -> {ok, pid, reason}
 *   recordOwnedEdge({baseDir,pid,profileDir,port})  async -> {ok, reason}
 *   stopOwnedEdge({baseDir,profileDir,port})        async -> {ok, count, reason}
 *
 * 注意 readVerifiedDriver 的字段是 {pid, alive, verified}，**不是** {active}。
 * 判"在跑"必须同时看 alive && verified —— 光 alive 就是旧行为。
 * `verified:false` 的意思是"这个 PID 的映像名/命令行对不上 driver.js"，
 * 那种情况要当成"没在跑"，并且把它给的理由原样显示出来。
 * -------------------------------------------------------------------------*/

const PROC_MISSING_REASON = 'runtime-processes.js 还没就位 —— 无法核对进程身份，所以不猜 PID、也不动手。';

function procReady() { return !!(PROC && typeof PROC.readVerifiedDriver === 'function'); }

function normalizeDrv(r) {
  const o = r && typeof r === 'object' ? r : {};
  const pid = Number.isInteger(Number(o.pid)) && Number(o.pid) > 0 ? Number(o.pid) : null;
  const alive = !!o.alive;
  const verified = !!o.verified;
  return {
    pid,
    alive,
    verified,
    /* "在跑"= 活着 **且** 核对过身份。缺一不可。 */
    running: alive && verified,
    reason: String(o.reason === undefined || o.reason === null ? '' : o.reason),
  };
}

function readVerifiedDriverSync() {
  if (!procReady()) {
    return normalizeDrv({ pid: null, alive: false, verified: false, reason: PROC_MISSING_REASON });
  }
  try {
    return normalizeDrv(PROC.readVerifiedDriver(BASE));
  } catch (e) {
    return normalizeDrv({ pid: null, alive: false, verified: false, reason: '读进程身份出错：' + ((e && e.message) || e) });
  }
}

/* 同一个函数可能被写成 async（契约里没写死同步）—— 两种都兼容。 */
function readVerifiedDriver() {
  if (!procReady()) return Promise.resolve(readVerifiedDriverSync());
  try {
    return Promise.resolve(normalizeDrv(PROC.readVerifiedDriver(BASE)));
  } catch (e) {
    return Promise.resolve(normalizeDrv({ pid: null, alive: false, verified: false, reason: '读进程身份出错：' + ((e && e.message) || e) }));
  }
}

async function stopDriverVerified() {
  if (!PROC || typeof PROC.stopVerifiedDriver !== 'function') {
    return { ok: false, pid: null, reason: PROC_MISSING_REASON };
  }
  try {
    const r = await PROC.stopVerifiedDriver(BASE);
    const o = r && typeof r === 'object' ? r : {};
    return {
      ok: !!o.ok,
      pid: Number.isInteger(Number(o.pid)) && Number(o.pid) > 0 ? Number(o.pid) : null,
      reason: String(o.reason === undefined || o.reason === null ? '' : o.reason),
    };
  } catch (e) {
    return { ok: false, pid: null, reason: '停驱动器出错：' + ((e && e.message) || e) };
  }
}

/* 助手自己开的 Edge：独立 user-data-dir + 调试端口。
   原来这里没有这个概念 —— 开之前 `taskkill /f /im msedge.exe` 把**所有** Edge 全杀，
   关的时候也一样。用户正开着的、有没保存内容的窗口一并没了。 */
function edgeProfileDir() {
  return path.join(process.env.LOCALAPPDATA || BASE, 'Microsoft', 'Edge', 'User');
}

async function recordOwnedEdge(pid) {
  if (!PROC || typeof PROC.recordOwnedEdge !== 'function') {
    return { ok: false, reason: 'runtime-processes.js 还没就位 —— 这次启动的浏览器不会被登记，之后也没法只关它。' };
  }
  try {
    const r = await PROC.recordOwnedEdge({ baseDir: BASE, pid: Number(pid) || null, profileDir: edgeProfileDir(), port: CDP_PORT });
    const o = r && typeof r === 'object' ? r : {};
    return { ok: !!o.ok, reason: String(o.reason || '') };
  } catch (e) {
    return { ok: false, reason: '登记浏览器所有权出错：' + ((e && e.message) || e) };
  }
}

async function stopOwnedEdge() {
  if (!PROC || typeof PROC.stopOwnedEdge !== 'function') {
    return { ok: false, count: 0, reason: 'runtime-processes.js 还没就位 —— 没有所有权凭据，不会去杀 Edge（宁可不动，也不误杀你自己的窗口）。' };
  }
  try {
    const r = await PROC.stopOwnedEdge({ baseDir: BASE, profileDir: edgeProfileDir(), port: CDP_PORT });
    const o = r && typeof r === 'object' ? r : {};
    return { ok: !!o.ok, count: Number.isFinite(Number(o.count)) ? Number(o.count) : 0, reason: String(o.reason || '') };
  } catch (e) {
    return { ok: false, count: 0, reason: '关浏览器出错：' + ((e && e.message) || e) };
  }
}

/* 端口探测是异步的，所以缓存在内存里由后台定时器刷 —— /api/state 永远不阻塞。 */
const edge = { up: false, browser: '', checkedAt: 0, error: '' };

function probeEdge() {
  const req = http.get(
    { host: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 1500 },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { edge.browser = JSON.parse(body).Browser || ''; } catch (e) { edge.browser = ''; }
        edge.up = res.statusCode === 200;
        edge.error = '';
        edge.checkedAt = Date.now();
      });
    });
  req.on('timeout', () => { req.destroy(new Error('探测超时')); });
  req.on('error', (e) => {
    edge.up = false;
    edge.browser = '';
    edge.error = e && e.message ? e.message : '连不上';
    edge.checkedAt = Date.now();
  });
}

/* 外套（驱动器循环.cmd）在两个 driver.js 之间那 15 秒里是没有 运行中.pid 的，
   要靠窗口标题认它还在跑 —— 跟 开始.cmd 里 `tasklist /v | find "学习通驱动器"` 一个意思。 */
function wrapperRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/v', '/fi', 'imagename eq cmd.exe', '/fo', 'csv', '/nh'],
      { encoding: 'buffer', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(false);
        let t = '';
        try { t = new TextDecoder('gb18030').decode(stdout || Buffer.alloc(0)); } catch (e) { t = ''; }
        resolve(t.indexOf('学习通驱动器') >= 0);
      });
  });
}

/* ============================================================================
 * 三、状态采集
 * ==========================================================================*/

/* 日志正则表与解析都在 web-state.js 里 —— 那边有"跟 driver.js 的日志格式对表"的
   离线测试（原来 RE.quiz 的格式在 driver.js 里根本不存在，
   而 playDone 只认 \d+:\d\d，把实测会出现的「--:--」整条丢掉，没人发现）。
   这里只把解析函数引进来用。 */
const analyzeLog = wstate.analyzeLog;
const describeAct = wstate.describeAct;
const draftTag = wstate.draftTag;

function quizAccounting() {
  const lines = tailLines(F.count, 400, 256 * 1024);
  const rows = [];
  let startedAt = '', endedAt = '', totals = { found: null, filled: null, missed: null }, emptyRun = false, header = '';
  for (const l of lines) {
    let x;
    if ((x = l.match(/^启动时间：\s*(.+)$/))) { startedAt = x[1].trim(); continue; }
    if ((x = l.match(/^总账（(.+?)\s*结束）/))) { endedAt = x[1].trim(); continue; }
    if ((x = l.match(/^\s*遇到题目\s*:\s*(\d+)\s*道/))) { totals.found = Number(x[1]); continue; }
    if ((x = l.match(/^\s*填上了\s*:\s*(\d+)\s*道/))) { totals.filled = Number(x[1]); continue; }
    if ((x = l.match(/^\s*没做成\s*:\s*(\d+)\s*道/))) { totals.missed = Number(x[1]); continue; }
    if (/这一趟没碰到题/.test(l)) { emptyRun = true; continue; }
    if ((x = l.match(/^(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\s{2,}(.+?)\s{2,}(\d+)\s+(\d+)\s+(\d+)\s*$/))) {
      rows.push({ at: x[1], chapter: x[2].trim(), found: Number(x[3]), filled: Number(x[4]), missed: Number(x[5]) });
      continue;
    }
    if (/^答题助手：/.test(l)) header = l.trim();
  }
  const missLines = tailLines(F.miss, 200, 128 * 1024)
    .filter((l) => l.indexOf(']') >= 0 && l.indexOf('跳过') < 0 && l.trim())
    .slice(-60);
  return {
    file: F.count, startedAt, endedAt, totals, emptyRun, header,
    rows: rows.slice(-40), missFile: F.miss, miss: missLines,
  };
}

function fontStatus() {
  const raw = readTextFile(F.fontTable);
  if (raw === null) return { ok: false, missing: true, count: 0, matches: null, note: '缺失 —— 遇到混淆题目只能跳过（见 _字体\\对照表说明.txt）' };
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { return { ok: false, missing: false, count: 0, matches: null, note: '对照表读不出来（JSON 坏了）' }; }
  const count = Object.keys((j && j.map) || {}).length;
  let matches = null;
  if (j && j.sha256 && fs.existsSync(F.fontTtf)) {
    try {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(F.fontTtf)).digest('hex');
      matches = sha === j.sha256;
    } catch (e) { matches = null; }
  }
  return {
    ok: true, missing: false, count,
    generated: (j && j.generated) || '', method: (j && j.method) || '',
    matches,
    note: matches === false ? '磁盘上那份字体跟表里记的指纹对不上 —— 对方换字体了，这张表不能再用' : '',
  };
}

function hbSpeed() {
  const raw = readTextFile(F.hbSwitch);
  if (!raw) return 0;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 1 ? n : 0;
}

function coursesInfo() {
  const lines = tailLines(F.courses, 40, 64 * 1024);
  const urls = lines.map((l) => l.trim()).filter((l) => l && l[0] !== '#');
  const lastId = (readTextFile(F.lastCourse) || '').replace(/[^0-9]/g, '');
  return { urls, lastCourseId: lastId };
}

function heartbeat() {
  const st = statSafe(F.log);
  if (!st) return { exists: false, ageSec: null, size: 0, mtime: '' };
  return {
    exists: true,
    ageSec: Math.round((Date.now() - st.mtimeMs) / 1000),
    size: st.size,
    mtime: new Date(st.mtimeMs).toLocaleString('zh-CN'),
  };
}

/* 这一批是从什么时候开始的？—— 界面用它区分「本轮」和「上一轮」。
   文件不在（比如还没从网页控制台启动过）就返回 null，此时按时间兜底判断。 */
function readRunRecord() {
  const r = wstate.readRunRecord(F.run);
  return r || null;
}

/* ---------------------------------------------------------------------------
 * 题库：状态 + 码
 * -------------------------------------------------------------------------*/

const BANK_PATH = () => path.join(BASE, QBANK.BANK_FILE);

/* 读本地库（读坏了当空库 —— 不当成"有一堆好数据"，也不报错吓人）。 */
function readBank() {
  try {
    const p = BANK_PATH();
    if (!fs.existsSync(p)) return { exists: false, bank: QBANK.parseBank(''), path: p };
    return { exists: true, bank: QBANK.parseBank(fs.readFileSync(p, 'utf8')), path: p };
  } catch (e) {
    return { exists: false, bank: QBANK.parseBank(''), path: BANK_PATH(), error: (e && e.message) || String(e) };
  }
}

/* 库规模分档：能用的（页面来源 / 官方答案）、抄录来源的、没答案的、带图的、有冲突的。 */
function bankSummary(bank) {
  const ks = Object.keys((bank && bank.entries) || {});
  const dom = ks.filter((k) => (bank.entries[k].answers || []).some((a) => a.official || (a.srcs || []).some((s) => /^self:/.test(s))));
  return {
    entries: ks.length,
    usable: dom.length,
    transcribed: ks.length - dom.length,
    noAnswer: ks.filter((k) => !bank.entries[k].answer).length,
    official: ks.filter((k) => bank.entries[k].official).length,
    withImage: ks.filter((k) => bank.entries[k].hasImage).length,
    conflicts: ks.filter((k) => bank.entries[k].conflict).length,
    aliasKeys: ks.filter((k) => bank.entries[k].fpAlt).length,
    orderKeys: ks.filter((k) => bank.entries[k].fpOrder).length,
    /* 【各标签各有多少条】给"按标签导出"的勾选框显示用。
       直接复用题库.js 里那份判据（TAGS），不在这里另写一套 —— 免得两边判得不一样。 */
    tagCounts: (() => {
      const out = {};
      try {
        for (const t of QBANK.listTags()) out[t.id] = QBANK.exportBankByTags(bank, { tags: [t.id] }).count;
      } catch (e) { /* 标签算不出来不影响其它字段 */ }
      return out;
    })()
  };
}

function apiBank() {
  const r = readBank();
  const sum = bankSummary(r.bank);
  let codeLen = 0;
  try { codeLen = QBANK.encodeCode(r.bank, {}).length; } catch (e) { codeLen = 0; }
  /* 【库清单】主库 + 子库（题库\ 目录里一个文件一个库），带"启用了没有" */
  let libs = [];
  try {
    const raw = QBANK.listBanks({ dir: BASE, bankFile: BANK_PATH() });
    const en = (Array.isArray(readCfg().bankEnabled) && readCfg().bankEnabled.length) ? readCfg().bankEnabled : null;
    libs = raw.map((b) => ({
      name: b.name, file: b.file, entries: b.entries, main: !!b.main,
      size: b.size, enabled: en ? (en.indexOf(b.name) >= 0) : true
    }));
  } catch (e) { libs = []; }
  return {
    ok: true,
    exists: r.exists,
    path: r.path,
    builtAt: String((r.bank && r.bank.builtAt) || ''),
    stats: sum,
    /* 按标签导出用：标签表 + 每个标签多少条（一次读库就带出来了） */
    tags: (() => { try { return QBANK.listTags(); } catch (e) { return []; } })(),
    tagCounts: sum.tagCounts || {},
    codeLen: codeLen,
    libs: libs,
    error: r.error || ''
  };
}

/* 读配置（读坏了给默认值 —— 这里只是用来显示"哪个库启用了"） */
function readCfg() {
  try { return quiz.loadConfig() || {}; } catch (e) { return {}; }
}

/* 找一个库（'主库' / '题库.json' / 子库名 都认）。
   找不到时**不报错**：把它当成"新建子库"—— 用户就是想导进一个新库。
   名字里只允许纯文件名（把路径分隔符等危险字符去掉），免得写到 题库\ 目录外面去。 */
function libOf(nameOrFile) {
  const want = String(nameOrFile || '').trim();
  try {
    const b = QBANK.findBank(want, { dir: BASE, bankFile: BANK_PATH() });
    if (b && b.path && fs.existsSync(b.path)) return b;
    if (!want) return (b && b.path) ? b : null;                    /* 不传 = 主库 */
    const safe = want.replace(/\.json$/i, '').replace(/[\\\/:*?"<>|]/g, '').trim().slice(0, 60);
    if (!safe) return null;
    return {
      name: safe, file: path.join(QBANK.SUB_DIR, safe + '.json'),
      path: path.join(BASE, QBANK.SUB_DIR, safe + '.json'),
      main: false, exists: false, entries: 0, size: 0
    };
  } catch (e) { return null; }
}

/* 读一个指定库（用来导出成码 / 去重复） */
function readBankAt(p) {
  try {
    if (!fs.existsSync(p)) return QBANK.parseBank('');
    return QBANK.parseBank(fs.readFileSync(p, 'utf8'));
  } catch (e) { return QBANK.parseBank(''); }
}

/* 把一段题库码并进本地库（**合并**，不是替换）。冲突两份都留着，跟命令行同一个入口。 */
function bankImportCode(code, target) {
  const d = QBANK.decodeCode(code);
  if (!d.ok) return { ok: false, error: d.error };
  if (!d.entries) return { ok: false, error: '这段码里一条可用的条目都没有' };
  /* 【导入到哪个库】不传就是主库；传子库名（或文件名）就导进那个子库。
     子库文件不存在时会自动创建（目录也是）—— 所以"新建一个子库"= 直接写它的名字。 */
  const lib = libOf(target);
  if (!lib) return { ok: false, error: '找不到目标库：' + (target || '主库') };
  const exists = fs.existsSync(lib.path);
  const r = { exists: exists, bank: readBankAt(lib.path) };
  if (exists) QBANK.backupBank(lib.path);             /* 动手之前先留一份 .bak */
  const m = QBANK.mergeBank(r.bank, d.bank, { from: '题库码' });
  try {
    fs.mkdirSync(path.dirname(lib.path), { recursive: true });
    fs.writeFileSync(lib.path, QBANK.serializeBank(m.bank), 'utf8');
  } catch (e) {
    return { ok: false, error: '合并好了但写不进 ' + lib.file + '：' + ((e && e.message) || e) };
  }
  const sum = bankSummary(m.bank);
  /* 【图片指纹表也要并进来】码里带 images 段时，按 id 取并集写进 图片对照表.json。
     写不进去不算致命（题库已经进去了），但要如实说 —— 不然对方会以为图片也带上了。 */
  let imgRep = null;
  if (d.images && Object.keys(d.images.ids || {}).length) {
    const cur = IMGFP.loadTable(BASE);
    const im = IMGFP.mergeTable(cur, d.images, {});
    const saved = IMGFP.saveTable(im.table, BASE);
    imgRep = { added: im.report.added, same: im.report.same, urlAdded: im.report.urlAdded, urlConflict: im.report.urlConflict, saved: !!saved };
  }
  return {
    ok: true, lib: lib.name, file: lib.file, read: d.entries, bad: d.bad, noAns: d.noAns,
    added: m.report.added, merged: m.report.merged, conflicted: m.report.conflicted,
    sameSource: m.report.sameSource || 0,
    images: imgRep, stats: sum, path: lib.path
  };
}

/* 把某个库导出成码（默认主库；给别的机器用；脱敏：不带题干/选项全文/课程/时间）。 */
function bankMakeCode(libName) {
  const lib = libOf(libName);
  if (!lib) return { ok: false, error: '找不到这个库：' + (libName || '主库') };
  const bank = readBankAt(lib.path);
  const sum = bankSummary(bank);
  if (!sum.usable) return { ok: false, error: (lib.name || '这个库') + ' 还没有"能命中页面"的条目 —— 先建库/导入再导出' };
  const code = QBANK.encodeCode(bank, { images: IMGFP.loadTable(BASE) });
  const imgN = Object.keys(IMGFP.loadTable(BASE).ids || {}).length;
  return { ok: true, lib: lib.name, code: code, codeLen: code.length, stats: sum, imageIds: imgN };
}

/* 【一键去重复】同一道题因为"题号不同/选项顺序不同"被记成两条 → 并成一条（可指定哪个库）。 */
function bankDedupe(target) {
  const lib = libOf(target);
  if (!lib) return { ok: false, error: '找不到这个库：' + (target || '主库') };
  if (!fs.existsSync(lib.path)) return { ok: false, error: '这个库还没有文件：' + lib.file };
  const bank = readBankAt(lib.path);
  const before = Object.keys(bank.entries || {}).length;
  const d = QBANK.dedupeBank(bank, {});
  const after = Object.keys(d.bank.entries || {}).length;
  if (d.report.merged) {
    QBANK.backupBank(lib.path);                     /* 动手之前先留一份 .bak */
    try { fs.writeFileSync(lib.path, QBANK.serializeBank(d.bank), 'utf8'); }
    catch (e) { return { ok: false, error: '并好了但写不进 ' + lib.file + '：' + ((e && e.message) || e) }; }
  }
  return { ok: true, lib: lib.name, before: before, after: after, report: d.report, stats: bankSummary(d.bank) };
}

/* 【去杂】只删"能证明是垃圾"的：测试数据 / 空壳（没答案也没选项）/ 认不出（选项全空且没图）。
   体检时差点误删 30 条"判断题答案是 B"的正常条目（选项就是 A.对 B.错）——所以规矩收得很紧。 */
function bankClean(target) {
  const lib = libOf(target);
  if (!lib) return { ok: false, error: '找不到这个库：' + (target || '主库') };
  if (!fs.existsSync(lib.path)) return { ok: false, error: '这个库还没有文件：' + lib.file };
  const bank = readBankAt(lib.path);
  const before = Object.keys(bank.entries || {}).length;
  const c = QBANK.cleanBank(bank, {});
  const after = Object.keys(c.bank.entries || {}).length;
  const removed = before - after;
  if (removed) {
    QBANK.backupBank(lib.path);                        /* 动手之前先留一份 .bak */
    try { fs.writeFileSync(lib.path, QBANK.serializeBank(c.bank), 'utf8'); }
    catch (e) { return { ok: false, error: '清好了但写不进 ' + lib.file + '：' + ((e && e.message) || e) }; }
  }
  return {
    ok: true, lib: lib.name, before: before, after: after, removed: removed,
    r1: c.report.r1.length, r2: c.report.r2.length, r3: c.report.r3.length,
    stats: bankSummary(c.bank)
  };
}

/* 【按标签导出】tags 里放标签 id（可多选；'all' = 全部标签）；asCode=true 时**同时**给出题库码
   （法师要的：按标签导出来的应该是"可写进别的库的码"，而不是只有那份人看的报告）。
   两样产物各归各位：
     · code → 页面「导出的题库码」框（可复制、可发给别人导入）
     · text → 页面「导出文本」区（人看的）
     · 文件照样写（csv 用 Excel 开、txt 直接看）
   标签判据全在 题库.js 的 TAGS 里 —— 这里只负责筛、编码、写文件、回话。 */
function bankExportByTags(target, tags, asCode) {
  const lib = libOf(target);
  if (!lib) return { ok: false, error: '找不到这个库：' + (target || '主库') };
  if (!fs.existsSync(lib.path)) return { ok: false, error: '这个库还没有文件：' + lib.file };
  const want = (Array.isArray(tags) && tags.length) ? tags : ['conflict'];
  const bank = readBankAt(lib.path);
  const ex = QBANK.exportBankByTags(bank, { tags: want });
  const now = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const stamp = now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '-' + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds());
  const tagInName = (ex.tags || []).join('+') || 'export';
  const outDir = path.join(BASE, '_导出', '题库导出-' + tagInName + '-' + stamp);
  let code = '', codeLen = 0, picked = 0, pickedNoAns = 0;
  if (asCode) {
    const sub = QBANK.bankFromTags(bank, { tags: want });
    /* withUnverified：按标签导就是要"选中的都带上"（默认只带可靠条目，会把单来源的丢掉） */
    code = QBANK.encodeCode(sub.bank, { images: IMGFP.loadTable(BASE), withUnverified: true });
    codeLen = code.length;
    picked = sub.count;
    pickedNoAns = Object.keys(sub.bank.entries).filter((k) => !sub.bank.entries[k].answer).length;
  }
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '题库导出.csv'), ex.csv, 'utf8');
    fs.writeFileSync(path.join(outDir, '题库导出.txt'), ex.text, 'utf8');
    if (code) fs.writeFileSync(path.join(outDir, '题库导出-题库码.txt'), code + '\r\n', 'utf8');
  } catch (e) {
    return { ok: false, error: '导出失败：' + ((e && e.message) || e) };
  }
  return { ok: true, lib: lib.name, count: ex.count, dir: outDir,
           dirName: path.basename(outDir),      /* 给页面显示用 —— 页面里**一个反斜杠都不要写** */
           text: ex.text, csv: ex.csv,          /* 页面上直接显示这份文本（也能一键复制） */
           code: code, codeLen: codeLen, picked: picked, pickedNoAns: pickedNoAns,
           byTag: ex.byTag, tags: ex.tags, badTags: ex.badTags,
           tagsName: (ex.tags || []).map((id) => QBANK.TAG_NAME[id] || id).join('、'),
           csvPath: path.join(outDir, '题库导出.csv'), txtPath: path.join(outDir, '题库导出.txt') };
}

/* 【导出冲突答案】同一道题、不同答案的那些（= 按标签导出，标签就一个：冲突）。
   只读不写库 —— 看一眼就知道该不该信哪条。 */
function bankExportConflicts(target) {
  const r = bankExportByTags(target, ['conflict']);
  if (!r.ok) return r;
  return r;   /* 文件名与字段名都统一成"题库导出"，这里不改行为，只是少写一套重复代码 */
}

/* 【启用哪些库】写进配置的 bankEnabled（空数组 = 全部启用） */
function bankSetEnabled(names) {
  const arr = (Array.isArray(names) ? names : []).map((s) => String(s || '').trim()).filter(Boolean);
  const c = readCfg();
  const all = (function () {
    try { return QBANK.listBanks({ dir: BASE, bankFile: BANK_PATH() }).map((b) => b.name); } catch (e) { return []; }
  })();
  /* 全都勾上 = 等于"没限制"，存空数组更省事（以后新增子库自动启用） */
  const patch = (arr.length >= all.length) ? { bankEnabled: [] } : { bankEnabled: arr };
  return saveConfigPatch(patch);
}

async function apiState() {
  /* 进程身份走 runtime-processes.js 的 readVerifiedDriver(BASE)：
     "在跑"= 活着 **且** 核对过身份（映像名 + 命令行）。 */
  const drv = await readVerifiedDriver();
  const hb = heartbeat();
  const logLines = tailLines(F.log, 260, 320 * 1024);
  const ana = analyzeLog(logLines);
  const run = readRunRecord();
  let cfg = {};
  try { cfg = quiz.loadConfig(); } catch (e) { cfg = { ...quiz.DEFAULT_CFG }; }

  /* 心跳判活：进程活着 + 日志还在写。两个都看，缺一不可 ——
     进程活着但日志 5 分钟没动，那就是卡住了，这种情况必须让眼睛能看见。
     注意这里用的是 drv.running（已核对身份），不是裸 alive。 */
  let live = 'idle';
  if (drv.running) live = (hb.ageSec !== null && hb.ageSec <= 60) ? 'running' : 'stalled';
  else if (hb.ageSec !== null && hb.ageSec <= 25) live = 'wrapping';   // 外套拉起之间的空档

  const envKey = process.env.DEEPSEEK_API_KEY || '';
  const effKey = cfg.apiKey || envKey;

  /* 【这些数字是"现在"的，还是"上一轮"的？】
     判据是**批次**，不是"进程在不在跑"：
       开始新批次时写了 本次运行.json（记下开始时间和日志名），
       日志最后写入时间早于批次开始 → 那是上一轮留下的。
     老判据是"进程没在跑 且 日志 25 秒没动"，空日志（刚启动、一个字节都还没写）
     正好满足，于是界面把一片空白标成「（上轮）」。
     现在空日志就是空日志：不标上轮、也不显示上一轮的章节。 */
  const logStat = statSafe(F.log);
  const view = wstate.deriveLogView({
    exists: !!logStat,
    hasContent: !!(logStat && logStat.size > 0),
    logMtimeMs: logStat ? logStat.mtimeMs : null,
    logName: path.basename(F.log),
    run,
  });
  /* 有实质内容、且明确属于上一轮 → act 标 stale。
     本轮有内容 → 不标（正在跑，或者刚跑完但还没换批次）。
     完全没有内容 → 不标。 */
  const actStale = !view.empty && view.stale;

  return {
    now: new Date().toLocaleString('zh-CN'),
    console: { port: SERVER_PORT, url: 'http://127.0.0.1:' + SERVER_PORT + '/', cdpPort: CDP_PORT },
    live,
    driver: drv,
  pageVersion: PAGE_VERSION,
    heartbeat: hb,
    edge: { up: edge.up, browser: edge.browser, error: edge.error, port: CDP_PORT },
    act: ana,
    actStale,
    /* 「现在在干什么」拼成一句给界面用（含测验题目数与草稿保存状态）。
       刻意不在这里说"平台已完成" —— 草稿是不提交的。 */
    actText: describeAct(ana),
    draftTag: draftTag(ana.draft),
    log: {
      path: F.log,
      exists: view.exists,
      empty: view.empty,
      stale: view.stale,
      label: view.label,
      runStartedAt: run ? run.startedAt : '',
      runKnown: !!run,
      archive: run ? (run.logArchive || '') : '',
      archiveName: run && run.logArchive ? path.basename(run.logArchive) : '',
      dir: F.logDir,
      archiveKeep: LOG_KEEP,
    },
    cfg: {
      mode: Number(cfg.mode) || 0,
      modeName: MODE_NAME[Number(cfg.mode) || 0],
      readMode: cfg.readMode,
      readModeName: READ_MODE_NAME[cfg.readMode] || cfg.readMode,
      autoFill: !!cfg.autoFill,
      stopAtQuiz: !!cfg.stopAtQuiz,
      useAI: (cfg.useAI !== false),
      useBank: (cfg.useBank !== false),
      bankEnabled: Array.isArray(cfg.bankEnabled) ? cfg.bankEnabled.slice() : [],
      bankEnabledName: (Array.isArray(cfg.bankEnabled) && cfg.bankEnabled.length) ? cfg.bankEnabled.join(' / ') : '全部',
    /* 按标签导出要用的标签表（id + 中文名）；各标签条数在 bankSummary.tagCounts 里 */
    bankTags: (() => { try { return QBANK.listTags(); } catch (e) { return []; } })(),
      maxPerChapter: cfg.maxPerChapter,
      model: cfg.model,
      visionModel: cfg.visionModel,
      maxShots: cfg.maxShots,
      keyMask: maskKey(effKey),
      keyFrom: cfg.apiKey ? '配置文件' : (envKey ? '环境变量 DEEPSEEK_API_KEY' : '没配'),
      apiUrl: quiz.apiUrlOf(cfg),
      apiUrlShown: quiz.maskApiUrl(quiz.apiUrlOf(cfg)),
      apiUrlIsDefault: quiz.apiUrlOf(cfg) === quiz.API_URL,
      hasKey: !!effKey,
      migrated: (quiz.modelMigrationNote && quiz.modelMigrationNote()) || '',
      cfgFile: F.cfg,
    },
    hb: { speed: hbSpeed() },
    font: fontStatus(),
    courses: coursesInfo(),
    acc: quizAccounting(),
    job: publicJob(),
    logFile: { path: F.log, exists: hb.exists },
    proc: { ready: procReady(), note: procReady() ? '' : PROC_MISSING_REASON },
    modeNames: MODE_NAME,
    readModeNames: READ_MODE_NAME,
  };
}

/* ============================================================================
 * 四、写：配置 / 动作
 * ==========================================================================*/

function maskKey(k) {
  if (!k) return '(没配)';
  const s = String(k);
  if (s.length <= 12) return s.slice(0, 3) + '…（' + s.length + ' 位）';
  return s.slice(0, 5) + '…' + s.slice(-4) + '（' + s.length + ' 位）';
}

function saveConfigPatch(patch) {
  const strict = readConfigStrict();
  if (strict === null && fs.existsSync(F.cfg)) {
    return { ok: false, error: '答题设置.json 现在读不出来（JSON 坏了 / 是空的）。为了不把里面的 API key 一起写没，这次不改。请先手工看一眼那个文件。' };
  }
  let cfg;
  try { cfg = quiz.loadConfig(); } catch (e) { cfg = { ...quiz.DEFAULT_CFG }; }

  const changed = [];
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

  if (patch.mode !== undefined && patch.mode !== null && patch.mode !== '') {
    const n = Number(patch.mode);
    if ([0, 1, 2].includes(n)) { cfg.mode = n; changed.push('模式=' + n); }
  }
  if (patch.readMode !== undefined && patch.readMode !== null && patch.readMode !== '') {
    if (['table', 'shot', 'auto'].includes(patch.readMode)) { cfg.readMode = patch.readMode; changed.push('读题方式=' + patch.readMode); }
  }
  if (patch.autoFill !== undefined && patch.autoFill !== null) { cfg.autoFill = !!patch.autoFill; changed.push('自动填=' + (cfg.autoFill ? '开' : '关')); }
  if (patch.stopAtQuiz !== undefined && patch.stopAtQuiz !== null) { cfg.stopAtQuiz = !!patch.stopAtQuiz; changed.push('测验停=' + (cfg.stopAtQuiz ? '开' : '关')); }
  if (patch.bankEnabled !== undefined && patch.bankEnabled !== null) {
    if (!Array.isArray(patch.bankEnabled)) return { ok: false, error: 'bankEnabled 要是数组（库名列表；空数组 = 全部启用）' };
    cfg.bankEnabled = patch.bankEnabled.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50);
    changed.push(cfg.bankEnabled.length ? ('启用库=' + cfg.bankEnabled.join('/')) : '启用库=全部');
  }
  if (patch.maxPerChapter !== undefined && patch.maxPerChapter !== null && patch.maxPerChapter !== '') {
    const n = Number(patch.maxPerChapter);
    if (Number.isFinite(n) && n >= 1) { cfg.maxPerChapter = Math.floor(n); changed.push('每章上限=' + cfg.maxPerChapter); }
  }
  /* 【两条腿：题库 / AI】可以随便组合（2026-10-12）：
     只开题库 = 库里没有就留着不填（一分钱不花）；只开 AI = 不碰题库、一律重新问。 */
  if (patch.useAI !== undefined && patch.useAI !== null) { cfg.useAI = !!patch.useAI; changed.push('AI模式=' + (cfg.useAI ? '开' : '关')); }
  if (patch.useBank !== undefined && patch.useBank !== null) { cfg.useBank = !!patch.useBank; changed.push('题库模式=' + (cfg.useBank ? '开' : '关')); }
  if (patch.model !== undefined && patch.model !== null && String(patch.model).trim()) { cfg.model = String(patch.model).trim(); changed.push('模型=' + cfg.model); }
  if (patch.visionModel !== undefined && patch.visionModel !== null && String(patch.visionModel).trim()) { cfg.visionModel = String(patch.visionModel).trim(); changed.push('看图模型=' + cfg.visionModel); }
  if (patch.maxShots !== undefined && patch.maxShots !== null && patch.maxShots !== '') {
    const n = Number(patch.maxShots);
    if (Number.isFinite(n) && n >= 1) { cfg.maxShots = Math.floor(n); changed.push('最多截几张=' + cfg.maxShots); }
  }
  /* key 单独处理：空字符串 = 不改（不是"清空"）。要清空得显式 deleteKey。 */
  if (patch.deleteKey) { cfg.apiKey = ''; changed.push('API key 已清除'); }
  else if (patch.apiKey !== undefined && patch.apiKey !== null && String(patch.apiKey).trim()) {
    cfg.apiKey = String(patch.apiKey).trim();
    changed.push('API key 已更新（' + maskKey(cfg.apiKey) + '）');
  }
  /* 【网关地址可自定义，默认 DeepSeek】只认 http(s)，其余一律拒绝（别让人写错还把 key 发到别处）。
     传空字符串 = 恢复默认。 */
  if (patch.apiUrl !== undefined && patch.apiUrl !== null) {
    const raw = String(patch.apiUrl).trim();
    if (!raw) { cfg.apiUrl = quiz.API_URL; changed.push('网关地址=默认（' + quiz.maskApiUrl(quiz.API_URL) + '）'); }
    else if (!/^https?:\/\//i.test(raw)) { return { ok: false, error: '网关地址必须以 http:// 或 https:// 开头（你填的是：' + raw.slice(0, 60) + '）' }; }
    else { cfg.apiUrl = raw; changed.push('网关地址=' + quiz.maskApiUrl(raw)); }
  }

  /* 一个字段都没改的时候不要白白重写一遍配置文件（saveConfig 会把默认值补全落盘，
     虽说无害，但"没改就一个字节都不写"更好查）。只有伪心跳是单独一个开关文件。 */
  if (changed.length) {
    try { quiz.saveConfig(cfg); }
    catch (e) { return { ok: false, error: '写 答题设置.json 失败：' + (e && e.message) }; }
  } else if (patch.hbSpeed === undefined) {
    return { ok: true, changed: [], hbChanged: '' };
  }

  /* 伪心跳倍速：写的是一个独立开关文件，不是配置。
     驱动器是在启动时把 --speed=N 传给 driver.js 的，所以改了要重跑驱动器才生效 —— 界面上必须说清楚。 */
  let hbChanged = '';
  if (patch.hbSpeed !== undefined && patch.hbSpeed !== null) {
    const n = Number(patch.hbSpeed);
    const v = Number.isFinite(n) && n > 1 ? Math.floor(n) : 0;
    try {
      fs.mkdirSync(path.dirname(F.hbSwitch), { recursive: true });
      fs.writeFileSync(F.hbSwitch, String(v), 'ascii');
      hbChanged = v > 0 ? ('伪心跳已设为 ' + v + ' 倍速') : '伪心跳已关';
    } catch (e) { hbChanged = '写 伪心跳开关.txt 失败：' + (e && e.message); }
  }

  return { ok: true, changed, hbChanged, note: changed.length ? '驱动器会在**换章那一刻**重读配置（跑着的时候改也认，当前这一章不回头）。' : '' };
}

/* ---- 后台任务：开始 / 重启浏览器 这种要等的事，不能让 HTTP 请求干等 ---- */
let JOB = null;
function setJob(name, status, detail) {
  /* 做完的提示别一直挂着：成功的留 20 秒，失败的留足 10 分钟让人看清。
     过期不是靠定时器，而是读的时候判 —— 少一个定时器就少一处能出错的活。 */
  const keep = status === 'fail' ? 10 * 60 * 1000 : 20 * 1000;
  JOB = {
    name, status, detail: detail || '', at: Date.now(),
    expireAt: (status === 'done' || status === 'fail') ? Date.now() + keep : 0,
  };
}
function publicJob() {
  if (!JOB) return null;
  if (JOB.expireAt && Date.now() > JOB.expireAt) { JOB = null; return null; }
  return { name: JOB.name, status: JOB.status, detail: JOB.detail, at: new Date(JOB.at).toLocaleTimeString('zh-CN') };
}

function runDetached(file, args, opts) {
  const c = spawn(file, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: false }, opts || {}));
  c.unref();
  return c;
}

function runCapture(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, Object.assign({ encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120000 }, opts || {}),
      (err, stdout, stderr) => {
        const dec = (b) => { try { return new TextDecoder('utf-8').decode(b || Buffer.alloc(0)); } catch (e) { return String(b); } };
        resolve({ code: err ? (err.code === undefined ? 1 : (err.code || 1)) : 0, out: dec(stdout), err: dec(stderr) });
      });
  });
}

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function startDriverCore() {
  /* 跟 开始.cmd 的 :startfresh 保持一致：清掉上一轮的停止标记，     然后用「学习通驱动器」这个标题开一个最小化的 cmd 外套。

     【日志不再删除，改成归档】
     原来这里是一句 fs.unlinkSync(运行日志.txt) —— 上一轮为什么挂，
     在下一次点「开始」的瞬间就没了，事故没法复盘（界面还依赖"上一轮的日志"
     来显示「（上轮）」和上次失败原因）。
     现在：旧日志挪到 日志\运行日志-YYYYMMDD-HHMMSS.txt，只保留最近 N 份；
     归档后再写一个 本次运行.json 记下这一批的开始时间和日志名，
     界面用它区分「本轮 / 上一轮」。

     【批次要真的传下去（这一条以前断在中间）】
     本次运行.json 里的 sessionId 就是这一批的批次标识，它必须作为 DSH_BATCH
     交给外套（驱动器循环.cmd）→ driver.js。不传的话 driver.js 会当成"新启动"
     自己再生成一个，于是 本次运行.json 记的批次和检查点文件名**对不上** ——
     界面说"本轮"，驱动器却按另一批在记账。
     外套内部重拉时 DSH_BATCH 由 cmd 继承，不会生成新批次（那是同一次运行）。 */
  const rot = wstate.rotateRunLog({
    logPath: F.log,
    dir: F.logDir,
    keep: LOG_KEEP,
    baseName: '运行日志',
  });
  if (rot.action === 'archived') console.log('  旧日志：' + rot.reason);
  else if (!rot.ok) console.log('  旧日志没归档：' + rot.reason);

  const rec = wstate.makeRunRecord({
    log: path.basename(F.log),
    logArchive: rot.archive || '',
  });
  const wr = wstate.writeRunRecord(F.run, rec);
  if (!wr.ok) console.log('  本次运行.json 没写成（不影响跑，但界面会退回按时间判断）：' + wr.error);

  try { if (fs.existsSync(F.stopFlag)) fs.unlinkSync(F.stopFlag); } catch (e) { /* 同上 */ }
  /* env 里其余字段照原样保留，只加/换 DSH_BATCH 这一项。 */
  const env = Object.assign({}, process.env, { DSH_BATCH: rec.sessionId });
  spawn('cmd.exe', ['/c', 'start "学习通驱动器" /min cmd /c "_内部\\驱动器循环.cmd"'],
    { cwd: BASE, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env: env }).unref();
}

/* 填作业：对着「作业作答」页跑一次 填作业.js。
   为什么不塞进 driver：驱动器只认课程学习页（studentstudy），作业页它压根不导航过去；
   而答题助手不挑页面，所以那条路单开在这里。
   【绝不提交】—— 脚本只点「暂时保存」（作业页的函数叫 saveWork），
   答题助手里那道"沾提交就拒绝"的硬闸门照旧生效。
   跑几分钟（每题都要问一次 AI），所以走异步 job，结果落在 logs\填作业.txt。 */
async function jobHomework(dry) {
  setJob('填作业', 'running', dry ? '正在连浏览器，找作业作答页…'
                                  : '正在读题 —— 每题都要问一次 AI，可能要几分钟…');
  let r;
  try {
    r = await runCapture(process.execPath, [P('填作业.js')].concat(dry ? ['--dry'] : []),
                         { cwd: BASE, timeout: 25 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    setJob('填作业', 'fail', '跑不起来：' + (e && e.message ? e.message : e));
    return;
  }
  const text = String((r.out || '') + (r.err || ''));
  try { fs.writeFileSync(path.join(BASE, 'logs', '填作业.txt'), text, 'utf8'); } catch (e) { /* 写不进去不影响结果 */ }
  /* 摘要取末尾几行 —— "遇到/填上/没做成"那三行就在最后 */
  const tail = text.trim().split('\n').slice(-4).map((s) => s.trim()).filter(Boolean)
                   .join(' ｜ ').slice(0, 220);
  setJob('填作业', r.code === 0 ? 'done' : 'fail', tail || ('退出码 ' + r.code));
}

/* 【课程名映射】学习页上没有课程名（实测：DOM/iframe/全局变量都没有，只有 stu_CourseId），
   所以"按课程分库"要靠这张 id→名字 的表。这里让控制台**自动维护**它 ——
   在不打扰驱动器的前提下自己开一个临时标签页读"我的课程"，读完就关。
   （驱动器只认 studentstudy 那种地址，临时页不会被它选中；实测这样跑过一次，抓到 17 门课。） */
async function refreshCourseMap(opts) {
  const o = opts || {};
  const out = { ok: false, n: 0, added: 0, error: '' };
  const f = path.join(BASE, '_课程名.json');
  try {
    const ver = await cdpJson('/json/version');
    if (!ver || !ver.webSocketDebuggerUrl) { out.error = '浏览器调试端口不在（' + CDP_PORT + '）'; return out; }
    const PROBE = `(function () {
      var map = {}, names = [];
      function walk(doc, tag, depth) {
        if (!doc || !doc.body || depth > 3) return;
        var as = null; try { as = doc.querySelectorAll('a[href]'); } catch (e) { return; }
        for (var i = 0; i < as.length; i++) {
          var h = String(as[i].href || '');
          var m = h.match(/courseId=(\\d+)/i) || h.match(/courseid=(\\d+)/i) || h.match(/\\/course\\/(\\d+)/i);
          if (!m) continue;
          var t = String(as[i].innerText || as[i].textContent || '').replace(/\\s+/g, ' ').trim();
          if (t) t = t.split(/[（(【\\[]/)[0].trim();
          if (!t || t.length < 2 || t.length > 40) continue;
          if (/^(进入|查看|继续|开始|学习|课程|主页|详情|更多|返回|上一页|下一页|登录|注册)$/.test(t)) continue;
          if (!map[m[1]]) { map[m[1]] = t; names.push(t + ' = ' + m[1]); }
        }
        var fs2 = null; try { fs2 = doc.querySelectorAll('iframe'); } catch (e) { return; }
        for (var k = 0; k < fs2.length; k++) {
          var cd = null; try { cd = fs2[k].contentDocument; } catch (e) { cd = null; }
          if (cd) walk(cd, tag + '>f' + (k + 1), depth + 1);
        }
      }
      walk(document, 'top', 0);
      return { n: names.length, map: map };
    })()`;
    /* 已经开着"我的课程/个人空间"就直接读；没有就开一个临时的，读完关掉 */
    let openedId = '';
    let pages = await cdpJson('/json/list');
    let targets = (pages || []).filter((t) => t.type === 'page' && /i\.mooc\.chaoxing\.com\/space|i\.chaoxing\.com/.test(String(t.url)));
    if (!targets.length) {
      const b = await cdpOpen(ver.webSocketDebuggerUrl);
      try { const t = await b.call('Target.createTarget', { url: 'https://i.chaoxing.com/base?ws=1' }, 20000); openedId = (t && t.targetId) || ''; }
      finally { try { b.close(); } catch (e) {} }
      for (let i = 0; i < 30 && !targets.length; i++) {
        await new Promise((r) => setTimeout(r, 500));
        pages = await cdpJson('/json/list');
        targets = (pages || []).filter((t) => t.type === 'page' && /i\.chaoxing\.com/.test(String(t.url)));
      }
      await new Promise((r) => setTimeout(r, 3500));    /* 课程列表是异步画的 */
    }
    const all = {};
    for (const t of targets.slice(0, 2)) {
      try {
        const c = await cdpOpen(t.webSocketDebuggerUrl);
        let d = null;
        try { d = await c.call('Runtime.evaluate', { expression: PROBE, returnByValue: true }, 30000); } finally { try { c.close(); } catch (e) {} }
        if (d && d.map) for (const k of Object.keys(d.map)) all[k] = d.map[k];
      } catch (e) { /* 这一页读不到就跳过 */ }
    }
    if (openedId) {
      try {
        const b2 = await cdpOpen(ver.webSocketDebuggerUrl);
        try { await b2.call('Target.closeTarget', { targetId: openedId }, 15000); } finally { try { b2.close(); } catch (e) {} }
      } catch (e) {}
    }
    const keys = Object.keys(all);
    out.n = keys.length;
    if (!keys.length) { out.error = '一门课都没读到（那个页面可能没登录）'; return out; }
    let old = {};
    try { old = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
    const merged = Object.assign({}, old, all);
    out.added = Object.keys(merged).length - Object.keys(old).length;
    fs.writeFileSync(f, JSON.stringify(merged, null, 1), 'utf8');
    out.ok = true;
    out.total = Object.keys(merged).length;
    return out;
  } catch (e) {
    out.error = (e && e.message) || String(e);
    return out;
  }
}

async function jobStart(withEdge) {
  setJob('启动驱动器', 'running', '正在检查…');
  const drv = await readVerifiedDriver();
  if (drv.running) { setJob('启动驱动器', 'fail', '已经有一个驱动器在跑（PID ' + drv.pid + '，身份已核对），不重复启动。'); return; }
  if (await wrapperRunning()) { setJob('启动驱动器', 'fail', '外套（驱动器循环.cmd）已经在跑了，不重复启动。要停就先按「停止驱动器」。'); return; }

  /* 【刷新课程名映射】"按课程分库"要用它；**失败也不拦着启动**（best-effort）。
     放在启动之前：这一轮跑出来的记录才会带上正确的课程名。
     ★ onlyIfNeeded：**只有在"当前这门课还没进表"时才去读页面**（那时才开临时标签页）。
       为什么加这道闸：实测临时页开着的几秒里驱动器会跟过去，学习页被顶掉、白等 3 分钟。
       平时启动根本不会开临时页；临时页也会被确认关掉。 */
  try {
    setJob('启动驱动器', 'running', '正在刷新课程名映射…');
    const cm = await COURSE.refresh({ port: CDP_PORT, dir: BASE, onlyIfNeeded: true, log: (s) => console.log('[课程名] ' + s) });
    if (cm.skipped) console.log('[课程名] 表里已有这门课（共 ' + cm.total + ' 门），跳过刷新');
    else if (!cm.ok) console.log('[课程名] 这次没刷新成功（' + cm.error + '）—— 不影响答题，只是新章节可能进不了课程库');
  } catch (e) { console.log('[课程名] 刷新出错（' + ((e && e.message) || e) + '）—— 忽略'); }

  if (!edge.up) {
    if (!withEdge) {
      setJob('启动驱动器', 'fail', '调试端口 ' + CDP_PORT + ' 不在。点「开浏览器并开始」会用**助手自己的配置目录**开一个 Edge（不动你正开着的那些窗口）。');
      return;
    }
    const exe = findEdge();
    if (!exe) { setJob('启动驱动器', 'fail', '找不到 msedge.exe。'); return; }

    /* 【不再 taskkill /f /im msedge.exe】
       原来的做法是按映像名全杀：用户正开着的 Edge（没保存的表单、正在读的页面）
       会一起没。而助手要的只是"一个带调试端口、用独立配置目录的实例" ——
       那完全不需要动别人的窗口。
       现在只做两件事：① 先问 runtime-processes 有没有助手自己那个实例，
       有就只关它；② 直接 spawn 一个新的（独立 --user-data-dir），把 pid 登记下来。 */
    setJob('启动驱动器', 'running', '正在用独立配置目录开一个带调试端口的 Edge（不动你其它窗口）…');
    const owned = await stopOwnedEdge();
    if (owned.ok && owned.count > 0) {
      setJob('启动驱动器', 'running', '先关掉助手自己那个浏览器（' + owned.count + ' 个进程）…');
      await new Promise((r) => setTimeout(r, 2500));
    } else if (!owned.ok) {
      /* 没有所有权凭据也照样能往下开 —— 只是不会去关任何窗口。原因写进日志。 */
      console.log('（没有助手自己的浏览器可关：' + (owned.reason || '未知') + '）');
    }

    const sandbox = edgeProfileDir();
    const urls = coursesInfo().urls.slice(0, 3);
    if (!urls.length) urls.push('https://mooc1.chaoxing.com/');
    try { fs.mkdirSync(sandbox, { recursive: true }); } catch (e) { /* 已存在 */ }
    const child = runDetached(exe, [
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + sandbox,
      '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1500,1050',
      '--disable-session-crashed-bubble',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=msEdgeFirstRunImport,SwitchIntranetSitesToWorkProfile,msEdgeSharedData,msEdgeDeleteBrowsingDataOnExit,CalculateWindowOcclusion,UseEcoQoSForBackgroundProcess',
    ].concat(urls));
    /* 把 pid 交给 runtime-processes 登记 —— 之后「关浏览器」只关这个实例。
       登记失败不影响启动，但要在日志里说清楚，免得以后"关不掉"没人知道为什么。 */
    const rec = await recordOwnedEdge(child && child.pid);
    if (!rec.ok) console.log('（这次开的浏览器没能登记所有权：' + (rec.reason || '未知') + '）');

    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      probeEdge();
      if (edge.up) break;
    }
    if (!edge.up) { setJob('启动驱动器', 'fail', '等不到调试端口 ' + CDP_PORT + '（40 秒）。常见原因：端口被占用、杀毒软件拦了。'); return; }
    setJob('启动驱动器', 'running', '端口已就绪，等课程页加载（8 秒）…');
    await new Promise((r) => setTimeout(r, 8000));
  }

  setJob('启动驱动器', 'running', '正在拉起驱动器外套…');
  startDriverCore();
  await new Promise((r) => setTimeout(r, 6000));
  const after = await readVerifiedDriver();
  if (after.running) setJob('启动驱动器', 'done', '驱动器已启动（PID ' + after.pid + '，身份已核对）。');
  else if (await wrapperRunning()) setJob('启动驱动器', 'done', '外套已经在跑，驱动器正在起来（PID 稍后出现）。');
  else setJob('启动驱动器', 'fail', '没看到驱动器起来 —— 去看下面的实时日志写了什么。' + (after.reason ? ('（进程判定：' + after.reason + '）') : ''));
}

async function jobStop() {
  setJob('停止驱动器', 'running', '正在停…');
  /* 顺序跟 停止.cmd 一样：先立停止标记（外套才不会又自动重来），再停进程。 */
  try {
    fs.mkdirSync(path.dirname(F.stopFlag), { recursive: true });
    fs.writeFileSync(F.stopFlag, 'stop', 'ascii');
  } catch (e) { /* 写不了也继续 */ }

  /* 【不再 taskkill /f /pid <运行中.pid 里的数字>】
     PID 会被 Windows 回收，那个数字可能已经是别人的进程了。
     停之前必须由 runtime-processes.js 核对身份（映像名 + 命令行），
     它说能停才停；核对不了就什么都不做，把理由显示出来。 */
  const before = await readVerifiedDriver();
  if (!before.running) {
    const why = before.reason || (before.alive ? '进程活着但身份对不上（不是 driver.js）' : '驱动器本来就没在跑');
    setJob('停止驱动器', 'done', '没有可停的驱动器：' + why + '。停止标记已立，外套不会自动重来。');
    return;
  }
  const r = await stopDriverVerified();
  const after = await readVerifiedDriver();
  if (!after.running) {
    setJob('停止驱动器', 'done', '驱动器已停止。' + (r.pid || before.pid ? ('（原 PID ' + (r.pid || before.pid) + '）') : '') + (r.reason ? ('　' + r.reason) : ''));
  } else {
    setJob('停止驱动器', 'fail', '没能停掉 PID ' + after.pid + '：' + (r.reason || '原因不明') + '。可以试试直接关掉那个最小化的「学习通驱动器」黑框。');
  }
}

/* ============================================================================
 * 五、HTTP
 * ==========================================================================*/

function json(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, sec.securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }));
  res.end(body);
}

function sendFileList(res, key) {
  /* 白名单式取文件 —— 只认这几个键，别的键一律不认。
     前端永远传不来路径，所以不存在"用 ?file= ../../ 读走别的文件"这条路。 */
  const map = {
    log: [F.log, 600, 512 * 1024],
    count: [F.count, 400, 256 * 1024],
    miss: [F.miss, 300, 128 * 1024],
    record: [F.out, 400, 384 * 1024],
    todo: [F.todo, 300, 128 * 1024],
    courses: [F.courses, 60, 64 * 1024],
  };
  const e = map[key];
  if (!e) return json(res, { ok: false, error: '不认识的文件键：' + key }, 400);
  const st = statSafe(e[0]);
  if (!st) return json(res, { ok: true, exists: false, lines: [], path: e[0] });
  return json(res, {
    ok: true, exists: true, path: e[0],
    size: st.size,
    mtime: new Date(st.mtimeMs).toLocaleString('zh-CN'),
    lines: tailLines(e[0], e[1], e[2]),
  });
}

async function handleAction(payload) {
  const a = String(payload.action || '');
  switch (a) {
    case 'start':
      jobStart(false).catch((e) => setJob('启动驱动器', 'fail', String(e && e.message)));
      return { ok: true, queued: 'start' };
    case 'startEdge':
      jobStart(true).catch((e) => setJob('启动驱动器', 'fail', String(e && e.message)));
      return { ok: true, queued: 'startEdge' };
    case 'stop':
      jobStop().catch((e) => setJob('停止驱动器', 'fail', String(e && e.message)));
      return { ok: true, queued: 'stop' };
    case 'homework':
      /* 填作业要跑几分钟（每题都要问一次 AI），所以走异步 job，不卡住这个请求 ——
         前端每几秒轮询一次状态，进度看「最近任务」那个小框。 */
      jobHomework(!!payload.dry).catch((e) => setJob('填作业', 'fail', String(e && e.message)));
      return { ok: true, queued: 'homework' };
    case 'stopEdge': {
      /* 【只关助手自己那个实例】
         原来这里是 taskkill /f /im msedge.exe —— 用户所有 Edge 窗口一起没。
         现在交给 runtime-processes.js：它只认自己登记过的 pid / profileDir，
         没有所有权凭据就什么都不关，并如实回报原因（不猜 PID）。 */
      const r = await stopOwnedEdge();
      probeEdge();
      if (!r.ok) {
        return { ok: false, error: '没有关掉任何浏览器：' + (r.reason || '没有所有权凭据'), output: r.reason || '' };
      }
      if (!r.count) {
        return { ok: true, output: '没有找到助手自己启动的浏览器（' + (r.reason || '可能是手动开的、或者已经关了') + '）。你别的 Edge 窗口一个都没动。' };
      }
      return { ok: true, output: '已关掉助手自己启动的浏览器（' + r.count + ' 个进程）。' + (r.reason ? ('　' + r.reason) : '') + '你别的 Edge 窗口没动。' };
    }
    case 'decode': {
      setJob('解码乱码', 'running', '正在跑 解乱码.js…');
      const r = await runCapture(process.execPath, [F.decoder], { cwd: BASE });
      const text = (r.out || '') + (r.err || '');
      setJob('解码乱码', r.code === 0 ? 'done' : 'fail', r.code === 0 ? '解码完成，结果见下。' : '解码脚本退出码 ' + r.code);
      return { ok: r.code === 0, output: text.slice(-6000), code: r.code };
    }
    case 'testkey': {
      setJob('测试 API key', 'running', '真的往 api.deepseek.com 发一次最小请求…');
      const r = await runCapture(process.execPath, [F.cfgCli, '--test'], { cwd: BASE });
      const text = (r.out || '') + (r.err || '');
      setJob('测试 API key', r.code === 0 ? 'done' : 'fail', r.code === 0 ? 'key 可用。' : 'key 没通过（详情见下）。');
      return { ok: r.code === 0, output: text.slice(-6000), code: r.code };
    }
    case 'selfcheck': {
      setJob('环境自检', 'running', '…');
      const out = [];
      out.push('node            ' + process.version + '   ' + process.execPath);
      out.push('本控制台        http://127.0.0.1:' + SERVER_PORT + '/   （只监听本机）');
      out.push('调试端口        ' + (edge.up ? ('在 ' + edge.browser) : ('不在（' + (edge.error || '没在跑') + '）')));
      const drv = await readVerifiedDriver();
      out.push('驱动器          ' + (drv.running ? ('在跑 PID ' + drv.pid + '（身份已核对）')
        : (drv.alive ? ('PID ' + drv.pid + ' 活着但身份对不上 —— 不认它：' + (drv.reason || ''))
                     : ('没在跑' + (drv.reason ? ('（' + drv.reason + '）') : '')))));
      out.push('进程模块        ' + (procReady() ? 'runtime-processes.js 已加载（进程/浏览器都按所有权判定）' : ('**缺 runtime-processes.js** —— ' + PROC_MISSING_REASON)));
      out.push('外壳闸门        Host 只认 localhost/127.0.0.1/[::1] + 本端口；POST 要 Origin=自身 + application/json + token；token 每次启动随机生成，不在 /api/state 里回显。');
      const rp = readRunRecord();
      out.push('本轮批次        ' + (rp ? (rp.startedAt + '（日志 ' + rp.log + (rp.logArchive ? '，上一份归档 ' + path.basename(rp.logArchive) : '') + '）') : '还没从网页控制台开过（回退按时间判断）'));
      const logSt = statSafe(F.log);
      out.push('日志归属        ' + (!logSt || !logSt.size ? '还没有内容（不标「上轮」）'
        : (wstate.deriveLogView({ exists: true, hasContent: true, logMtimeMs: logSt.mtimeMs, logName: path.basename(F.log), run: rp }).stale ? '上一轮留下的' : '本轮写的')));
      out.push('日志归档        ' + F.logDir + '\\' + wstate.LOG_ARCHIVE_PREFIX + '*.txt，保留最近 ' + LOG_KEEP + ' 份');
      out.push('外套             ' + ((await wrapperRunning()) ? '在跑（窗口标题：学习通驱动器）' : '没在跑'));
      const hb = heartbeat();
      out.push('日志心跳        ' + (hb.exists ? (hb.ageSec + ' 秒前写过，共 ' + hb.size + ' 字节') : '还没有 运行日志.txt'));
      for (const f of ['driver.js', '答题助手.js', '配置.js', '解乱码.js', '伪心跳.js', '_内部\\驱动器循环.cmd']) {
        const p = P(...f.split('\\'));
        out.push('[文件] ' + f + '  ' + (fs.existsSync(p) ? ('在，' + Math.round(statSafe(p).size / 1024) + ' KB') : '**缺！**'));
      }
      for (const f of ['driver.js', '答题助手.js', '配置.js']) {
        const r2 = await runCapture(process.execPath, ['--check', P(f)]);
        out.push('[语法] ' + f + '  ' + (r2.code === 0 ? '正常' : ('有错！ ' + (r2.err || '').split('\n')[0])));
      }
      const fs2 = fontStatus();
      out.push('字体解码表      ' + (fs2.ok ? (fs2.count + ' 个替身字' + (fs2.matches === true ? '，指纹校验通过' : (fs2.matches === false ? '，**指纹不符**' : ''))) : fs2.note));
      const c = quiz.loadConfig();
      out.push('API key         ' + maskKey(c.apiKey || process.env.DEEPSEEK_API_KEY || '') + '   来源 ' + (c.apiKey ? '配置文件' : (process.env.DEEPSEEK_API_KEY ? '环境变量' : '没配')));
      const r = { ok: true, output: out.join('\n') };
      setJob('环境自检', 'done', '自检完成。');
      return r;
    }
    case 'openfolder': {
      runDetached('explorer.exe', [BASE]);
      return { ok: true };
    }
    default:
      return { ok: false, error: '不认识的动作：' + a };
  }
}

/* 请求体读取、JSON 解析、体积上限都在 web-security.js 里（那边能离线测试）。
   【关键差别】原来的版本遇到坏 JSON 会 resolve({}) —— 于是"你的 JSON 坏了"
   和"我什么都没改"变成同一种结果；超限也是 resolve({})，413 变成静默成功。
   现在每种情况都带明确状态码返回。 */
const readBody = sec.readBody;

let SERVER_PORT = WANT_PORT;
const SERVER_STARTED_AT = new Date().toLocaleString('sv-SE');   /* 给自己看的启动时间（/api/hello 里回） */
/* 每次启动生成一个随机 token。页面在 HTML 里拿到它，之后所有请求都带在
   X-Dsh-Console-Token 头里。跨源的网页读不到这份 HTML，也过不了预检，
   所以它拿不到 token。token 不出现在 /api/state、不出现在日志里。 */
const CONSOLE_TOKEN = sec.makeToken(32);

/* 统一的响应出口：所有响应都带 no-store 等安全头。 */
function sendJson(res, obj, code, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, sec.securityHeaders(Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  }, extraHeaders || {})));
  res.end(body);
}

/* 拒绝：状态码由 web-security.js 定（403/415/400/413），**不带** CORS 许可头。
   拒绝就是拒绝，不回显任何业务数据，也不产生副作用（handleAction 在闸门之后才跑）。

   【关键】请求体没读完的 POST（体积超限，或在体积检查那一步就被拒），
   要显式回 Connection: close，并且**不能**在写响应之前去 req.destroy()：
   先 destroy 的话客户端只会看到 ECONNRESET，那个 413 根本没机会发出去
   （实测复现过）。正确的收尾是——先在连接上把响应写出去，带上 close，
   剩下的未读请求体交给 Node 自己丢掉再关连接（readBody 里也在持续把
   超限之后的字节读掉，不让它们在 socket 上堆积）。 */
function sendDeny(res, d, req) {
  const close = sec.needsConnectionClose(d, req);
  return sendJson(res, { ok: false, error: d.message, code: d.code, detail: d.extra || '' }, d.status,
    close ? { 'Connection': 'close' } : null);
}

const server = http.createServer(async (req, res) => {
  let u = null;
  try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return sendJson(res, { ok: false, error: '请求地址读不出来' }, 400); }
  try {
    const method = String(req.method || '').toUpperCase();
    const isEntry = (u.pathname === '/' || u.pathname === '/index.html');
    const isFavicon = u.pathname === '/favicon.ico';

    /* 【单实例识别专线】/api/hello 只回 app 名/端口/pid/启动时间，不带任何密钥；
       但**必须**跳过 token 检查 —— 新启动的进程就是靠它认"这个端口上是不是自己人"。
       只允许本机 Host（和页面入口同一条 Host 检查），别的源读不到（无 CORS 头）。 */
    if (method === 'GET' && u.pathname === '/api/hello') {
      const h0 = sec.checkHost(req.headers.host, SERVER_PORT);
      if (!h0.ok) return sendDeny(res, h0, req);
      const body0 = Buffer.from(JSON.stringify({
        ok: true, app: '学习通助手控制台', port: SERVER_PORT,
        pid: process.pid, startedAt: SERVER_STARTED_AT
      }), 'utf8');
      res.writeHead(200, sec.securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body0.length }));
      return res.end(body0);
    }

    /* HTML 入口：本机 Host GET 就能拿（用户得先能打开页面，页面里才有 token）。
       跨源读不到 —— 同源策略 + 没有 CORS 许可头。 */
    if (method === 'GET' && (isEntry || isFavicon)) {
      const h = sec.checkHost(req.headers.host, SERVER_PORT);
      if (!h.ok) return sendDeny(res, h, req);
      if (isFavicon) { res.writeHead(204, sec.securityHeaders()); return res.end(); }
      const body = Buffer.from(sec.injectToken(PAGE, CONSOLE_TOKEN).replace(/__PAGE_VERSION__/g, PAGE_VERSION), 'utf8');
      res.writeHead(200, sec.securityHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        /* 页面里的内联脚本要用 token 发自定义头，所以 connect-src 只放行自己。 */
      }));
      return res.end(body);
    }

    /* 预检：只有 Origin 精确等于自身才给许可（别的源一个头都不给）。 */
    if (method === 'OPTIONS') {
      const h = sec.checkHost(req.headers.host, SERVER_PORT);
      if (!h.ok) return sendDeny(res, h, req);
      const selfOrigin = sec.selfOriginFromHost(req.headers.host, SERVER_PORT);
      const cors = sec.corsHeadersFor(req.headers.origin, selfOrigin);
      res.writeHead(204, sec.securityHeaders(cors));
      return res.end();
    }

    /* 剩下的（/api/*）全都过闸门：Host → (POST: Content-Type/Origin) → token → 体积。
       GET 状态/文件同样要 token —— 这正是"页面自带 token"之外别的网页读不到状态的原因。 */
    const gate = sec.verifyRequest(req, { port: SERVER_PORT, token: CONSOLE_TOKEN, maxBody: sec.DEFAULT_MAX_BODY });
    if (!gate.ok) {
      /* 预检失败要回 CORS 头，否则浏览器把 403 报成"网络错误"，用户看不到原因。 */
      if (req.headers.origin === sec.selfOriginFromHost(req.headers.host, SERVER_PORT)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      }
      /* 声明 Content-Length 超限的请求就是在这一步被拒的（请求体一个字都没读），
         sendDeny 会按 needsConnectionClose 回 Connection: close。 */
      return sendDeny(res, gate, req);
    }

    if (method === 'GET') {
      if (u.pathname === '/api/state') return sendJson(res, await apiState());
      if (u.pathname === '/api/bank') return sendJson(res, apiBank());
      if (u.pathname === '/api/file') return sendFileList(res, u.searchParams.get('f') || 'log');
      if (u.pathname === '/api/ping') return sendJson(res, { ok: true, port: SERVER_PORT });
    }
    if (method === 'POST') {
      /* chunked（没声明长度）的超限在这里才被发现：readBody 一过上限就立刻
         回 413，并把后面的字节读掉丢掉，绝不 req.destroy() —— 那样客户端
         只能看到 ECONNRESET，收不到 413。 */
      const body = await readBody(req, { maxBytes: sec.DEFAULT_MAX_BODY });
      if (!body.ok) return sendDeny(res, body, req);
      const payload = body.value;
      if (u.pathname === '/api/config') return sendJson(res, saveConfigPatch(payload));
      if (u.pathname === '/api/bank') {
        /* 【库管理】target = 哪个库（不传=主库；给一个没用过的名字=新建子库）
           lib    = 导出哪一个库      enabled = 启用哪些库（数组） */
        if (payload && payload.enabled) return sendJson(res, bankSetEnabled(payload.enabled === true ? [] : payload.enabled));
        if (payload && payload.code) return sendJson(res, bankImportCode(payload.code, payload.target));
        if (payload && payload.make) return sendJson(res, bankMakeCode(payload.lib));
        if (payload && payload.dedupe) return sendJson(res, bankDedupe(payload.target));
        if (payload && payload.clean) return sendJson(res, bankClean(payload.target));
        if (payload && payload.conflicts) return sendJson(res, bankExportConflicts(payload.target));
        if (payload && payload.exportTags) return sendJson(res, bankExportByTags(payload.target, payload.exportTags, !!payload.asCode));
        return sendJson(res, { ok: false, error: '要带 code（导入）/ make:true（导出成码）/ dedupe:true（去重复）/ enabled:[库名…]（启用哪些库）' }, 400);
      }
      if (u.pathname === '/api/action') return sendJson(res, await handleAction(payload));
    }
    return sendJson(res, { ok: false, error: 'not found' }, 404);
  } catch (e) {
    return sendJson(res, { ok: false, error: (e && e.name) + ': ' + (e && e.message) }, 500);
  }
});

/* ============================================================================
 * 六、页面
 * ==========================================================================*/

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%234d8dff'/><text x='16' y='24' font-size='21' text-anchor='middle' fill='%230b1220' font-family='sans-serif' font-weight='700'>%E5%AD%A6</text></svg>">
<title>学习通助手 · 控制台</title>
<style>
:root{
  --bg:#0e1014;--panel:#161a21;--panel2:#1b2029;--line:#252b36;--line2:#323a49;
  --fg:#e9edf3;--dim:#8c95a4;--dim2:#5f6875;
  --ok:#35d07f;--warn:#f4b740;--bad:#ff6b60;--acc:#4d8dff;--acc2:#7bb0ff;
  --r:14px;--r2:9px;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 30px -18px rgba(0,0,0,.85);
}
*{box-sizing:border-box}
html{scrollbar-color:#323a49 transparent}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#2c3340;border-radius:8px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:#3d4757;background-clip:padding-box}
body{margin:0;background:
  radial-gradient(1200px 600px at 15% -10%,rgba(77,141,255,.07),transparent 60%),
  radial-gradient(900px 500px at 100% 0%,rgba(53,208,127,.05),transparent 55%),
  var(--bg);
  color:var(--fg);font:14px/1.6 "Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased}

header{position:sticky;top:0;z-index:9;backdrop-filter:blur(10px);background:rgba(16,19,24,.86);
  border-bottom:1px solid var(--line);padding:11px 22px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;margin-right:6px}
.mark{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:15px;color:#0b1220;background:linear-gradient(140deg,var(--acc2),var(--acc));
  box-shadow:0 4px 14px -6px rgba(77,141,255,.9)}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
.brand .sub{font-size:11px;color:var(--dim2);font-family:Consolas,monospace;line-height:1.3}
.spacer{flex:1}

.pill{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:20px;font-size:12.5px;
  border:1px solid var(--line2);background:#171b23;white-space:nowrap;transition:.2s}
.pill::before,.hero-state::before{content:'';width:7px;height:7px;border-radius:50%;
  background:currentColor;box-shadow:0 0 9px currentColor;flex:none}
.ok{color:var(--ok);border-color:rgba(53,208,127,.35);background:rgba(53,208,127,.08)}
.bad{color:var(--bad);border-color:rgba(255,107,96,.35);background:rgba(255,107,96,.08)}
.warn{color:var(--warn);border-color:rgba(244,183,64,.35);background:rgba(244,183,64,.08)}
.idle{color:var(--dim)}

main{padding:20px 22px 70px;max-width:1200px;margin:0 auto}
section{background:linear-gradient(180deg,#171b23,#151920);border:1px solid var(--line);border-radius:var(--r);
  margin-bottom:18px;overflow:hidden;box-shadow:var(--shadow)}
section>h2{font-size:13.5px;margin:0;padding:13px 18px;background:rgba(27,32,41,.72);
  border-bottom:1px solid var(--line);font-weight:600;letter-spacing:.3px;
  display:flex;align-items:center;gap:9px;flex-wrap:wrap}
section>h2::before{content:'';width:3px;height:13px;border-radius:2px;background:var(--acc);
  box-shadow:0 0 10px rgba(77,141,255,.7);flex:none}
section>h2 .tag{font-weight:400;font-size:12px;color:var(--dim2);letter-spacing:0}
.body{padding:16px 18px}

/* —— 仪表盘 —— */
.hero{padding:22px 24px}
.hero-top{display:flex;gap:26px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.hero-state{display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:600;
  padding:6px 14px;border-radius:20px;border:1px solid var(--line2);background:#171b23}
.hero-chap{font-size:28px;font-weight:700;letter-spacing:.4px;margin:14px 0 6px;line-height:1.25}
.hero-phase{color:var(--dim);font-size:13.5px}
.stats{display:flex;gap:14px;flex-wrap:wrap}
.stat{min-width:106px;padding:13px 16px;border-radius:var(--r2);text-align:center;
  background:linear-gradient(180deg,#131820,#101419);border:1px solid var(--line);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.stat b{display:block;font:600 27px/1.15 Consolas,"Cascadia Mono",monospace;letter-spacing:-.5px}
.stat span{font-size:11.5px;color:var(--dim2);letter-spacing:.6px}
.stat.s-ok{border-color:rgba(53,208,127,.28)}
.stat.s-bad{border-color:rgba(255,107,96,.28)}
.stat.s-ok b{color:var(--ok)}.stat.s-bad b{color:var(--bad)}.stat.s-acc b{color:var(--acc2)}

.progress{position:relative;height:28px;background:#0b0e12;border:1px solid var(--line);border-radius:9px;
  overflow:hidden;margin-top:16px}
.progress>i{position:absolute;top:0;bottom:0;left:0;width:0;border-radius:8px 0 0 8px;
  background:linear-gradient(90deg,#3070d8,#5d9dff);
  box-shadow:0 0 20px rgba(77,141,255,.55);transition:width .7s ease}
.progress>span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font:12.5px/1 Consolas,monospace;text-shadow:0 1px 3px rgba(0,0,0,.75);letter-spacing:.4px}

.mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 22px;margin-top:16px;
  padding-top:15px;border-top:1px solid var(--line)}
.mini>div{font-size:12.5px;color:var(--dim);display:flex;gap:8px;align-items:baseline;min-width:0}
.mini>div>span{color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 7px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{color:var(--dim2);font-weight:500;font-size:11.5px;letter-spacing:.6px}
tbody tr{transition:background .12s}
tbody tr:hover{background:rgba(45,54,69,.45)}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-family:Consolas,monospace;font-size:13.5px;width:92px;padding-right:18px}

input,select,textarea,button{font:inherit;color:var(--fg);background:#1e2430;border:1px solid var(--line2);
  border-radius:var(--r2);padding:7px 10px;transition:border-color .15s,box-shadow .15s,background .15s}
select{appearance:none;padding-right:30px;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' fill='none' stroke='%238c95a4' stroke-width='1.6'/></svg>");
  background-repeat:no-repeat;background-position:right 10px center}
input:hover,select:hover,textarea:hover{border-color:#3d4655}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(77,141,255,.16)}
input[type=password]{width:100%}
input[type=checkbox]{width:16px;height:16px;accent-color:var(--acc);padding:0}
button{cursor:pointer;background:#232a36}
button:hover{background:#2c3543;border-color:#48535f}
button:active{transform:translateY(1px)}
button.primary{background:linear-gradient(180deg,#5a97ff,#3f7ce8);border-color:#4d8dff;color:#08101f;font-weight:700}
button.primary:hover{background:linear-gradient(180deg,#6ea4ff,#4a86f0)}
button.danger{border-color:rgba(255,107,96,.45);color:#ff8a80;background:rgba(255,107,96,.08)}
button.danger:hover{background:rgba(255,107,96,.16);color:#ffb3ad}
button.warn{border-color:rgba(244,183,64,.45);color:var(--warn);background:rgba(244,183,64,.08)}
button.warn:hover{background:rgba(244,183,64,.16)}

.grid{display:grid;gap:14px 18px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.grid3{grid-template-columns:repeat(3,minmax(0,1fr))}
.grid2{grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:880px){.grid3{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.grid3,.grid2{grid-template-columns:1fr}}
label.f{display:flex;flex-direction:column;gap:5px;color:var(--dim);font-size:12px;letter-spacing:.3px}
label.f>span{color:var(--dim2);font-size:11.5px;line-height:1.5}
.switch{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:13px}
pre{background:#0b0e12;border:1px solid var(--line);border-radius:var(--r2);padding:12px 14px;
  max-height:430px;overflow:auto;font:12.2px/1.62 Consolas,"Cascadia Mono",monospace;
  white-space:pre-wrap;word-break:break-word;tab-size:2}
.dim{color:var(--dim)}.small{font-size:12px}.okt{color:var(--ok)}.badt{color:var(--bad)}.warnt{color:var(--warn)}
.mono{font-family:Consolas,"Cascadia Mono",monospace;font-size:12.5px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.librow{display:block;margin:3px 0;font-size:12.5px;color:#cfd6e4;cursor:pointer}
.librow input{vertical-align:-1px;margin-right:4px}
.note{background:rgba(244,183,64,.06);border:1px solid rgba(244,183,64,.18);border-left:3px solid var(--warn);
  padding:9px 13px;border-radius:8px;color:#c3cbd8;font-size:12.5px;margin:10px 0;line-height:1.7}
.note b{color:var(--fg)}
.kv{display:grid;grid-template-columns:118px 1fr;gap:7px 14px;font-size:13px;align-items:baseline}
.kv>div:nth-child(odd){color:var(--dim2);font-size:12.5px}
#hint{color:var(--acc2);font-size:12.5px;font-weight:600}
.lg{white-space:pre-wrap;word-break:break-word;padding:0}
.lg.w{color:var(--warn)}
.lg.e{color:var(--bad)}
footer{max-width:1200px;margin:0 auto;padding:0 22px 40px;color:var(--dim2);font-size:12px;
  display:flex;gap:16px;flex-wrap:wrap;justify-content:space-between}
@media(max-width:760px){
  .hero-chap{font-size:21px}
  .stat{flex:1;min-width:88px;padding:10px}
  .stat b{font-size:22px}
  main{padding:14px 12px 60px}
  header{padding:10px 12px}
}
</style></head><body>
<header>
  <div class="brand">
    <div class="mark">学</div>
    <div>
      <h1>学习通助手 · 控制台</h1>
      <div class="sub" id="suburl">http://127.0.0.1:8898/</div>
      <!-- 【2026-10-11】放标题正下方，让人一定看得到。
           原来只放在页脚 —— 页面滚到底才看得见，而且页脚默认色是暗灰，
           作者本人在页面上找了一圈都没看见。照文本控制台用的黄色。 -->
      <div class="sub" style="color:#ffd479;margin-top:2px">有问题或捐款请向 <a href="mailto:3975139018@qq.com" style="color:#ffd479;text-decoration:underline">3975139018@qq.com</a> 联系</div>
    </div>
  </div>
  <span id="hb" class="pill idle">心跳 …</span>
  <span id="drv" class="pill idle">驱动器 …</span>
  <span class="spacer"></span>
  <span id="hint"></span>
  <button onclick="refresh()">刷新</button>
  <button class="danger" onclick="stopDriver()">停止驱动器</button>
</header>
<main>

  <section class="hero">
    <div class="hero-top">
      <div style="min-width:0;flex:1 1 420px">
        <div class="hero-state idle" id="heroState">未运行</div>
        <div class="hero-chap" id="heroChap">还没开始</div>
        <div class="hero-phase" id="heroPhase">点下面的「开始 / 继续」就开跑。</div>
      </div>
      <div class="stats">
        <div class="stat"><b id="stFound">0</b><span>本轮遇到</span></div>
        <div class="stat s-ok"><b id="stFilled">0</b><span>填上（草稿）</span></div>
        <div class="stat s-bad"><b id="stMissed">0</b><span>欠着</span></div>
      </div>
    </div>
    <div class="progress"><i id="bar"></i><span id="vidnum">没有在播的视频</span></div>
    <div class="mini">
      <div>调试端口<span id="mPort">—</span></div>
      <div>驱动器<span id="mDrv">—</span></div>
      <div>日志<span id="mLog">—</span></div>
      <div>课程<span id="mCourse">—</span></div>
      <div>字体解码表<span id="mFont">—</span></div>
    </div>
    <div id="warnbox" style="margin-top:14px"></div>
    <div class="row" style="margin-top:16px">
      <button class="primary" onclick="startDriver()">开始 / 继续</button>
      <button class="warn" onclick="startEdge()">开浏览器并开始</button>
      <button class="danger" onclick="stopDriver()">停止驱动器</button>
      <button class="danger" onclick="stopEdgeBrowser()">关掉浏览器</button>
    </div>
    <div class="dim small" style="margin-top:9px">「开浏览器并开始」会用一个<b>独立的配置目录</b>开一个带调试端口的 Edge —— <b>不会</b>关你其它已经开着的 Edge 窗口（第一次要在新开的那个里登录一次学习通）。「关掉浏览器」只关助手自己启动的那一个（有确认框）。</div>
    <div id="jobbox" class="note" style="display:none"></div>
  </section>

  <section><h2>答题助手</h2><div class="body">
    <div class="note">改完保存即可 —— 驱动器会在<b>换章那一刻</b>重读配置，当前这一章不回头。</div>
    <div class="grid grid3">
      <label class="f">模式
        <select id="mode">
          <option value="0">不做题（只放视频、翻节）</option>
          <option value="1">记下题，不问 AI</option>
          <option value="2">记下题 + 问 AI</option>
        </select><span id="modeDesc"></span></label>
      <label class="f">读题方式
        <select id="readMode">
          <option value="auto">自动（能用表就用表）</option>
          <option value="table">只用解码表（快、免费）</option>
          <option value="shot">只用截图 + 看图模型</option>
        </select><span id="readModeDesc"></span></label>
      <label class="f">每章最多问几题<input type="number" id="maxPerChapter" min="1"></label>
      <label class="f">AI 模式（问模型答题）
        <select id="useAI"><option value="1">开</option><option value="0">关（一分钱不花）</option></select></label>
      <label class="f">题库模式（先用本地题库答）
        <select id="useBank"><option value="1">开</option><option value="0">关（一律重新问）</option></select></label>
      <label class="f">AI 答案自动填进页面
        <select id="autoFill"><option value="1">开（只填选择/判断，不提交）</option><option value="0">关</option></select></label>
      <label class="f">碰到测验
        <select id="stopAtQuiz"><option value="0">测验不停（记下题继续跑）</option><option value="1">测验停（一碰到就退出，等你填）</option></select></label>
      <label class="f">最多截几张图<input type="number" id="maxShots" min="1"></label>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="primary" onclick="saveCfg()">保存</button>
      <span class="dim small">写配置走的是 答题助手.js 的 saveConfig —— 跟命令行同一个入口，不会出现两个界面各写一半。</span>
    </div>
    <div class="note" style="margin-top:14px">不管开关怎么拨，<b>提交永远由你自己按</b>。程序里没有任何点提交按钮的逻辑。</div>
    <div class="note" style="margin-top:14px;border-left-color:#ffb86b">
      <b>作业作答页</b>（那种独立的作业页，不是章节里的测验）：驱动器不认它 —— 它的世界只有课程学习页，
      挑标签页时只找 <code>studentstudy</code>。但答题助手不挑页面，所以这里让它直接跑一次：
      读题 → 问 AI → 勾选 → 点「暂时保存」。<b>绝不提交。</b>
    </div>
    <div class="row" style="margin-top:10px">
      <button onclick="homework(true)">先看看有几道题</button>
      <button class="warn" onclick="homework(false)">填这份作业</button>
      <span class="dim small">要先在浏览器里把那份作业打开着（它在找地址带 <code>work/dowork</code> 的那个标签）。</span>
    </div>
    <div id="hworkout" class="pre" style="display:none;margin-top:10px;max-height:320px"></div>
  </div></section>

  <section><h2>题库 <span class="tag" id="bankTag"></span></h2><div class="body">
    <div class="note">本地库 = 从「章节测验记录.txt」建出来的"题 + 答案"。答题命中库里的题就
      <b>不问 AI</b> 直接填（省一次调用）；<b>没装库时一切照旧</b>，行为跟以前一模一样。</div>
    <div class="kv" id="bankStats" style="margin-bottom:12px">—</div>
    <div class="row">
      <button onclick="bankRefresh()">刷新库状态</button>
      <div id="banklibs" style="margin-top:10px"></div>
      <div id="banklibhint" class="note" style="margin-top:6px"></div>
      <label class="f">导入到哪个库
        <select id="bankTarget"></select></label>
      <label class="f">或新建一个子库<input id="bankNewLib" placeholder="子库名字（留空就用上面选的）"></label>
      <button onclick="bankMake()">把当前库导出成题库码</button>
      <button onclick="bankDedupe()">一键去重复</button>
      <button onclick="bankClean()">去杂（清非法脏数据）</button>
      <button onclick="bankConflicts()">导出冲突答案</button>
      <div id="banktags" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center"></div>
      <div style="margin-top:6px">
        <button onclick="bankExportTags()">导出所选标签（码 + 报告）</button>
        <button onclick="bankExportTagsCode()">只出题库码</button>
        <button onclick="bankTagsAll()">全选标签</button>
        <button onclick="bankTagsNone()">清空标签</button>
      </div>
    </div>
    <!-- 【导出的题库码：专门一块输出区】以前生成的码被塞进下面那个"粘贴导入"的框里，
         框上还写着"把别人给的码粘到这里"，看着就拧巴（2026-10-12 法师提的）。 -->
    <div style="margin-top:12px">
      <div class="row" style="align-items:center">
        <b>导出的题库码</b>
        <span class="dim" id="bankoutCodeInfo">（还没生成）</span>
        <button onclick="bankCopyOut()">复制这段码</button>
        <button onclick="bankClearOut()">清空</button>
      </div>
      <textarea id="bankoutCode" rows="5" readonly onclick="this.select()"
        style="width:100%;margin-top:6px;font-family:ui-monospace,Consolas,monospace;font-size:12px;background:#fafafa"
        placeholder="点上面的「把当前库导出成题库码」，码会出现在这里（点一下会自动全选）"></textarea>
    </div>
    <textarea id="bankcode" rows="6" style="width:100%;margin-top:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px"
      placeholder="把别人给的题库码（TIKU1: 开头的一长串）粘到这里，再点下面的「添加题库码」"></textarea>
    <div class="row" style="margin-top:10px">
      <button class="primary" onclick="bankAdd()">添加题库码</button>
      <span class="dim small">是<b>合并</b>不是覆盖：同一道题答案不一样时两份都留着，并标成「冲突」。</span>
    </div>
    <div class="note" style="margin-top:14px">码里只有<b>三把键 + 答案 + 答案正文 + 可信度</b>，
      <b>没有题干原文、没有选项全文、没有课程名和章节</b> —— 拷给别人不会带出你的学习轨迹；
      对别人也够用：三把键他们能用自己的页面现算出来。</div>
    <pre id="bankout" class="pre" style="display:none;margin-top:10px;max-height:260px"></pre>
    <!-- 【导出内容就在页面上看】导冲突/导标签以前只写文件 ⇒ 现在同一份文本也显示在这里，
         可以一键复制（文件照样写，方便用 Excel 打开）。 -->
    <div class="row" style="margin-top:6px">
      <button onclick="bankCopyText()">复制这段文本</button>
      <button onclick="bankHideText()">收起</button>
      <span class="dim" id="bankTextInfo"></span>
    </div>
    <pre id="banktext" class="pre" style="display:none;margin-top:6px;max-height:420px"></pre>
  </div></section>

  <section><h2>API key 与模型</h2><div class="body">
    <div class="kv" style="margin-bottom:12px">
      <div>当前 key</div><div id="s-key" class="mono">—</div>
      <div>来源</div><div id="s-keyfrom">—</div>
      <div>网关</div><div id="s-apiurl">—</div>
    </div>
    <div class="row">
      <input type="password" id="apiKey" placeholder="粘贴新的 API key（留空 = 不改）" style="flex:1;min-width:260px">
      <input type="text" id="apiUrl" placeholder="网关地址（留空 = 用默认 DeepSeek；换中转就填对方给的完整 URL" style="flex:1;min-width:260px">
      <button class="primary" onclick="saveKey()">保存 key</button>
      <button class="danger" onclick="clearKey()">清除 key</button>
      <button onclick="resetApiUrl()">网关恢复默认</button>
    </div>
    <div class="grid grid2" style="margin-top:16px">
      <label class="f">答题模型<input id="model" placeholder="deepseek-flash"></label>
      <label class="f">看图模型（截图读题时用）<input id="visionModel" placeholder="deepseek-flash"></label>
    </div>
    <div class="row" style="margin-top:12px"><button class="primary" onclick="saveModels()">保存模型</button>
      <button onclick="act('testkey')">测试 key（真的发一次请求）</button>
      <span class="dim small">旧的 deepseek-chat / deepseek-reasoner 已停用，读到会自动换成 deepseek-flash。</span></div>
    <div id="toolbox" style="margin-top:12px"></div>
  </div></section>

  <section><h2>伪心跳 60 倍速</h2><div class="body">
    <div class="row">
      <label class="switch"><input type="checkbox" id="hbOn"> <b>开启</b></label>
      <label class="f" style="flex-direction:row;align-items:center;gap:6px">倍速<input type="number" id="hbSpeed" value="60" min="2" style="width:90px"></label>
      <button class="primary" onclick="saveHb()">保存</button>
      <span id="hbNow" class="dim small"></span>
    </div>
    <div class="note">它不碰播放器的 playbackRate（平台 1 秒一次的看门狗会发现，直接按回 1x），
      改为<b>替播放器把进度报上去</b>。认不认看日志里平台的回话 —— 程序不替你猜。
      <br>改了之后要<b>重跑一次驱动器</b>才生效（倍速是在启动时传给 driver.js 的）。</div>
  </div></section>

  <section><h2>本次运行账目 <span class="tag" id="accTag"></span></h2><div class="body">
    <div id="accHead" class="small dim" style="margin-bottom:8px"></div>
    <table id="accTable"><thead><tr><th>时间</th><th>章节</th><th class="num">题目</th><th class="num">填上</th><th class="num">欠</th></tr></thead><tbody></tbody></table>
    <div class="row" style="margin-top:12px">
      <button onclick="loadFile('count')">看 本次运行-题目计数.txt 原文</button>
      <button onclick="loadFile('miss')">看 本次运行-没做的题.txt</button>
      <button onclick="loadFile('record')">看 章节测验记录.txt</button>
      <button onclick="loadFile('todo')">看待办-未完成任务点.txt</button>
    </div>
    <pre id="fileview" style="margin-top:10px;display:none"></pre>
    <div class="note">填进去的都是「暂时保存」的草稿，<b>一个都没提交</b>。因为不提交，任务点在平台上不会变成已完成 —— 这是设计，不是坏了。
      <br>上面那一行会写清草稿的<b>证据等级</b>：<b>已保存</b>＝页面回了「保存成功」或按钮文字变过；<b>未确认</b>＝点了但没看到任何保存痕迹（自己瞄一眼）；<b>没保存</b>＝按钮压根没点成。<b>不会</b>因为日志里出现一句"保存"就把这一章记成平台已完成。</div>
  </div></section>

  <section><h2>实时日志 <span class="tag" id="logTag"></span></h2><div class="body">
    <pre id="log"></pre>
    <div class="row" style="margin-top:8px">
      <label class="switch"><input type="checkbox" id="autoscroll" checked> 自动刷新（3 秒）</label>
      <label class="switch"><input type="checkbox" id="follow"> 自动滚到底</label>
      <input id="filter" placeholder="只看含这些字的行（空格分开 = 任一命中）" style="width:260px">
      <button onclick="loadLog()">立即刷新</button>
      <span class="dim small">上一次刷新：<span id="logAt">—</span></span>
    </div>
    <div class="small dim" style="margin-top:6px" id="logArchive"></div>
    <div class="small dim" style="margin-top:10px">只看警告（卡住 / 断言失败 / 弹窗拦路）：</div>
    <pre id="warns" style="max-height:200px"></pre>
  </div></section>

  <section><h2>动作</h2><div class="body">
    <div class="row">
      <button onclick="act('selfcheck')">环境自检</button>
      <button onclick="act('decode')">解码乱码</button>
      <button onclick="act('testkey')">测 key</button>
      <button onclick="act('openfolder')">打开所在文件夹</button>
    </div>
    <pre id="toolout" style="margin-top:10px;display:none"></pre>
  </div></section>

</main>
<footer>
  <span>只监听本机 127.0.0.1 —— 关掉那个黑窗口，控制台就停了。</span>
  <span>入口只认本机 Host（挡域名重绑定）；每次启动随机生成 token，页面带在 X-Dsh-Console-Token 头里；POST 还要 Origin=自身 + application/json。</span>
  <span>改配置走 答题助手.js 的 saveConfig，跟命令行同一个入口。</span>
  <!-- 和文本控制台（控制台.ps1 的菜单页脚）同一句：有问题或捐款都走这个邮箱。
       口径保持一致 —— 就一句话，不啰嗦。答题用的 API 是使用者自己接的，
       key 自己填、钱自己花，不经过作者。 -->
  <!-- 【2026-10-11】照文本控制台的口径：那边是 -ForegroundColor Yellow，
       这里也必须是醒目的黄色 —— 页脚默认色是 var(--dim2) #5f6875，
       又小又暗，等于没写（实测：作者本人在页面上找了一圈没看见）。 -->
  <span style="color:#ffd479;font-size:13px">有问题或捐款请向 <a href="mailto:3975139018@qq.com" style="color:#ffd479;text-decoration:underline">3975139018@qq.com</a> 联系</span>
  <span id="footLog"></span>
</footer>
<script>
var S = null;
var lastLogKey = '';
/* __CONSOLE_TOKEN__ 是服务端在本机 GET 这个页面时注入的随机 token；
   跨源的页面读不到这份 HTML（同源策略），所以拿不到它。 */
var TOKEN = '__CONSOLE_TOKEN__';
var PAGE_SELF = '__PAGE_VERSION__';      /* 本页面被渲染时的版本（服务端填）；跟服务端当前版本比，识别旧页面 */
function $(id){ return document.getElementById(id); }
var staleWarned = false;
function tokenStale(){
  /* 【2026-10-11 补】403 的含义是"这一页的 token 已经失效"。
     控制台每次启动都会换一个随机 token，所以"重启之前打开的页面 / 书签"点按钮必然 403。
     原来这里只把 'HTTP 403' 塞进返回值，而 startEdge() 又不看它 ——
     表现出来就是"点按钮完全没反应"，用户没法自己猜到是 token 的事。 */
  if (staleWarned) return;
  staleWarned = true;
  var url = 'http://127.0.0.1:' + (location.port || '8898') + '/';
  alert('这个页面的会话已经过期了。\\n\\n控制台每次启动都会换一个随机 token，\\n所以重启之前打开的页面（或书签）点了不会有任何反应。\\n\\n请关掉本页，重新访问：\\n' + url);
  hint('会话已过期 —— 请关掉本页重新打开 ' + url);
}
function api(p, body){
  /* token 由服务端在 HTML 里注入（启动时随机生成，每次重启都变）。
     自定义请求头是这里的关键：跨源的网页发不出带自定义头的请求（过不了预检），
     所以"别的网页读 /api/state"这条路是封死的。 */
  var headers = { 'X-Dsh-Console-Token': TOKEN };
  if (body) headers['Content-Type'] = 'application/json';
  var opt = body ? {method:'POST', headers:headers, body:JSON.stringify(body)} : {headers:headers};
  return fetch(p, opt).then(function(r){
    if (r.status === 403) tokenStale();
    return r.json().catch(function(){ return { ok:false, error:'HTTP ' + r.status + '（响应不是 JSON）' }; })
      .then(function(j){
        /* 403/415/400/413 都在这里变成一句人话，页面照旧往下走（不抛）。 */
        if (!r.ok && j && !j.error) j.error = 'HTTP ' + r.status;
        return j;
      });
  }).catch(function(e){
    /* 【2026-10-11 补】fetch 自己失败（控制台没在跑 / 网络层错误）时，
       以前没有这个 catch —— Promise 静默 reject，页面上一个字都不给，
       看起来就是"点按钮没反应"。 */
    var m = (e && e.message) ? e.message : String(e);
    hint('连不上控制台：' + m + ' —— 那个「学习通助手 - 网页控制台」窗口还开着吗？');
    return { ok:false, error:'连不上控制台' };
  });
}
function esc(s){
  return String(s===undefined||s===null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function hint(t){ $('hint').textContent = t || ''; if(t) setTimeout(function(){ $('hint').textContent=''; }, 5000); }
function humanSec(n){
  if (n === null || n === undefined || isNaN(n)) return '—';
  n = Number(n);
  if (n < 90) return n + ' 秒前';
  if (n < 5400) return Math.round(n / 60) + ' 分钟前';
  if (n < 172800) return (n / 3600).toFixed(1) + ' 小时前';
  return Math.round(n / 86400) + ' 天前';
}

function cls(el, c, base){ el.className = (base || 'pill') + ' ' + c; }

function refresh(){
  return api('/api/state').then(function(s){
    S = s;
  /* 页面是不是旧的？旧页面里烙着的版本号跟服务端当前的不一致 —— 顶上一条红条，
     别让人对着老界面找新功能（今天为这个来回折腾了好几次）。 */
  try {
    var staleEl = $('stale');
    if (staleEl) staleEl.style.display = (s.pageVersion && PAGE_SELF && s.pageVersion !== PAGE_SELF) ? 'block' : 'none';
  } catch (e) {}
    var live = s.live;
    var hbTxt = s.heartbeat.exists ? (humanSec(s.heartbeat.ageSec) + '写过日志') : '还没有日志';
    var HB = { running:['运行中','ok'], stalled:['卡住了？','warn'], wrapping:['外套在跑','ok'], idle:['未运行','idle'] };
    var hbv = HB[live] || HB.idle;
    $('hb').innerHTML = esc(hbv[0]) + ' <span class="dim" style="font-weight:400">' + esc(hbTxt) + '</span>';
    cls($('hb'), hbv[1]);

    /* 驱动器状态一律看 running（= 活着 **且** 身份核对过），不是裸 alive。
       "活着但身份对不上"要写出来 —— 那是陈旧的 运行中.pid 指向了别人的进程。 */
    var drvTxt;
    if (s.driver.running) drvTxt = 'PID ' + s.driver.pid + '（已核对）';
    else if (s.driver.alive) drvTxt = 'PID ' + s.driver.pid + ' 身份对不上，不认它';
    else if (s.driver.pid) drvTxt = 'PID ' + s.driver.pid + ' 已退出';
    else drvTxt = '没在跑';
    $('drv').innerHTML = '驱动器 ' + esc(drvTxt);
    cls($('drv'), s.driver.running ? 'ok' : (s.driver.alive ? 'warn' : 'idle'));
    $('drv').title = s.driver.reason || '';

    var stale = !!s.actStale;
    var empty = !!(s.log && s.log.empty);
    var st = s.acc.totals || {};
    var num = function(v){ return (v === null || v === undefined || isNaN(v)) ? '—' : v; };

    /* —— 仪表盘 —— */
    var HERO = { running:['运行中','ok'], stalled:['可能卡住了','warn'], wrapping:['外套在跑','ok'], idle:['未运行','idle'] };
    var hv = HERO[live] || HERO.idle;
    var staleMark = (empty ? '' : (stale ? ' · 显示的是上一轮' : ''));
    $('heroState').innerHTML = esc(hv[0]) + staleMark
      + ((s.proc && s.proc.ready === false) ? ' <span class="warnt" title="没有它就不会去动任何进程 —— 宁可不动也不误杀">进程模块缺失</span>' : '');
    cls($('heroState'), hv[1], 'hero-state');
    $('heroChap').textContent = s.act.chapter ? ((stale && !empty) ? ('（上轮）' + s.act.chapter) : s.act.chapter) : '还没开始';
    $('heroChap').className = 'hero-chap' + (!s.act.chapter ? ' dim' : '');
    /* —— 现在在干什么 ——
       章节 + 相位 + 测验题数 + 草稿保存状态（保存中/已保存/未确认）。
       log.empty 时界面不写「（上轮）」，也不显示上一轮的章节。 */
    $('heroPhase').textContent = empty
      ? '点「开始 / 继续」就开跑。'
      : ((stale ? '上一轮：' : '') + (s.actText || s.act.detail || '还没有可读的进度'));

    $('stFound').textContent = num(st.found);
    $('stFilled').textContent = num(st.filled);
    $('stMissed').textContent = num(st.missed);

    if (!stale && s.act.video && s.act.video.pct){
      $('bar').style.width = Math.max(0, Math.min(100, Number(s.act.video.pct))) + '%';
      $('vidnum').textContent = s.act.video.cur + ' / ' + s.act.video.dur + '　' + s.act.video.pct + '%'
        + (s.act.video.rate ? ('　倍速 ' + s.act.video.rate) : '');
    } else {
      $('bar').style.width = '0%';
      $('vidnum').textContent = s.act.doc ? ('文档读到 ' + s.act.doc.pct + '%') : '没有在播的视频';
    }

    $('mPort').innerHTML = s.edge.up
      ? ('<span class="okt">在</span>　' + esc(s.edge.browser || ('端口 ' + s.edge.port)))
      : ('<span class="dim">不在（点「开浏览器并开始」会开自己的一个）</span>');
    $('mDrv').innerHTML = s.driver.running
      ? ('<span class="okt">PID ' + s.driver.pid + '</span>')
      : (s.driver.alive
          ? ('<span class="warnt" title="' + esc(s.driver.reason || '') + '">身份对不上，不认</span>')
          : '<span class="dim">没在跑</span>');
    /* 日志这一栏要说清"这份日志是哪一轮的" —— 归档之后日志不再跨轮累积，
       上一轮的全文在 日志\ 里（保留最近 N 份）。 */
    $('mLog').innerHTML = s.heartbeat.exists
      ? (esc(s.heartbeat.mtime) + '　' + Math.round(s.heartbeat.size/1024) + ' KB'
         + (s.log ? ('　<span class="dim">' + (s.log.empty ? '本轮还是空的' : (s.log.stale ? '上一轮留下的' : '本轮'))
                    + (s.log.runStartedAt ? ('　本轮起于 ' + esc(s.log.runStartedAt)) : '') + '</span>') : ''))
      : '<span class="dim">还没有 运行日志.txt</span>';
    $('mCourse').innerHTML = s.courses.lastCourseId
      ? ('courseId ' + esc(s.courses.lastCourseId) + (s.courses.urls.length ? ('　开页面时用 ' + s.courses.urls.length + ' 条') : ''))
      : '<span class="dim">还没记下课程</span>';
    $('mFont').innerHTML = s.font.ok
      ? ((s.font.matches === false)
          ? ('<span class="badt">指纹不符（' + s.font.count + ' 字）—— 对方换字体了</span>')
          : ('<span class="okt">已装</span>　' + s.font.count + ' 个替身字'))
      : ('<span class="warnt">' + esc(s.font.note) + '</span>');
    $('suburl').textContent = s.console.url;
    document.title = (live === 'running' ? '▶ ' : (live === 'stalled' ? '⚠ ' : ''))
      + '学习通助手 · 控制台' + (s.act.chapter ? (' · ' + s.act.chapter) : '');

    var wb = $('warnbox');
    if (stale){
      /* 上一轮的警告不当现状报 —— 但也不藏起来，说清楚它是哪儿的。 */
      wb.innerHTML = s.act.lastEnd ? '<div class="note">上一轮最后跑到了「' + esc(s.act.chapter || '?') + '」，' + esc(s.act.lastEnd) + ' 收尾。要看细节去下面的实时日志。</div>' : '';
    } else if (s.act.stuckSec && s.act.stuckAt){
      wb.innerHTML = '<div class="note" style="border-left-color:#ffc857">最后一条卡顿警告：已经 ' + s.act.stuckSec + ' 秒没有任何进展（' + esc(s.act.stuckDoing||'') + '）　' + esc(s.act.stuckAt) + '</div>';
    } else if (s.act.lastFail){
      wb.innerHTML = '<div class="note" style="border-left-color:#ff6b6b">' + (stale ? '上一轮报错：' : '最后一条报错：')
        + esc(s.act.lastFail) + '　' + esc(s.act.lastFailAt) + '</div>';
    } else { wb.innerHTML = ''; }

    var jb = $('jobbox');
    if (s.job){
      jb.style.display = 'block';
      jb.innerHTML = '<b>' + esc(s.job.name) + '</b>　' + esc(s.job.detail) + ' <span class="dim">(' + esc(s.job.at) + ')</span>';
      jb.style.borderLeftColor = s.job.status === 'fail' ? '#ff6b6b' : (s.job.status === 'done' ? '#3ddc84' : '#ffc857');
    } else { jb.style.display = 'none'; }

    $('s-key').textContent = s.cfg.keyMask;
    $('s-keyfrom').textContent = s.cfg.keyFrom + (s.cfg.hasKey ? '' : '（模式 3 用不了）');
    if ($('s-apiurl')) $('s-apiurl').textContent = (s.cfg.apiUrlShown || '') + (s.cfg.apiUrlIsDefault ? '（默认）' : '');

    $('mode').value = String(s.cfg.mode);
    $('modeDesc').textContent = s.cfg.modeName || '';
    $('readMode').value = s.cfg.readMode;
    $('readModeDesc').textContent = s.cfg.readModeName || '';
    $('maxPerChapter').value = s.cfg.maxPerChapter;
    $('autoFill').value = s.cfg.autoFill ? '1' : '0';
    $('stopAtQuiz').value = s.cfg.stopAtQuiz ? '1' : '0';
    if ($('useAI')) $('useAI').value = s.cfg.useAI ? '1' : '0';
    if ($('useBank')) $('useBank').value = s.cfg.useBank ? '1' : '0';
    $('maxShots').value = s.cfg.maxShots;
    $('model').value = s.cfg.model;
    $('visionModel').value = s.cfg.visionModel;

    var hbo = s.hb.speed > 1;
    $('hbOn').checked = hbo;
    $('hbNow').textContent = hbo ? ('现在是开：' + s.hb.speed + ' 倍速') : '现在是关';

    $('accTag').textContent = s.acc.startedAt ? ('本轮启动于 ' + s.acc.startedAt + (s.acc.endedAt ? ('，结束于 ' + s.acc.endedAt) : '（还在跑）')) : '还没有账目文件';
    $('accHead').textContent = s.acc.header || '';
    var tb = $('accTable').querySelector('tbody');
    tb.innerHTML = '';
    (s.acc.rows || []).slice().reverse().forEach(function(r){
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="dim mono" style="font-size:12px">' + esc(r.at) + '</td>'
        + '<td>' + esc(r.chapter) + '</td>'
        + '<td class="num">' + r.found + '</td>'
        + '<td class="num okt">' + r.filled + '</td>'
        + '<td class="num ' + (r.missed > 0 ? 'badt' : 'dim') + '">' + r.missed + '</td>';
      tb.appendChild(tr);
    });
    if (!(s.acc.rows || []).length){
      tb.innerHTML = '<tr><td colspan="5" class="dim">' + (s.acc.emptyRun ? '这一趟还没碰到题。' : '还没有记录（开始跑之后才会有）。') + '</td></tr>';
    }
    var w = $('warns');
    w.textContent = (s.act.warns || []).join('\\n') || '（最近没有警告）';
    if (s.cfg.migrated){ $('s-keyfrom').textContent = $('s-keyfrom').textContent + '　⚠ ' + s.cfg.migrated; }
    /* 归档说明：日志不再被下一次启动删掉，旧的在 日志\ 里（保留最近 N 份）。 */
    if (s.log) {
      var arch = $('logArchive');
      if (arch) arch.textContent = '旧日志归档在 ' + s.log.dir + '\\\\，只保留最近 ' + s.log.archiveKeep + ' 份'
        + (s.log.archiveName ? ('（本轮之前那一份：' + s.log.archiveName + '）') : '')
        + '　·　本页显示的是' + (s.log.empty ? '空的本轮日志' : (s.log.stale ? '上一轮留下的日志' : '本轮日志'));
      $('footLog').textContent = '运行日志归档在 ' + s.log.dir + '，保留最近 ' + s.log.archiveKeep + ' 份'
        + (s.log.archiveName ? ('；本轮之前那一份：' + s.log.archiveName) : '')
        + (s.log.runKnown ? '' : '（还没从网页控制台开过批次）');
    }
  });
}

function saveCfg(){
  api('/api/config', {
    mode: Number($('mode').value),
    readMode: $('readMode').value,
    maxPerChapter: Number($('maxPerChapter').value),
    autoFill: $('autoFill').value === '1',
    stopAtQuiz: $('stopAtQuiz').value === '1',
    useAI: $('useAI') ? ($('useAI').value === '1') : true,
    useBank: $('useBank') ? ($('useBank').value === '1') : true,
    maxShots: Number($('maxShots').value)
  }).then(function(r){
    if (!r.ok){ alert(r.error || '保存失败'); return; }
    hint('已保存：' + (r.changed||[]).join('、'));
    refresh();
  });
}
function saveKey(){
  var k = $('apiKey').value.trim();
  var u = ($('apiUrl') && $('apiUrl').value || '').trim();
  if (!k && !u){ hint('两个框都是空的 —— 没改任何东西'); return; }
  var patch = {};
  if (k) patch.apiKey = k;
  if (u) patch.apiUrl = u;
  api('/api/config', patch).then(function(r){
    if (!r.ok){ alert(r.error || '保存失败'); return; }
    if ($('apiKey')) $('apiKey').value = '';
    if ($('apiUrl')) $('apiUrl').value = '';
    hint('已保存（' + (r.changed||[]).join('、') + '）');
    refresh();
  });
}
/* 把网关地址恢复成默认（DeepSeek 官方） */
function resetApiUrl(){
  if (!confirm('把网关地址恢复成默认（DeepSeek 官方）？')) return;
  api('/api/config', {apiUrl: ''}).then(function(r){
    hint((r.changed||[]).join('、') || '没变');
    refresh();
  });
}
function clearKey(){
  if (!confirm('确定把 答题设置.json 里的 API key 清空吗？')) return;
  api('/api/config', {deleteKey: true}).then(function(r){ hint((r.changed||[]).join('、')); refresh(); });
}
function saveModels(){
  api('/api/config', {model: $('model').value, visionModel: $('visionModel').value}).then(function(r){
    if (!r.ok){ alert(r.error || '保存失败'); return; }
    hint('已保存：' + (r.changed||[]).join('、'));
    refresh();
  });
}
function saveHb(){
  var n = $('hbOn').checked ? (Number($('hbSpeed').value) || 60) : 0;
  api('/api/config', {hbSpeed: n}).then(function(r){
    hint(r.hbChanged + ' —— 重跑一次驱动器才生效（先「停止」再「开始」）');
    refresh();
  });
}
function stopDriver(){
  if (!confirm('停止驱动器？外套也不会再自动重来（要跑就再点开始）。')) return;
  api('/api/action', {action:'stop'}).then(function(r){ hint('已下发停止指令'); setTimeout(refresh, 1200); });
}
/* 关掉浏览器：**必须**先确认（原来这个按钮一个 confirm 都没有，一下误点就全关）。
   而且服务端只会关"助手自己启动、有所有权凭据"的那个实例，
   没有凭据就什么都不关、并说明原因 —— 绝不按映像名全杀。 */
function stopEdgeBrowser(){
  if (!confirm('关掉助手自己启动的那个浏览器？\\n\\n'
             + '只会关它（独立配置目录 + 调试端口的那一个）。你其它 Edge 窗口不会被碰。\\n\\n'
             + '继续？')) {
    hint('已取消 —— 什么都没动。');
    return;
  }
  api('/api/action', {action:'stopEdge'}).then(function(r){
    if (r.error){ hint(r.error); }
    else { hint('已关：助手自己的浏览器'); }
    if (r.output){
      var out = $('toolout');
      out.style.display = 'block';
      out.textContent = r.output;
    }
    refresh();
  });
}
/* 填作业：对着「作业作答」页跑一次 填作业.js（只点「暂时保存」，绝不提交）。
   为什么要单独一个入口：驱动器只认课程学习页，作业页它不导航过去；
   而答题助手不挑页面，所以这里直接让它在那页上跑一次。
   跑几分钟，所以走 job（异步）—— 结果写在 logs\填作业.txt，页面上只显示末尾几行。 */
function homework(dry){
  var tip = dry ? '先看看那份作业有几道题（只探测，不动页面）'
                : '填这份作业：读题 → 问 AI → 勾选 → 点「暂时保存」';
  if (!dry && !confirm(tip + '。\\n\\n提交那一步永远由你自己按，程序不会碰。继续？')) return;
  hint('已下发：' + (dry ? '探测' : '填题') + '　进度看下面「最近任务」，全文在 logs\\填作业.txt');
  api('/api/action', {action:'homework', dry: !!dry}).then(function(r){
    if (r.error) { hint(r.error); return; }
    refresh();
  });
}
/* ---------------------------------------------------------------------------
 * 题库：状态 / 导出成码 / 添加码
 * -------------------------------------------------------------------------*/

function bankStatsText(r){
  var s = r.stats || {};
  if (!r.exists) return '还没有 题库.json —— 跑一次「题库.js」就能建起来；或者把别人的题库码粘进来。';
  return '条目 ' + s.entries + '：能命中页面 ' + s.usable + '｜抄录来源（默认不导出）' + s.transcribed +
    '｜没答案 ' + s.noAnswer + '｜平台官方答案 ' + s.official + '｜带图 ' + s.withImage +
    '｜答案冲突 ' + s.conflicts + '｜本地码约 ' + r.codeLen + ' 字符';
}

function bankRefresh(){
  return api('/api/bank').then(function(r){
    if (r.error) { hint('读库失败：' + r.error); }
    $('bankTag').textContent = r.exists ? ((r.stats && r.stats.entries) + ' 条') : '没装库';
    $('bankStats').textContent = bankStatsText(r);
    bankRenderLibs(r);
    /* 标签勾选框连"每个标签多少条"一起画。条数来自这次 /api/bank 的返回，
       不在 /api/state 里算 —— 免得每次轮询都去读一遍几百 KB 的库。 */
    bankTagsRender(r);
    return r;
  });
}

/* 把当前库导出成一段码 —— 显示在**导出区**（#bankoutCode），不再塞进"粘贴导入"那个框里。 */
function bankMake(){
  api('/api/bank', { make: true, lib: bankTargetName() }).then(function(r){
    if (!r.ok) { hint(r.error || '导出失败'); return; }
    var box = $('bankoutCode');
    if (box) { box.value = r.code || ''; }
    if ($('bankoutCodeInfo')) {
      $('bankoutCodeInfo').textContent = r.codeLen + ' 字符（' + ((r.codeLen / 1024).toFixed(1)) + ' KB）' +
        '　·　点框里自动全选，或按「复制这段码」';
    }
    $('bankout').style.display = 'block';
    $('bankout').textContent = '题库码已生成：' + r.codeLen + ' 字符 —— 在上面「导出的题库码」框里。\\n' +
      '把它整段发给对方，对方在控制台里粘进下面的框、点「添加题库码」就行。';
    hint('已生成题库码：' + r.codeLen + ' 字符（在导出框里）');
  });
}

/* 复制导出框里那段码 */
/* 复制导出文本（完整版存在内存里，页面上为了不卡只渲染前一段） */
function bankCopyText(){
  var t = window.__bankExportText || '';
  if (!t) { hint('还没有导出内容 —— 先导一次'); return; }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(t).then(function(){ hint('已复制 ' + t.length + ' 字符'); },
      function(){ hint('复制失败 —— 手动全选那段文本吧'); });
    return;
  }
  hint('这个浏览器不给剪贴板权限 —— 手动全选那段文本吧');
}
function bankHideText(){
  var el = $('banktext');
  if (el) { el.style.display = 'none'; el.textContent = ''; }
  if ($('bankTextInfo')) $('bankTextInfo').textContent = '';
}
/* 把一份导出文本显示到页面上（cap 字数是防止几百条的大导出把页面卡住） */
function bankShowText(text, cap){
  var el = $('banktext');
  if (!el) return;
  var full = String(text == null ? '' : text);
  var lim = cap || 60000;
  window.__bankExportText = full;
  el.style.display = 'block';
  el.textContent = (full.length > lim) ? (full.slice(0, lim) + '\\n\\n…（以下省略 ' + (full.length - lim) + ' 字符；完整内容在文件里，或按「复制这段文本」拿全文）') : full;
  if ($('bankTextInfo')) {
    $('bankTextInfo').textContent = '共 ' + full.length + ' 字符' + (full.length > lim ? ('（页面只显示前 ' + lim + '）') : '');
  }
}

/* 复制导出框里那段码（题库码） */
function bankCopyOut(){
  var t = $('bankoutCode');
  if (!t || !t.value.trim()) { hint('导出框是空的 —— 先点「把当前库导出成题库码」'); return; }
  t.select();
  var done = false;
  try { done = document.execCommand('copy'); } catch (e) { done = false; }
  if (!done && navigator.clipboard) {
    navigator.clipboard.writeText(t.value).then(function(){ hint('已复制题库码（' + t.value.length + ' 字符）'); },
      function(){ hint('复制失败 —— 手动全选复制那个框吧'); });
    return;
  }
  hint(done ? ('已复制题库码（' + t.value.length + ' 字符）') : '复制失败 —— 手动全选复制那个框吧');
}
function bankClearOut(){
  if ($('bankoutCode')) $('bankoutCode').value = '';
  if ($('bankoutCodeInfo')) $('bankoutCodeInfo').textContent = '（已清空）';
}

/* 添加一段码：服务端做的是「解码 → 合并 → 写回 题库.json」，失败会说清哪一步。 */
function bankAdd(){
  var code = ($('bankcode').value || '').trim();
  if (!code) { hint('先把题库码粘进那个框'); return; }
  api('/api/bank', { code: code, target: bankTargetName() }).then(function(r){
    if (!r.ok) { hint('没能添加：' + (r.error || '未知原因')); return; }
    $('bankout').style.display = 'block';
    $('bankout').textContent = '这段码里有 ' + r.read + ' 条（坏 ' + r.bad + '／没答案 ' + r.noAns + '）' +
      ' → 新增 ' + r.added + ' 条，合并 ' + r.merged + ' 条，冲突 ' + r.conflicted + ' 条（两份都留着）';
    hint('题库已更新：新增 ' + r.added + ' 条');
    bankRefresh();
  });
}

/* 库清单：主库 + 子库，勾选=启用（关掉的库运行时不会去查） */
function bankRenderLibs(r){
  var box = $('banklibs'); if (!box) return;
  var libs = (r && r.libs) || [];
  var sel = $('bankTarget');
  var keep = sel ? sel.value : '';
  var html = '', opts = '';
  for (var i = 0; i < libs.length; i++) {
    var L = libs[i];
    html += '<label class="librow"><input type="checkbox" data-lib="' + L.name + '"' + (L.enabled ? ' checked' : '') +
      ' onchange="bankToggle(this)"> <b>' + L.name + '</b>' + (L.main ? '（主库）' : '') +
      '　' + L.entries + ' 条' + (L.size ? ('　' + Math.round(L.size/1024) + ' KB') : '') + '</label>';
    opts += '<option value="' + L.name + '"' + (L.name === keep ? ' selected' : '') + '>' + L.name + '</option>';
  }
  box.innerHTML = html;
  if (sel) sel.innerHTML = opts;
  /* 顺手把"现在实际启用的是哪几个"写一行（勾选框之外再给个明话，省得看漏） */
  var hintEl = $('banklibhint');
  if (hintEl) {
    var on = [];
    for (var k = 0; k < libs.length; k++) if (libs[k].enabled) on.push(libs[k].name);
    hintEl.textContent = '启用中：' + (on.length ? (on.join(' / ') + (on.length >= libs.length ? '（= 全部）' : '')) : '一个都没启用（题库模式等于关着）');
  }
}
function bankToggle(el){
  var on = [];
  var all = document.querySelectorAll('#banklibs input[data-lib]');
  for (var i = 0; i < all.length; i++) if (all[i].checked) on.push(all[i].getAttribute('data-lib'));
  api('/api/bank', { enabled: on }).then(function(r){
    if (!r.ok) { hint('设置失败：' + (r.error || '')); }
    else { hint('已启用 ' + on.length + ' 个库' + (on.length >= all.length ? '（= 全部）' : '')); }
    bankRefresh();
  });
}
function bankTargetName(){
  var n = ($('bankNewLib') && $('bankNewLib').value || '').trim();
  if (n) return n;
  return ($('bankTarget') && $('bankTarget').value) || '主库';
}

/* 一键去重复：并掉"同题异号"的那些重复条目（判据只有一条，见 题库.js 的 dedupeBank） */
function bankDedupe(){
  if (!confirm('把"同一道题、不同题号"的重复条目并成一条。\\n\\n被并掉的旧键会当别名留着，以前查得到的照样查得到。继续？')) return;
  api('/api/bank', { dedupe: true, target: bankTargetName() }).then(function(r){
    if (!r.ok) { hint('去重复失败：' + (r.error || '未知原因')); return; }
    $('bankout').style.display = 'block';
    $('bankout').textContent = '去重复：' + r.before + ' 条 → ' + r.after + ' 条' +
      '（并掉 ' + r.report.merged + ' 条｜' + r.report.groups + ' 组同题异号｜保留旧键 ' + r.report.aliasesKept +
      ' 个｜并回答案 ' + r.report.answersKept + ' 条）';
    hint(r.report.merged ? ('已并掉 ' + r.report.merged + ' 条重复') : '没有发现重复 —— 库本来就是干净的');
    bankRefresh();
  });
}

/* 去杂：清掉"能证明是垃圾"的条目（测试数据 / 空壳 / 认不出），删前先备份 */
function bankClean(){
  if (!confirm('清掉"能证明是垃圾"的条目：\\n· 测试数据（假章节）\\n· 空壳（没答案也没选项）\\n· 认不出（选项全空且没有图片）\\n\\n动手前会自动留一份 .bak。继续？')) return;
  api('/api/bank', { clean: true, target: bankTargetName() }).then(function(r){
    if (!r.ok) { hint('去杂失败：' + (r.error || '未知原因')); return; }
    $('bankout').style.display = 'block';
    $('bankout').textContent = '去杂（' + r.lib + '）：' + r.before + ' 条 → ' + r.after + ' 条' +
      '（删掉 ' + r.removed + ' 条：测试数据 ' + r.r1 + '｜空壳 ' + r.r2 + '｜认不出 ' + r.r3 + '）';
    hint(r.removed ? ('已清掉 ' + r.removed + ' 条垃圾') : '没有发现垃圾 —— 库本来就是干净的');
    bankRefresh();
  });
}

/* 导出"同一道题、不同答案"的清单：**页面上直接显示文本**（可一键复制）+ 同时写文件（Excel 用） */
function bankConflicts(){
  api('/api/bank', { conflicts: true, target: bankTargetName() }).then(function(r){
    if (!r.ok) { hint('导出失败：' + (r.error || '未知原因')); return; }
    $('bankout').style.display = 'block';
    $('bankout').textContent = '冲突答案导出（' + r.lib + '）：' + r.count + ' 条\\n' +
      '文件夹：' + r.dir + '\\n  题库导出.csv（Excel 直接开）\\n  题库导出.txt（人读的）';
    bankShowText(r.text || '');
    hint(r.count ? ('导出 ' + r.count + ' 条冲突 —— 文本在下面，文件在 _导出/' + (r.dirName || '')) : '没有冲突答案（库里答案都一致）');
  });
}

/* 【按标签导出】标签表由 /api/bank 给（含每个标签的条数），这里只负责画勾选框与提交 */
function bankTagsRender(s){
  var box = $('banktags');
  if (!box) return;
  /* 标签表：优先用调用方给的（/api/bank），没有就退回状态里的 S.cfg.bankTags */
  var tags = (s && s.tags) ? s.tags : ((S && S.cfg && S.cfg.bankTags) || []);
  if (!tags.length) return;
  var counts = {};
  if (s && s.tagCounts) counts = s.tagCounts;
  else if (s && s.summary && s.summary.tagCounts) counts = s.summary.tagCounts;
  var want = [];
  try { want = JSON.parse(localStorage.getItem('bankTags') || '["conflict"]'); } catch (e) { want = ['conflict']; }
  var html = '<span style="color:#888">标签导出：</span>';
  tags.forEach(function(t){
    var on = want.indexOf(t.id) >= 0 ? ' checked' : '';
    html += '<label style="display:inline-flex;gap:4px;align-items:center;white-space:nowrap">' +
      '<input type="checkbox" class="banktag" value="' + t.id + '"' + on + '>' + t.name +
      ' <span style="color:#888">(' + (counts[t.id] == null ? '?' : counts[t.id]) + ')</span></label>';
  });
  box.innerHTML = html;
  box.querySelectorAll('.banktag').forEach(function(el){
    el.onchange = function(){
      var cur = [];
      box.querySelectorAll('.banktag').forEach(function(x){ if (x.checked) cur.push(x.value); });
      localStorage.setItem('bankTags', JSON.stringify(cur));
    };
  });
}
function bankTagsPick(){
  var out = [];
  document.querySelectorAll('#banktags .banktag').forEach(function(x){ if (x.checked) out.push(x.value); });
  return out;
}
/* 【把所选标签导成题库码】码落到「导出的题库码」框里（不是导出文本框 —— 那是人看的）。
   ★ 2026-10-12 法师："按标签导出来的应该是**可写进别的库的码**，不是那份人看的报告"。
   两样都产出，但**各归各位**：码去码框、文本去文本区、文件照写。 */
function bankExportTagsCode(){
  var tags = bankTagsPick();
  if (!tags.length){ hint('一个标签都没勾 —— 先勾几个（比如"冲突"、"官方答案"）'); return; }
  if (tags.length === document.querySelectorAll('#banktags .banktag').length) tags = ['all'];
  api('/api/bank', { exportTags: tags, asCode: true, target: bankTargetName() }).then(function(r){
    if (!r.ok){ hint('导出失败：' + (r.error || '未知原因')); return; }
    var box = $('bankoutCode');
    if (box) box.value = r.code || '';
    if ($('bankoutCodeInfo')) {
      $('bankoutCodeInfo').textContent = r.codeLen + ' 字符（' + ((r.codeLen / 1024).toFixed(1)) + ' KB）' +
        '　·　标签：' + r.tagsName +
        '　·　选中 ' + r.picked + ' 条，其中 ' + (r.picked - r.pickedNoAns) + ' 条有答案会进码' +
        (r.pickedNoAns ? ('（' + r.pickedNoAns + ' 条没答案，进不了码）') : '');
    }
    $('bankout').style.display = 'block';
    $('bankout').textContent = '已把所选标签做成题库码（' + r.codeLen + ' 字符）—— 在上面「导出的题库码」框里。\\n' +
      '人看的报告在下面的文本区；文件在 _导出/' + (r.dirName || '') + '（含 题库导出-题库码.txt）。';
    bankShowText(r.text || '');
    hint('题库码已生成（' + r.codeLen + ' 字符）—— 在「导出的题库码」框里');
  });
}

function bankTagsAll(){ document.querySelectorAll('#banktags .banktag').forEach(function(x){ x.checked = true; }); localStorage.setItem('bankTags', JSON.stringify(bankTagsPick())); }
function bankTagsNone(){ document.querySelectorAll('#banktags .banktag').forEach(function(x){ x.checked = false; }); localStorage.setItem('bankTags', JSON.stringify([])); }

/* 【导出所选标签】一个按钮两样都给（2026-10-12 法师连点两次都没拿到码 ⇒ 干脆合并）：
     · 题库码 → 「导出的题库码」框（能写进别的库的东西）
     · 报告   → 下面文本区（人看的）
     · 文件   → _导出\题库导出-…\（csv / txt / 题库码.txt）
   想只出码的，旁边还有个小按钮【只出题库码】。 */
function bankExportTags(){
  var tags = bankTagsPick();
  if (!tags.length){ hint('一个标签都没勾 —— 先勾几个（比如"冲突"、"官方答案"）'); return; }
  if (tags.length === document.querySelectorAll('#banktags .banktag').length) tags = ['all'];
  api('/api/bank', { exportTags: tags, asCode: true, target: bankTargetName() }).then(function(r){
    if (!r.ok){ hint('导出失败：' + (r.error || '未知原因')); return; }
    var box = $('bankoutCode');
    if (box) box.value = r.code || '';
    if ($('bankoutCodeInfo')) {
      $('bankoutCodeInfo').textContent = r.codeLen + ' 字符（' + ((r.codeLen / 1024).toFixed(1)) + ' KB）' +
        '　·　标签：' + r.tagsName +
        '　·　选中 ' + r.picked + ' 条，其中 ' + (r.picked - r.pickedNoAns) + ' 条有答案会进码' +
        (r.pickedNoAns ? ('（' + r.pickedNoAns + ' 条没答案，进不了码）') : '');
    }
    $('bankout').style.display = 'block';
    var per = [];
    (r.tags || []).forEach(function(id){ per.push(id + ' ' + ((r.byTag || {})[id] || 0)); });
    $('bankout').textContent = '按标签导出（' + r.lib + '）：码 ' + r.codeLen + ' 字符（在上面「导出的题库码」框里）\\n' +
      '报告 ' + r.count + ' 条（在下面文本区）｜各标签条数：' + per.join('｜') + '\\n' +
      '文件：_导出/' + (r.dirName || '') + '（题库导出.csv / 题库导出.txt / 题库导出-题库码.txt）';
    bankShowText(r.text || '');
    hint('码已生成（' + r.codeLen + ' 字符）—— 在「导出的题库码」框里；报告在下面文本区');
  });
}

function bankCopy(){
  var t = $('bankcode');
  if (!t.value) { hint('框里还没有码 —— 先按「把当前库导出成题库码」'); return; }
  t.focus();
  t.select();
  var done = false;
  try { done = document.execCommand('copy'); } catch (e) { done = false; }
  if (!done && navigator.clipboard) {
    navigator.clipboard.writeText(t.value).then(function(){ hint('已复制题库码'); },
      function(){ hint('复制失败 —— 手动全选复制那个框吧'); });
    return;
  }
  hint(done ? '已复制题库码' : '复制失败 —— 手动全选复制那个框吧');
}

function startDriver(){
  /* 「开始 / 继续」：缺 9222 时服务端会拒掉，人已经按了「开始」，看到"没启动"
     就以为坏了。所以这里对齐旧控制台的手感：缺端口就当场问一句，确认了直接往下走。

     这句询问的内容**变了**：以前是"会关掉当前所有 Edge 窗口"，因为那时真的是
     taskkill /f /im msedge.exe 全杀；现在只用一个独立配置目录开新实例，
     不动用户已经开着的窗口。 */
  var e = (S && S.edge) || null;
  if (e && e.up === false){
    if (!confirm('要让助手干活，得先有一个「带调试端口」的浏览器，现在没有。\\n\\n'
               + '点「确定」会用一个**独立的配置目录**开一个带调试端口的 Edge，'
               + '并把驱动器拉起来。\\n\\n'
               + '你其它已经开着的 Edge 窗口不会被关掉（新实例第一次要在里面登录一次学习通）。\\n\\n'
               + '继续？')) {
      hint('已取消 —— 什么都没动。');
      return;
    }
    api('/api/action', {action:'startEdge'}).then(function(r){
      hint('已开始：开独立浏览器 → 等端口 → 拉驱动器'); refresh();
    });
    return;
  }
  act('start');
}
function startEdge(){
  if (!confirm('用独立配置目录开一个带调试端口的 Edge，并启动驱动器？\\n\\n你其它 Edge 窗口不会被关掉。新实例第一次要在里面登录一次学习通。')) return;
  api('/api/action', {action:'startEdge'}).then(function(r){
    /* 【2026-10-11 补】原来这行不看 r，无论成功失败都提示"已开始" ——
       403 时用户看到"已开始"但什么都没发生，比不提示还糟。 */
    if (r.error) { hint(r.error); return; }
    hint('已开始：开独立浏览器 → 等端口 → 拉驱动器');
    refresh();
  });
}
function act(name){
  api('/api/action', {action:name}).then(function(r){
    if (r.output){
      var out = $('toolout');
      if (name === 'decode' || name === 'testkey' || name === 'selfcheck') out = $('toolbox');
      out.style.display = 'block';
      out.textContent = r.output;
      out.scrollTop = 0;
    }
    if (r.error) hint(r.error);
    refresh();
  });
}
function loadFile(key){
  /* 文件键走 URL 参数（白名单在服务端），token 仍然走请求头。 */
  api('/api/file?f=' + encodeURIComponent(key)).then(function(r){
    var box = $('fileview');
    box.style.display = 'block';
    if (!r.exists){ box.textContent = '还没有这个文件：' + r.path; return; }
    box.textContent = '—— ' + r.path + '　（' + Math.round(r.size/1024) + ' KB，最后写入 ' + r.mtime + '）\\n\\n' + (r.lines||[]).join('\\n');
    box.scrollTop = box.scrollHeight;
  });
}
function loadLog(){
  var lg = (S && S.log) || null;
  return api('/api/file?f=log').then(function(r){
    var box = $('log');
    var lines = r.lines || [];
    var f = $('filter').value.trim();
    if (f){
      var keys = f.split(/\\s+/).filter(Boolean);
      lines = lines.filter(function(l){ return keys.some(function(k){ return l.indexOf(k) >= 0; }); });
    }
    /* 标题上写清"这份日志是哪一轮的"：现在每次开始都会归档旧日志，
       所以页面里这份要么是本轮的、要么是上一轮留下的（没跑过新的）。 */
    var which = lg ? (lg.empty ? '本轮还是空的' : (lg.stale ? '上一轮留下的' : '本轮')) : '';
    $('logAt').textContent = r.exists ? (r.mtime + '　' + Math.round(r.size/1024) + ' KB') : '（文件还没有）';
    $('logTag').textContent = r.exists
      ? ('显示尾部 ' + r.lines.length + ' 行' + (which ? ('　·　' + which) : ''))
      : '还没有日志';
    if (!r.exists || (lg && lg.empty)){
      /* 空日志就是空日志：说清楚，别拿上一轮的内容来填空。 */
      if (lastLogKey !== 'empty'){ lastLogKey = 'empty'; box.textContent = '（本轮日志还是空的 —— 点上面的「开始 / 继续」跑起来就有了。旧日志在 日志\\ 目录里。）'; }
      return;
    }
    /* 只在内容真的变了才重画 —— 不然 3 秒一次的轮询会把正在选中的文字冲掉。
       顺带把警告行染色：卡住 / 断言失败 / 弹窗拦路这些，扫一眼就能看见。 */
    var key = lines.length + '|' + (lines.length ? lines[lines.length-1] : '') + '|' + f;
    if (key === lastLogKey) return;
    lastLogKey = key;
    var keep = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < lines.length; i++){
      var d = document.createElement('div');
      var t = lines[i];
      d.className = 'lg' + (/⚠/.test(t) ? ' w' : (/(✗|失败:|\[错误|错误\])/.test(t) ? ' e' : ''));
      d.textContent = t || ' ';
      frag.appendChild(d);
    }
    box.innerHTML = '';
    box.appendChild(frag);
    if ($('autoscroll').checked || $('follow').checked || keep) box.scrollTop = box.scrollHeight;
  });
}

refresh().then(loadLog);
/* 【开局也把库面板画一次】以前只在点过按钮/做过动作后才画 ⇒ 一打开页面，
   库清单和"标签导出"那排勾选框是空的（看着像坏了）。这里开局补一次（只读一次库，不轮询）。 */
refresh().then(bankRefresh).catch(function(){});
setInterval(function(){ if ($('autoscroll').checked) loadLog(); }, 3000);
setInterval(refresh, 4000);
</script></body></html>`;

/* ============================================================================
 * 七、启动
 * ==========================================================================*/

function pickPort(preferred) {
  return new Promise((resolve) => {
    const tryPort = (p, left) => {
      if (left <= 0) return resolve(0);
      const t = http.createServer();
      t.once('error', () => { t.close(); tryPort(p + 1, left - 1); });
      t.once('listening', () => { t.close(() => resolve(p)); });
      t.listen(p, '127.0.0.1');
    };
    tryPort(preferred, 30);
  });
}

function openBrowser(url) {
  const exe = findEdge();
  if (exe) { runDetached(exe, [url]); return true; }
  runDetached('cmd.exe', ['/c', 'start', '', url], { windowsVerbatimArguments: true });
  return false;
}

/* ============================================================================
 * 单实例保护（2026-10-12 加）
 *   为什么：今天同时跑着两个控制台（一个 --port=8899、一个 --open），
 *   页面来自 A 而请求落到 B ⇒ 每个按钮都过不了鉴权 ⇒ 表现就是"点了没反应"。
 *   做法：启动时先问一句"这个端口上是不是**我们自己的**控制台在跑"——
 *     是  → 不再起第二个：打印已有地址（要 --open 就顺手把页面打开），然后正常退出；
 *     不是（别的程序占着）→ 走原来的逻辑（往后找端口）。
 *   怎么认"是不是自己"：HTTP GET /api/hello —— 那是控制台专门的应答，
 *   别的程序不会冒充（也绝不因为端口被占就贸然当成自己、把你已有页面顶掉）。
 * ==========================================================================*/
function probeOwnConsole(port, cb) {
  const req = http.request({ host: '127.0.0.1', port: port, path: '/api/hello', method: 'GET', timeout: 1200 }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => {
      try {
        const j = JSON.parse(b);
        cb(!!(j && j.app === '学习通助手控制台' && j.ok), j);
      } catch (e) { cb(false, null); }
    });
  });
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} cb(false, null); });
  req.on('error', () => cb(false, null));
  req.end();
}

/* 【单实例检查要跨端口】2026-10-12 又栽一次：`--open` 默认跑 8898、我手动跑 8899，
   两条路各自只看自己的端口 ⇒ 互相看不见 ⇒ 又并存两个（一个旧代码、一个新代码），
   法师打开的是旧的那个 ⇒ "导出的题库码那个框没有出来"。
   所以现在**认一片端口**：任何一个应答"我是学习通助手控制台"就不再开新的。
   真要改端口，用 --port= 显式指定；换端口后旧的那个请用 _内部\停止.cmd 收掉。 */
const OWN_PROBE_PORTS = [WANT_PORT].concat([8898, 8899, 8900, 8901, 8902, 8903]
  .filter((p) => p !== WANT_PORT));

(async () => {
  for (const p of OWN_PROBE_PORTS) {
    const info = await new Promise((resolve) => probeOwnConsole(p, (yes, i) => resolve(yes ? i : null)));
    if (!info) continue;
    const url = 'http://127.0.0.1:' + p + '/';
    console.log('='.repeat(60));
    console.log('  已经有一个网页控制台在跑了 —— 不再开第二个。');
    console.log('  在跑的那个：' + url + (info.pid ? ('（PID ' + info.pid + '）') : ''));
    if (info.startedAt) console.log('  它启动于：' + info.startedAt);
    if (p !== WANT_PORT) {
      console.log('  （注意：它在 ' + p + ' 端口，不是本程序想用的 ' + WANT_PORT + '。');
      console.log('   本程序不再另起一个 —— 直接用上面那个地址就行。）');
    }
    console.log('  页面按钮没反应时按 Ctrl+F5 硬刷新；若那个窗口已经关了，');
    console.log('  先用 _内部\\停止.cmd 把它收干净，再启动本程序。');
    console.log('='.repeat(60));
    if (OPEN_BROWSER) openBrowser(url);
    process.exit(0);
  }

  const port = await pickPort(WANT_PORT);
  if (!port) {
    console.log('找不到能用的端口（从 ' + WANT_PORT + ' 起试了 30 个都被占了）。');
    process.exit(1);
  }
  SERVER_PORT = port;
  const url = 'http://127.0.0.1:' + port + '/';

  server.listen(port, '127.0.0.1', async () => {
    const drv = await readVerifiedDriver();
    const hb = heartbeat();
    const rp = readRunRecord();
    console.log('='.repeat(60));
    console.log('  学习通助手 · 网页控制台已启动');
    console.log('  ' + url);
    console.log('  （只监听本机 127.0.0.1，关掉这个窗口就停了）');
    console.log('  入口闸门：Host 只认 localhost/127.0.0.1/[::1]:' + port + '；');
    console.log('            POST 要 Origin=' + url.replace(/\/$/, '') + ' + application/json + 每次启动随机的 token。');
    console.log('            token 不写日志、也不在 /api/state 里回显。');
    console.log('  驱动器：' + (drv.running ? ('在跑 PID ' + drv.pid + '（身份已核对）')
      : (drv.alive ? ('PID ' + drv.pid + ' 活着但身份对不上 —— 不认') : '没在跑')));
    if (!procReady()) console.log('  进程模块：**缺 runtime-processes.js** —— 不会去停任何进程、也不会关任何浏览器。');
    console.log('  调试端口 ' + CDP_PORT + '：' + (edge.up ? '在' : '不在（点「开浏览器并开始」会开助手自己的一个）'));
    console.log('  日志归档：' + F.logDir + '\\运行日志-时间戳.txt，保留最近 ' + LOG_KEEP + ' 份'
      + (rp ? ('；本轮起于 ' + rp.startedAt) : '；还没开过批次'));
    console.log('='.repeat(60));
    if (OPEN_BROWSER) openBrowser(url);
  });

  probeEdge();
  setInterval(probeEdge, 5000);

  process.on('SIGINT', () => { console.log('\n网页控制台关闭。'); process.exit(0); });
})().catch((e) => {
  console.log('起不来：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
