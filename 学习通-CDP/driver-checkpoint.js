/* 学习通助手 · 本轮检查点（跨"外套重启"记住这一轮已经处理过什么）
 *
 * 为什么要有它（实测账）：
 *   _内部\驱动器循环.cmd 是个"自愈外套"：driver.js 一退出，它 15 秒后就把**新进程**拉起来。
 *   而 driver.js 里的去重账（这一章填过题没有 / 这一章点开过几次任务点 / 已经翻过哪些章）
 *   全在内存里，新进程一进来就是一张白纸。平台又不认「暂时保存」，
 *   所以 quizDone 永远是 false —— 结果是同一章被**再开一次测验、再截一次图、再问一次模型**，
 *   重复计费，还在限流边缘反复试探。用户"看见停了就再点一次开始"正好命中这条路径。
 *
 * 本模块只做两件事：**存**和**判断能不能复用**。判断部分（decideReuse）是纯函数，
 * 有一条不能破的底线：
 *
 *   ★ 草稿不是完成。复用的前提是「身份一致 **且** 页面当前结果经验证」。
 *     题面身份不足（读不到几道题、读不到课程）时宁可只记「待确认」，
 *     也**不能**把它当成"这章不用再看了"—— 换题了就白跳过一整章。
 *
 * 状态里不存任何凭据：没有 apiKey、没有 cookie、没有题目正文全文（只存一个身份指纹）。
 * require 时无副作用。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const FILE_PREFIX = '驱动器检查点.';
const FILE_SUFFIX = '.json';

/** 批次标识格式：只允许 [A-Za-z0-9_-]，1..64 字符（它要出现在文件名里） */
function isBatchId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

/** 生成一个新批次标识（新启动用）。外套内部重启必须沿用环境变量里的那个。 */
function newBatchId() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  const stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  return stamp + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
}

/** 环境变量里的批次标识：合法的才用，非法/缺失返回 ''（调用方自己 newBatchId） */
function batchFromEnv(env) {
  const v = String((env && env.DSH_BATCH) || '').trim();
  return isBatchId(v) ? v : '';
}

function checkpointFile(baseDir, batchId) {
  const safe = isBatchId(batchId) ? batchId : 'invalid';
  return path.join(baseDir || '.', FILE_PREFIX + safe + FILE_SUFFIX);
}

function emptyState(batchId) {
  return {
    v: SCHEMA,
    batch: batchId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chapters: {},
  };
}

/* ---------------- 题面 / 章节身份 ---------------- */

/** 稳定的短指纹（不存原文，避免把题目内容整段留在磁盘上） */
function fingerprint(s) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!str) return '';
  /* FNV-1a 32 位：够用、无依赖、结果稳定 */
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/**
 * 章节身份：课程 + 章节名 + 题面身份。
 * 缺任何一项都返回 {ok:false} —— 调用方据此只记「待确认」，不做跳过。
 */
function chapterIdentity(input) {
  const i = input || {};
  const course = String(i.courseId || '').trim();
  const chapter = String(i.chapter || '').trim();
  const quizFound = Number(i.quizFound);
  const stem = String(i.stem || '').trim();
  const nameOk = !!(course && chapter);
  /* 题面身份：有题数就算能对上"这一章这次遇到几道题"；有原文指纹更强 */
  const quizOk = Number.isInteger(quizFound) && quizFound > 0;
  if (!nameOk) {
    return { ok: false, reason: '课程号或章节名读不到（课程="' + course + '" 章节="' + chapter + '"），只能记待确认' };
  }
  if (!quizOk && !stem) {
    return { ok: false, reason: '题面身份不足（这一章这次没读到题，也没有题干指纹），只能记待确认' };
  }
  const id = [course, fingerprint(chapter), quizOk ? ('n' + quizFound) : '', stem ? fingerprint(stem) : ''].join('|');
  return { ok: true, id, course, chapter, quizFound: quizOk ? quizFound : 0, stemHash: stem ? fingerprint(stem) : '' };
}

/* ---------------- 能不能复用（纯函数） ---------------- */

/**
 * 判断一条检查点记录能不能拿来"跳过这一章"。
 *
 * entry       —— 之前存下的记录（可能来自上一次进程）
 * observed    —— 现在**实探**到的状态：{chapter, quizFound, platformDone}
 *                platformDone 必须是页面上真读到的（quizDone / 完成标记），不能是猜的
 *
 * 返回 {decision, reason}
 *   'reuse'    —— 身份一致 + 页面确认平台已完成：可以跳过重复填答
 *   'discard'  —— 现场跟记录对不上（题数变了 / 平台没做）：记录作废，重新处理
 *   'uncertain'—— 没有足够身份/证据：**不跳过**，重新探一次，并且不把它当完成
 */
function decideReuse(entry, observed) {
  const e = entry || {};
  const o = observed || {};
  /* 【带图的题：记录里没有图片指纹 → 不算可复用，重读一遍】
     图片指纹（"这张图像什么样"的短 id）是 2026-10-12 才加的字段：老记录里没有它
     ⇒ 带图的题只能按图片 URL 比身份，而 URL 换一次访问就变 ⇒ 那些题永远进不了本地题库。
     这里用"**页面上确实有图**"当闸门：只让真有图的老章节重读一次
     （只读、不问 AI、不填答案），不搞"所有老章节都重读"（那要几百章 × 几秒）。
     调用方在页面上确认过才传 o.imgNeed=true；读不到页面就不传（按老规矩走）。 */
  if (o.imgNeed) {
    return { decision: 'discard', reason: '这一章有带图的题，而记录里没有图片指纹 —— 重新读一遍把指纹补上' };
  }
  if (!e.identityOk || !e.identity) {
    return { decision: 'uncertain', reason: '记录里没有可用的题面身份（' + (e.identityWhy || '无') + '），不跳过' };
  }
  if (o.chapter && e.chapter && String(o.chapter).trim() !== String(e.chapter).trim()) {
    return { decision: 'discard', reason: '章节名对不上（记录「' + e.chapter + '」≠ 现场「' + o.chapter + '」）' };
  }
  const oFound = Number(o.quizFound);
  if (Number.isInteger(oFound) && oFound > 0 && Number(e.quizFound) > 0 && oFound !== Number(e.quizFound)) {
    return { decision: 'discard', reason: '题数变了（记录 ' + e.quizFound + ' 道，现场 ' + oFound + ' 道）——题面是新的，不能跳过' };
  }
  /* 【必须现场能看到题，才谈得上"题面身份一致"】
     页面停在"章节"栏时 .TiMu 是读不到的（quizFound=0）。那种时候只剩"平台说这章做完了"，
     而平台那个标记完全可能是**上一次会话**留下的 —— 拿它去跳过这一章，
     就等于在"这一章的题到底长什么样"没有任何现场证据的情况下放弃处理。
     所以这里从严：读不到题数 → uncertain（不跳过，下一轮重新探）。 */
  if (!(Number.isInteger(oFound) && oFound > 0)) {
    return { decision: 'uncertain', reason: '现场读不到题数（页面可能停在"章节"栏），没有题面身份可比 —— 不跳过' };
  }
  if (!o.platformDone) {
    /* 这条同样关键：草稿 ≠ 平台完成。页面上没有"做过了"的痕迹就绝不跳过。 */
    return { decision: 'uncertain', reason: '页面现在没有「平台已完成」的证据（只有草稿/暂时保存），不跳过' };
  }
  if (!e.verifiedResult) {
    return { decision: 'uncertain', reason: '记录里存的是草稿、不是平台已验证的结果，不跳过' };
  }
  return { decision: 'reuse', reason: '课程+章节+题面身份一致，且页面当前确认平台已完成' };
}

/* ---------------- 落盘的检查点 ---------------- */

const DEFAULTS = {
  saveThrottleMs: 1500,
  keepBatches: 10,
  maxAgeMs: 12 * 60 * 60 * 1000,
  log: null,
};

/**
 * 打开（或新建）本批次的检查点。
 * 返回的对象方法：
 *   get(chapter) / set(chapter, patch) / note(batchPatch) / save(force) / flush()
 *   snapshot() / file / batch / errors
 * **任何写盘失败都会记在 errors 里**，调用方要自己决定是报出来还是继续 ——
 * 但绝不允许"写失败却当成写成功了"。
 */
function openCheckpoint(baseDir, batchId, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const dir = baseDir || '.';
  const batch = isBatchId(batchId) ? batchId : newBatchId();
  const file = checkpointFile(dir, batch);
  const errors = [];
  let state = emptyState(batch);
  let dirty = false;
  let lastSave = 0;
  let pending = false;

  const logLine = (m) => { if (typeof o.log === 'function') { try { o.log(m); } catch (e) {} } };

  /* 旧文件坏了就当没有 —— 绝不让一个坏 JSON 把驱动器挡在启动之外 */
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      if (raw) {
        const loaded = JSON.parse(raw);
        if (loaded && typeof loaded === 'object' && loaded.batch === batch && loaded.chapters && typeof loaded.chapters === 'object') {
          state = loaded;
          state.v = SCHEMA;
        } else {
          logLine('（检查点文件内容跟本批次对不上，忽略它：' + file + '）');
        }
      }
    }
  } catch (e) {
    logLine('（检查点文件读不出来，从空白开始：' + ((e && e.message) || e) + '）');
  }

  function saveNow() {
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
      lastSave = Date.now();
      return { ok: true };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) {}
      const reason = (e && e.message) || String(e);
      if (errors[errors.length - 1] !== reason) errors.push(reason);
      return { ok: false, reason };
    }
  }

  function save(force) {
    if (!dirty) return { ok: true, skipped: true };
    const now = Date.now();
    if (!force && (now - lastSave) < o.saveThrottleMs) { pending = true; return { ok: true, throttled: true }; }
    pending = false;
    return saveNow();
  }

  return {
    batch,
    file,
    errors,
    get(chapter) { return state.chapters[String(chapter)] || null; },
    all() { return state.chapters; },
    set(chapter, patch) {
      const k = String(chapter);
      const cur = state.chapters[k] || {};
      state.chapters[k] = Object.assign({}, cur, patch || {}, { at: new Date().toISOString() });
      dirty = true;
      return state.chapters[k];
    },
    del(chapter) {
      const k = String(chapter);
      if (state.chapters[k]) { delete state.chapters[k]; dirty = true; return true; }
      return false;
    },
    note(patch) { state = Object.assign({}, state, patch || {}); dirty = true; },
    save,
    flush() { return save(true); },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
    hasPending() { return pending; },
  };
}

/* ---------------- 跨批次复用（外套重启） ---------------- */

/**
 * 找"同一个逻辑运行"里上一次外套重启留下的检查点。
 * 只认**时间上最近、且足够新**的那一份；一批跑完之后（超过 maxAgeMs）就不再沿用，
 * 免得几天后的一次全新运行被一堆旧记录挡住。
 */
function findRestorableBatch(baseDir, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const dir = baseDir || '.';
  const cur = String(o.currentBatch || '');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const now = Date.now();
  let best = null;
  for (const n of names) {
    if (!n.startsWith(FILE_PREFIX) || !n.endsWith(FILE_SUFFIX)) continue;
    const batch = n.slice(FILE_PREFIX.length, n.length - FILE_SUFFIX.length);
    if (!isBatchId(batch) || batch === cur) continue;
    const full = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(full); } catch (e) { continue; }
    const age = now - st.mtimeMs;
    if (o.maxAgeMs > 0 && age > o.maxAgeMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { batch, file: full, mtimeMs: st.mtimeMs, ageMs: age };
  }
  return best;
}

/** 读一份检查点（只读，不写） */
function readCheckpoint(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.chapters || typeof j.chapters !== 'object') return null;
    return j;
  } catch (e) { return null; }
}

/** 清掉过老的检查点，别让运行目录越堆越多 */
function pruneCheckpoints(baseDir, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const dir = baseDir || '.';
  const keep = Math.max(1, Number(o.keepBatches) || DEFAULTS.keepBatches);
  const cur = String(o.currentBatch || '');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { removed: [], reason: String((e && e.code) || e.message) }; }
  const items = [];
  for (const n of names) {
    if (!n.startsWith(FILE_PREFIX) || !n.endsWith(FILE_SUFFIX)) continue;
    const batch = n.slice(FILE_PREFIX.length, n.length - FILE_SUFFIX.length);
    if (!isBatchId(batch)) continue;
    const full = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(full); } catch (e) { continue; }
    items.push({ batch, file: full, mtimeMs: st.mtimeMs });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed = [];
  let kept = 0;
  for (const it of items) {
    if (it.batch === cur) continue;
    kept++;
    if (kept <= keep) continue;
    try { fs.unlinkSync(it.file); removed.push(it.batch); } catch (e) {}
  }
  return { removed, reason: '' };
}

module.exports = {
  SCHEMA,
  FILE_PREFIX,
  FILE_SUFFIX,
  isBatchId,
  newBatchId,
  batchFromEnv,
  checkpointFile,
  emptyState,
  fingerprint,
  chapterIdentity,
  decideReuse,
  openCheckpoint,
  findRestorableBatch,
  readCheckpoint,
  pruneCheckpoints,
};
