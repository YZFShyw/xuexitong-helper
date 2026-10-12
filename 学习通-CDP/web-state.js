'use strict';

/* 学习通助手 · 网页控制台的状态与日志纯逻辑（可离线测试）
 *
 * 这个文件把控制台里**跟 IO 无关**的那部分抽出来：
 *   ① 日志锚点的正则契约（review 第 6 条：RE.quiz 与实现脱节、正则表没人验证）
 *   ② "这一轮的日志还是上一轮的"这个判断（原来空日志会被标成「（上轮）」）
 *   ③ 「保存中 / 已保存 / 未确认」的判定（review 第 6 条后半段）
 *   ④ 开始新批次前把旧运行日志归档到 日志\，并只保留最近 N 份（review 第 8 条）
 *   ⑤ 批次记录文件（本次运行.json）—— 存档和界面都靠它区分本次/上次
 *
 * 为什么抽出来：原来的 analyzeLog 只能靠"起一个真服务器 + 读真日志"来验证，
 * 于是没人验证 —— RE.quiz 跟 driver.js 的实现脱节了很久都没被发现。
 * 下面每个纯函数都能直接喂数组/临时目录，不需要浏览器、不需要用户文件。
 *
 *     node tests/web-state.test.js
 */

const fs = require('fs');
const path = require('path');

/* ============================================================================
 * 一、编码：日志是"混合编码"的
 *
 * driver.js 写进去的是 UTF-8，而外套（驱动器循环.cmd，chcp 936）>> 进去的行
 * 是 GBK 字节 —— 同一个文件两种编码。按行判断：这一行当 UTF-8 读得通就用 UTF-8，
 * 读出一堆替换字符就退回 GBK 重解。
 * ==========================================================================*/

function decodeLineSmart(b) {
  if (!b || b.length === 0) return '';
  const asUtf8 = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
  if (asUtf8.indexOf('\uFFFD') < 0) return asUtf8;
  try { return new TextDecoder('gb18030').decode(b); } catch (e) { return asUtf8; }
}

function splitLines(buf) {
  const out = [];
  if (!buf || buf.length === 0) return out;
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { out.push(buf.subarray(start, i)); start = i + 1; }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  const lines = out.map((b) => decodeLineSmart(b).replace(/\r$/, ''));
  /* 从文件尾截出来的第一行很可能是半行、或者带着 BOM，两个都剥掉。 */
  if (lines.length) lines[0] = lines[0].replace(/^\uFEFF/, '');
  return lines;
}

function analyzeBuf(buf) { return analyzeLog(splitLines(buf)); }

/* ============================================================================
 * 二、正则契约
 *
 * 【每一条都必须对得上 driver.js / 答题助手.js 真正打出来的格式】
 * 下面每条规则后面括号里是它在 driver.js 里的出处行号（写这个文件时的版本）。
 * tests/web-state.test.js 会拿 driver.js 源码里的模板字符串实例化后再断言一遍 ——
 * 所以要改 driver.js 的日志格式，就会先在这里亮红灯，而不是等用户看着空白的
 * 「最近动作」发呆。
 * ==========================================================================*/

const RE = {
  /* [19:20:10] —— 另外还有外套写的 [2026/10/10 周六 20:23:33.68]，
     那种行我们也认（当它没有时间戳用），但**不能**把日期当时间戳取出来。 */
  ts: /^\[(\d{2}:\d{2}:\d{2})\]\s?/,
  /* driver.js:2692 log('──────── 章节：' + s.chapter + (lastChapter ? '   （上一节：…）' : '')) */
  chapter: /────────\s*章节：(.*?)(?:\s{2,}（上一节：|$)/,
  /* 答题助手.js:1657 lines.push('──────── 测验：' + chapter + '   共 ' + found + ' 题…')
     来源确实是答题助手而不是 driver.js —— 原来 review 只 grep 了 driver.js，
     所以误判成"死正则"。这条是活的：答测验时会进日志。
     另外注意：它只在**报了** found 道题时出现，found=0 时也要照实处理。 */
  quiz: /────────\s*测验：(.*?)\s{2,}共\s*(\d+)\s*题/,
  /* driver.js:3199 log('▶ 开始播放：' + chapter + '   总长 ' + hhmmss(dur) + '   倍速 ' + rate + '   静音 ' + muted) */
  playStart: /▶ 开始播放：(.*?)\s{2,}总长\s+((?:\d+:)?\d+:\d\d)/,
  /* driver.js:3204 log('  ' + hhmmss(cur) + ' / ' + hhmmss(dur) + '   ' + pct + '%   倍速 ' + rate + '   rs=' + rs) */
  playTick: /((?:\d+:)?\d+:\d\d)\s*\/\s*((?:\d+:)?\d+:\d\d)\s+([\d.]+)%\s+倍速\s+([\d.]+)\s+rs=/,
  /* driver.js:3008 log('✅ 视频播完：' + hhmmss(cur) + ' / ' + hhmmss(dur) + …)
     【这里原来对不上】实测日志里是「✅ 视频播完：--:-- / --:--（平台已把这一章标记完成）」——
     平台读不到时长时 hhmmss() 给的就是 --:--，而老正则只认 \d+:\d\d，
     于是"平台已标记完成"这种最该显示的行反而被整条丢掉。 */
  playDone: /✅ 视频播完：((?:\d+:)?\d+:\d\d|--:--)\s*\/\s*((?:\d+:)?\d+:\d\d|--:--)(（平台已把这一章标记完成）)?/,
  /* driver.js:2847 log('✅ 文档阅读到底了：' + doc.pct + '%   （' + doc.type + '）') */
  docDone: /✅ 文档阅读到底了：([\d.]+)%/,
  /* driver.js:2622 log('⚠ 已经 ' + N + ' 秒没有任何进展（最后一步：' + doing + '）…') */
  stuck: /⚠ 已经\s*(\d+)\s*秒没有任何进展（最后一步：(.*?)）/,
  /* driver.js:2455 log('⚠ 还有任务点未完成 → 点「' + btn.txt + '」@(' + x + ',' + y + ')  选择器 …') */
  workLeft: /还有\s*(\d+)\s*个任务点/,
  /* 待办文件的行格式（driver.js:248-250 recordTodo 写 待办-未完成任务点.txt 用的格式）
     —— 注意是"时间戳]  跳过：章节   原因：…"，不是 [章节] 开头。 */
  todo: /跳过：(.*?)\s{2,}原因：(.*)$/,
  /* driver.js:3241 log('驱动器结束。') */
  end: /驱动器结束。\s*$/,
  /* driver.js:220 log('✗ 驱动器半路退出（退出码 …）') / connect() 里的 log('失败: …')
     【这里原来对不上】失败行有「失败: …」（顶层）和「  ↳ 答题助手出错：…」两种，
     而老正则 /^(?:失败: |✗ )(.+)$/ 要求行首紧贴 —— 带缩进的「  ↳ …」全被丢掉。
     现在写成"箭头行（不论缩进）都算"，另外保留了 "↳ 失败: …" 这种写法。 */
  fail: /^(?:失败: |\s*↳\s*(?:失败:\s*)?|\s*✗ )(.+)$/,
  /* ---- 保存（草稿）状态的证据 ----
     来源：答题助手.js 的 saveDraftResult()（它把结论原样返回给 driver.js 打日志）。
     四条铁律（见那里的注释）：只有页面上出现**新的**保存成功提示才算"已确认保存"；
     按钮文字变化只说明"点击被接收"；点之前就存在的提示不算证据；未确认要明确说出来。

     【坑】"没保存：…" 里也含"保存"两个字，如果先判 saved 就会把失败行读成"已保存"。
     所以顺序必须是 failed → unconfirmed → saved → pending，而且每条都要求
     "已点 <怎么点的>" 这个句式（句首是"没保存："的一律先被判成失败）。 */
  draftSaved: /已点 [^\n]*?页面出现「[^」]*」/,
  /* 明确的失败：拿不到按钮 / 只有提交类按钮（闸门挡了一次点击）/ 页面函数直调抛错 */
  draftFailed: /(?:没保存：|但页面抛错：|保存出错：)/,
  /* 未确认：点了、但没有证据；或者页面回了"保存失败"类提示 */
  draftUnconfirmed: /已点 [^\n]*?(?:没能确认已保存|未能确认已保存|没能确认保存|草稿很可能没存上|没看到平台的保存成功提示|\*\*没能确认)/,
  /* 保存中：按钮文字/加载遮罩 —— **不是**存好了 */
  draftPending: /正在暂存|正在保存|保存中|看到按钮文字变成|出现了加载遮罩/,
};

/* 用来给 driver.js 的日志格式"对表"的锚点：这里写死 driver.js 里那几条模板，
   测试会把它们拿去跟 driver.js 源码里实际存在的字符串对照。 */
const ANCHOR_TEMPLATES = [
  "'──────── 章节：'",
  "'▶ 开始播放：'",
  "'✅ 视频播完：'",
  "'✅ 文档阅读到底了：'",
  "'⚠ 已经 '",
  "'驱动器结束。'",
];

/* ============================================================================
 * 三、日志 → 「现在在干什么」
 * ==========================================================================*/

const EMPTY_ANALYSIS = () => ({
  chapter: '', chapterAt: '', lastChapterDone: '',
  phase: '', phaseAt: '', detail: '',
  quizTitle: '', quizCount: 0, quizAt: '',
  video: null, doc: null,
  workLeft: 0,
  stuckSec: 0, stuckAt: '', stuckDoing: '',
  lastEnd: '', lastFail: '', lastFailAt: '',
  warns: [], lastLine: '', lastTs: '',
  /* 保存（草稿）状态：'' | 'saved' | 'pending' | 'unconfirmed' */
  draft: '', draftAt: '', draftText: '',
});

function analyzeLog(lines) {
  const s = EMPTY_ANALYSIS();
  const arr = Array.isArray(lines) ? lines : [];
  const warnBuf = [];
  for (let i = 0; i < arr.length; i++) {
    const raw = String(arr[i] === undefined || arr[i] === null ? '' : arr[i]);
    const m = raw.match(RE.ts);
    const ts = m ? m[1] : '';
    const body = m ? raw.slice(m[0].length) : raw;
    if (raw.trim()) { s.lastLine = raw.trim(); if (ts) s.lastTs = ts; }

    let x;
    if ((x = body.match(RE.chapter))) {
      s.chapter = x[1].trim(); s.chapterAt = ts; s.video = null; s.doc = null;
      /* 换章了：上一章的测验/保存状态不该跟着显示 */
      s.quizTitle = ''; s.quizCount = 0; s.draft = ''; s.draftText = '';
    } else if ((x = body.match(RE.quiz))) {
      /* 测验行**不是**"这一章做完了"的证据，只是一条事实：碰到了测验、有几道题。
         以前这里顺手把 phase 设成「测验」、detail 设成"遇到测验…"，
         而 found=0 的测验行（实测日志里就有「共 0 题」）照样这么写 ——
         于是界面上会出现"遇到测验，共 0 题"这种自己吓自己的文案。 */
      s.quizTitle = x[1].trim();
      s.quizCount = Number(x[2]);
      s.quizAt = ts;
    } else if ((x = body.match(RE.playStart))) {
      s.phase = '播放中'; s.phaseAt = ts; s.detail = '开始播放，总长 ' + x[2];
      s.video = { cur: '--:--', dur: x[2], pct: 0, rate: 0 };
    } else if ((x = body.match(RE.playTick))) {
      s.phase = '播放中'; s.phaseAt = ts;
      s.video = { cur: x[1], dur: x[2], pct: Number(x[3]), rate: Number(x[4]) };
    } else if ((x = body.match(RE.playDone))) {
      s.video = { cur: x[1], dur: x[2], pct: 100, rate: 0 };
      s.lastChapterDone = s.chapter;
      s.phase = '本节完成'; s.phaseAt = ts;
      s.detail = '视频播完 ' + x[1] + ' / ' + x[2] + (x[3] ? '（平台已把这一章标记完成）' : '');
    } else if ((x = body.match(RE.docDone))) {
      s.doc = { pct: Number(x[1]) }; s.lastChapterDone = s.chapter;
      s.phase = '文档到底'; s.phaseAt = ts; s.detail = '文档读到 ' + x[1] + '%';
    } else if ((x = body.match(RE.stuck))) {
      s.stuckSec = Number(x[1]); s.stuckAt = ts; s.stuckDoing = x[2];
    } else if ((x = body.match(RE.workLeft))) {
      s.workLeft = Number(x[1]);
    } else if (RE.end.test(body)) {
      s.phase = '已收尾'; s.phaseAt = ts; s.lastEnd = ts; s.detail = '跑完了';
    } else if ((x = body.match(RE.fail))) {
      /* 失败行要的是**最后一条**（最近一次为什么挂），所以不做去重，每见到就覆盖。 */
      s.lastFail = x[1].trim(); s.lastFailAt = ts;
    }

    /* 保存状态：三条证据都要认，而且**先后有别** ——
       "没保存"必须先判（它句子里也含"保存"两个字），然后"未确认"，
       最后才是"已保存"。同一章里后一条覆盖前一条（最近一次保存说了算）。 */
    if (RE.draftFailed.test(body)) { s.draft = 'failed'; s.draftAt = ts; s.draftText = body.trim(); }
    else if (RE.draftUnconfirmed.test(body)) { s.draft = 'unconfirmed'; s.draftAt = ts; s.draftText = body.trim(); }
    else if (RE.draftSaved.test(body)) { s.draft = 'saved'; s.draftAt = ts; s.draftText = body.trim(); }
    else if (RE.draftPending.test(body)) { s.draft = 'pending'; s.draftAt = ts; s.draftText = body.trim(); }

    if (/⚠|✗/.test(body)) warnBuf.push(raw.trim());
  }
  if (s.phase === '已收尾' && !s.chapter) s.detail = '还没开始过';
  s.warns = warnBuf.slice(-12);
  return s;
}

/* 界面上那句"现在在干什么"：把 phase / 测验 / 保存 三样拼成一句。
   刻意**不**说"平台已完成" —— 草稿是不提交的，任务点在平台上仍是未完成；
   这句里带"平台"二字的只有 driver.js 自己回报的那条（playDone 的括号）。 */
function describeAct(s) {
  const a = s || EMPTY_ANALYSIS();
  const bits = [];
  if (a.detail) bits.push(a.detail);
  if (a.quizTitle) {
    bits.push(a.quizCount > 0
      ? ('测验「' + a.quizTitle + '」共 ' + a.quizCount + ' 题')
      : ('测验栏「' + a.quizTitle + '」这轮没读到题'));
  }
  const tag = draftTag(a.draft);
  if (tag) bits.push('草稿：' + tag);
  return bits.join('　｜　');
}

const DRAFT_TAG = {
  saved: '已保存（页面回话）',
  pending: '保存中…',
  unconfirmed: '未确认（点了但没看到保存痕迹）',
  failed: '没保存（按钮没点成）',
  '': '',
};

function draftTag(v) { return DRAFT_TAG[v] || ''; }

/* ============================================================================
 * 四、这次 / 上次
 *
 * review 第 6 条的第二个毛病：界面靠 actStale 区分"这轮的"和"上轮的"，
 * 而判据是"进程没在跑且日志 25 秒没动"，跟"日志到底是不是这一轮的"没有关系 ——
 * 于是**空日志**（刚启动、还没写一个字）也会被标成「（上轮）」。
 *
 * 正确判据是批次：开始新批次时会写一个 本次运行.json 记下日志名和开始时间；
 * 之后判断只需要"日志最后写入时间 vs 批次开始时间"。
 * ==========================================================================*/

function isStaleForBatch(logMtimeMs, batchStartedAtMs) {
  if (!Number.isFinite(Number(logMtimeMs))) return { known: false, stale: false };
  const b = Number(batchStartedAtMs);
  if (!Number.isFinite(b) || b <= 0) return { known: true, stale: true };
  return { known: true, stale: Number(logMtimeMs) < b };
}

/* 空日志就是空日志：不该标"上轮"，也不该显示上一轮的章节。 */
function deriveLogView(opts) {
  const o = opts || {};
  const exists = !!o.exists;
  const hasContent = !!(o.hasContent && exists);
  const run = o.run || null;
  const staleInfo = isStaleForBatch(o.logMtimeMs, run && run.startedAtMs);
  /* 名字对得上**并且**日志确实是这批开始之后写的，才算"本轮的日志"。
     只比名字不够：批次中途重启过一次的话，名字一样但内容是上一批的。 */
  const belongsToRun = !!(run && run.sessionId && run.log && o.logName && run.log === o.logName && !staleInfo.stale);
  let stale = false;
  if (hasContent) {
    /* 有内容：只有批次记录明确说"这份日志就是本批次的"才算"本轮"；
       对不上（换过名 / 归档过 / 压根没批次记录）就按时间兜底。 */
    stale = belongsToRun ? false : (staleInfo.known ? staleInfo.stale : true);
  }
  return {
    empty: !hasContent,
    exists,
    stale,
    belongsToRun,
    label: !hasContent ? '' : (stale ? '上一轮' : '本轮'),
    runLabel: run && run.startedAt ? run.startedAt : '',
  };
}

/* ============================================================================
 * 五、批次记录：本次运行.json
 * ==========================================================================*/

const RUN_FILE_VERSION = 1;

function makeRunRecord(opts) {
  const o = opts || {};
  const now = Number.isFinite(Number(o.startedAtMs)) ? Number(o.startedAtMs) : Date.now();
  return {
    v: RUN_FILE_VERSION,
    startedAtMs: now,
    startedAt: o.startedAt || new Date(now).toLocaleString('zh-CN'),
    sessionId: o.sessionId || (now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
    log: o.log || '',
    logArchive: o.logArchive || '',
  };
}

function readRunRecord(p) {
  let raw = null;
  try { raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return null; }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || j.v !== RUN_FILE_VERSION) return null;
  if (!Number.isFinite(Number(j.startedAtMs))) return null;
  j.startedAtMs = Number(j.startedAtMs);
  return j;
}

function writeRunRecord(p, rec) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ============================================================================
 * 六、日志轮转
 *
 * review 第 8 条：原来 startDriverCore 是 `fs.unlinkSync(运行日志.txt)` ——
 * 上一轮为什么挂，下一次启动就被抹平了，事故无法复盘。
 * 现在改成归档：日志\运行日志-YYYYMMDD-HHMMSS.txt，只保留最近 N 份。
 *
 * 【安全底线】只删"日志\ 目录下、扩展名 .txt、文件名以 运行日志- 开头"的普通文件。
 * 目录不存在就一个字节都不动；符号链接、目录、别的名字一律不碰 ——
 * 不能因为一个手滑就把用户别的东西删了。
 * ==========================================================================*/

const LOG_DIR_NAME = '日志';
const LOG_ARCHIVE_PREFIX = '运行日志-';
const LOG_ARCHIVE_KEEP = 12;

function logDirOf(baseDir) { return path.join(baseDir, LOG_DIR_NAME); }

function two(n) { return String(n).padStart(2, '0'); }

/* 时间戳只用到秒。同一秒里连开两次（测试里会发生）靠"已存在就往后顺延"解决。 */
function stampFor(ms) {
  const d = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' +
    two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
}

/* 这个文件名是不是"我们自己的归档"？是 → 才允许删。 */
function isRotatableArchiveName(name) {
  const s = String(name === undefined || name === null ? '' : name);
  if (!s.startsWith(LOG_ARCHIVE_PREFIX)) return false;
  if (!s.endsWith('.txt')) return false;
  if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0) return false;
  if (s === '.' || s === '..') return false;
  return true;
}

function listArchives(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (!isRotatableArchiveName(n)) continue;
    const p = path.join(dir, n);
    let st = null;
    try { st = fs.lstatSync(p); } catch (e) { continue; }
    /* 只认普通文件：符号链接 / 目录 / 设备文件都不在删除范围内。 */
    if (!st.isFile()) continue;
    out.push({ name: n, path: p, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

/* 删到只剩 keep 份。每一步都重新核对路径（删之前再 lstat 一次），
   确保删的确实是那个符合命名规则、且就躺在 日志\ 下面的普通文件。 */
function pruneArchives(dir, keep) {
  const n = Number.isInteger(keep) && keep >= 0 ? keep : LOG_ARCHIVE_KEEP;
  const all = listArchives(dir);
  const doomed = all.slice(n);
  const removed = [];
  const failed = [];
  for (const f of doomed) {
    const expected = path.join(dir, f.name);
    if (path.resolve(f.path) !== path.resolve(expected)) { failed.push({ name: f.name, error: '路径核对不上' }); continue; }
    if (!isRotatableArchiveName(f.name)) { failed.push({ name: f.name, error: '名字不符合归档规则' }); continue; }
    let st = null;
    try { st = fs.lstatSync(f.path); } catch (e) { failed.push({ name: f.name, error: '已经不在' }); continue; }
    if (!st.isFile()) { failed.push({ name: f.name, error: '不是普通文件' }); continue; }
    try { fs.unlinkSync(f.path); removed.push(f.name); }
    catch (e) { failed.push({ name: f.name, error: (e && e.message) || String(e) }); }
  }
  return { removed, failed, kept: all.length - removed.length };
}

/* 归档一份运行日志。返回：
     { ok, action:'archived'|'skipped', reason, archive, removed, kept }
   —— 永远不抛：归档失败不能拦住"开始跑"，但要在日志里说清楚。 */
function rotateRunLog(opts) {
  const o = opts || {};
  const logPath = o.logPath;
  const dir = o.dir || (logPath ? path.dirname(logPath) : '');
  const keep = Number.isInteger(o.keep) && o.keep >= 0 ? o.keep : LOG_ARCHIVE_KEEP;
  const base = o.baseName || path.basename(logPath || '运行日志.txt').replace(/\.txt$/i, '');
  const res = { ok: true, action: 'skipped', reason: '', archive: '', removed: [], kept: 0 };

  if (!logPath) { res.ok = false; res.reason = '没有日志路径'; return res; }

  let st = null;
  try { st = fs.lstatSync(logPath); } catch (e) { res.reason = '还没有运行日志（第一次跑）'; return res; }
  if (st.isSymbolicLink && st.isSymbolicLink()) { res.ok = false; res.reason = '运行日志是个符号链接，不动它'; return res; }
  if (!st.isFile()) { res.ok = false; res.reason = '运行日志不是普通文件，不动它'; return res; }
  if (st.size === 0) { res.reason = '运行日志是空的，没什么可归档'; return res; }

  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { res.ok = false; res.reason = '建不了 日志\\ 目录：' + ((e && e.message) || e); return res; }

  const at = Number.isFinite(Number(o.atMs)) ? Number(o.atMs) : Date.now();
  let archive = '';
  for (let i = 0; i < 60 && !archive; i++) {
    const stamp = stampFor(at + i * 1000);
    const cand = path.join(dir, base + '-' + stamp + '.txt');
    if (fs.existsSync(cand)) continue;
    try {
      /* rename 优先：同盘符下是原子的，而且不用把几百 KB 读进内存。
         跨盘符（日志目录被做成挂载点时）退回 copy+truncate。 */
      fs.renameSync(logPath, cand);
      archive = cand;
    } catch (e1) {
      try {
        fs.copyFileSync(logPath, cand);
        fs.truncateSync(logPath, 0);
        archive = cand;
      } catch (e2) {
        res.ok = false;
        res.reason = '归档失败：' + ((e2 && e2.message) || e1.message || e2);
        return res;
      }
    }
  }
  if (!archive) { res.ok = false; res.reason = '归档文件名一直冲突（同一秒里启动太多次）'; return res; }

  const p = pruneArchives(dir, keep);
  res.action = 'archived';
  res.archive = archive;
  res.removed = p.removed;
  res.failed = p.failed;
  res.kept = p.kept;
  res.reason = '旧的运行日志已归档到 ' + path.basename(archive) + '，保留最近 ' + keep + ' 份。';
  return res;
}

module.exports = {
  RE,
  ANCHOR_TEMPLATES,
  decodeLineSmart,
  splitLines,
  analyzeBuf,
  analyzeLog,
  describeAct,
  draftTag,
  DRAFT_TAG,
  isStaleForBatch,
  deriveLogView,
  makeRunRecord,
  readRunRecord,
  writeRunRecord,
  RUN_FILE_VERSION,
  LOG_DIR_NAME,
  LOG_ARCHIVE_PREFIX,
  LOG_ARCHIVE_KEEP,
  logDirOf,
  stampFor,
  isRotatableArchiveName,
  listArchives,
  pruneArchives,
  rotateRunLog,
};
