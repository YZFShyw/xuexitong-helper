/*
 * 图片指纹.js —— 给图片做"字形对照表"的图片版：**不看内容，只看像素**
 *
 * 【为什么是像素而不是内容】
 *   题目里的插图/公式图，我们不需要知道"图里写的是什么"（那要 OCR / AI，贵且会错），
 *   只需要回答一个问题：**这一张和库里那张，是不是同一张？**
 *   所以做法和字体对照表一模一样：
 *     把图归一化（去纯色边 → 拉满小网格 → 16×16 灰度）= 指纹
 *     页面上的图算一次 → 跟表里的比（同一套相似度算法）→ 像就是同一张
 *   实测（2026-10-12，拿工程里的 780x1085 PNG）：
 *     同一张图重压成 JPEG(质量0.6)：相似度 0.9972
 *     同一张图缩到 60%           ：相似度 0.9453
 *     反例（左右镜像，等于另一张） ：相似度 -0.0171   ← 差得干干净净
 *
 * 【和题库怎么接】
 *   · 指纹的短 id = sha256(16×16 向量) 前 8 位 —— **由向量算出来**，所以两台机器各自算同一个 id，
 *     不需要事先商量（这是"能对得上"的关键）。
 *   · 题库条目里存的是**图片 id**（`imgIds`），不是 URL：URL 会变、会换域名，id 不会。
 *   · 对不上的时候（比如平台换过存储、图被重编码）还能退回**模糊比对**（表里有向量，NCC 一算就知道）。
 *   · 表的分享：并进题库码（`images` 段），表本身不带原图，只有 256 字节/张的向量。
 *
 * 【边界（说清）】
 *   它只回答"是不是同一张图"，**不回答"图里写的什么"**。
 *   所以：以前做过的带图题能靠它进题库免费复用；全新的带图题还得让 AI 看一次（只有第一次）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DIR = __dirname;
const TABLE_FILE = '图片对照表.json';
const GRID = 16;

/* ------------------------------------------------------------------ 纯计算（可离线测） */

/* 灰度 → 去纯色边 → 归一化到 grid×grid（0~255）。
   参数 gray/w/h 是**页面解码出来的小灰度图**（最长边 ≤ 128），所以这一步很轻。 */
function fingerprintOfGray(gray, w, h, grid) {
  const G = grid || GRID;
  if (!gray || !w || !h) return null;
  const bg = (gray[0] + gray[w - 1] + gray[(h - 1) * w] + gray[(h - 1) * w + w - 1]) / 4;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(gray[y * w + x] - bg) > 18) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }   /* 纯色图：整张当内容 */
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const out = Buffer.alloc(G * G);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      /* 面积平均（盒式降采样）：点采样会因为一个像素的抖动把指纹带跑 */
      const x0 = minX + Math.floor(gx * bw / G), x1 = minX + Math.max(Math.floor((gx + 1) * bw / G), Math.floor(gx * bw / G) + 1);
      const y0 = minY + Math.floor(gy * bh / G), y1 = minY + Math.max(Math.floor((gy + 1) * bh / G), Math.floor(gy * bh / G) + 1);
      let s = 0, n = 0;
      for (let y = y0; y < Math.min(y1, h); y++) {
        for (let x = x0; x < Math.min(x1, w); x++) { s += gray[y * w + x]; n++; }
      }
      out[gy * G + gx] = n ? Math.round(s / n) : 128;
    }
  }
  return out;
}

function ncc(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  if (!da || !db) return 0;                       /* 纯色图：没有"形状"可比 */
  return num / Math.sqrt(da * db);
}

/* id 由向量算出来 —— 两台机器各自算同一个 id，不需要事先沟通 */
function idOf(vec) {
  return crypto.createHash('sha256').update(Buffer.from(vec)).digest('hex').slice(0, 8);
}

/* ------------------------------------------------------------------ 表 */

function tablePath(dir) { return path.join(dir || DIR, TABLE_FILE); }

function emptyTable() { return { version: 1, at: '', ids: {}, urls: {}, stats: {} }; }

function loadTable(dir) {
  try {
    const p = tablePath(dir);
    if (!fs.existsSync(p)) return emptyTable();
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (!j || typeof j !== 'object') return emptyTable();
    return {
      version: 1, at: j.at || '',
      ids: (j.ids && typeof j.ids === 'object') ? j.ids : {},
      urls: (j.urls && typeof j.urls === 'object') ? j.urls : {},
      stats: (j.stats && typeof j.stats === 'object') ? j.stats : {}
    };
  } catch (e) { return emptyTable(); }
}

function saveTable(t, dir) {
  try {
    const out = {
      version: 1, at: new Date().toISOString(),
      ids: t.ids, urls: t.urls,
      stats: { ids: Object.keys(t.ids || {}).length, urls: Object.keys(t.urls || {}).length }
    };
    fs.writeFileSync(tablePath(dir), JSON.stringify(out, null, 1), 'utf8');
    return tablePath(dir);
  } catch (e) { return ''; }
}

/* 并表：按 id 取并集；同一个 URL 指向两个 id 时**保留先到的**（不是覆盖）并计数 */
function mergeTable(base, incoming) {
  const out = base && base.ids ? base : emptyTable();
  const rep = { added: 0, same: 0, urlAdded: 0, urlConflict: 0 };
  const ids = (incoming && incoming.ids) || {};
  for (const id of Object.keys(ids)) {
    if (out.ids[id]) { rep.same++; continue; }
    out.ids[id] = ids[id];
    rep.added++;
  }
  const urls = (incoming && incoming.urls) || {};
  for (const u of Object.keys(urls)) {
    if (!out.urls[u]) { out.urls[u] = urls[u]; rep.urlAdded++; }
    else if (out.urls[u] !== urls[u]) rep.urlConflict++;
  }
  return { table: out, report: rep };
}

/* 拿一个向量去表里找：先看 id 是否已知（精确），再模糊比一遍（抗重编码） */
function matchOne(vec, table, opts) {
  const o = opts || {};
  const min = (typeof o.min === 'number') ? o.min : 0.90;
  const id = idOf(vec);
  if (table && table.ids && table.ids[id]) {
    return { id: id, score: 1, exact: true, hit: true, url: '' };
  }
  let best = null, second = 0;
  for (const k of Object.keys((table && table.ids) || {})) {
    const v = Buffer.from(table.ids[k], 'base64');
    const s = ncc(vec, v);
    if (!best || s > best.score) { second = best ? best.score : 0; best = { id: k, score: s }; }
    else if (s > second) second = s;
  }
  if (!best || best.score < min) return { id: id, score: best ? best.score : 0, exact: false, url: '', fuzzy: true, hit: false };
  return { id: best.id, score: Number(best.score.toFixed(4)), exact: false, fuzzy: true, hit: true, margin: Number((best.score - second).toFixed(4)) };
}

/* ------------------------------------------------------------------ 页面里解码成灰度 */

/* 页面只干两件事：把 data: URL 的图解码、缩到最长边 ≤ 128 的灰度、返回字节。
   归一化（去边/网格）在 Node 里做 —— 那边才好测。 */
function decodeScript(dataUrl) {
  return `(async function () {
  var MAX = 128;
  function load(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('图载入失败')); };
      im.src = src;
    });
  }
  var im = null;
  try { im = await load(${JSON.stringify(dataUrl)}); } catch (e) { return { ok: false, why: '图载入失败' }; }
  var nw = im.naturalWidth || 0, nh = im.naturalHeight || 0;
  if (!nw || !nh) return { ok: false, why: '图没有尺寸' };
  var k = Math.min(1, MAX / Math.max(nw, nh));
  var w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
  var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  var ctx = cv.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);      /* 中灰垫底：透明区不偏黑 */
  ctx.drawImage(im, 0, 0, w, h);
  var d = ctx.getImageData(0, 0, w, h).data;
  var g = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) g[i] = Math.round(0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]);
  var bin = '';
  for (var o = 0; o < g.length; o += 8192) bin += String.fromCharCode.apply(null, g.subarray(o, o + 8192));
  return { ok: true, w: w, h: h, native: [nw, nh], gray: btoa(bin) };
})()`;
}

/* 取图字节：先走 Node（快、不打扰浏览器），失败再让页面代取（带登录态/同源策略那边更宽）
   ★ 实测（2026-10-12，真图 https://p.ananas.chaoxing.com/star3/origin/…png）：
     裸 fetch → **HTTP 403**；带上 `Referer: https://mooc1.chaoxing.com/` → **HTTP 200**。
     也就是说 CDN 只是防"直接盗链"，**不需要登录态**（带不带 cookie 都是 200）。
     这个头必须带 —— 不带的话"图取不下来"，图片指纹这条路整条都是废的。 */
const REFERER = 'https://mooc1.chaoxing.com/';

async function fetchImageBytes(url, opts) {
  const o = opts || {};
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    Referer: o.referer || REFERER,
    Origin: 'https://mooc1.chaoxing.com'
  };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), o.timeoutMs || 15000);
    const r = await fetch(url, { signal: ctl.signal, headers: headers });
    clearTimeout(t);
    if (r.ok) {
      const ab = await r.arrayBuffer();
      if (ab && ab.byteLength) return { ok: true, bytes: Buffer.from(ab), via: 'node' };
    }
  } catch (e) { /* 落下去试页面 */ }
  if (typeof o.ev === 'function') {
    try {
      const b64 = await o.ev(`(async function(){ const r = await fetch(${JSON.stringify(url)}, {credentials:'include'}); if(!r.ok) return null; const b = await r.blob(); return await new Promise(function(res){ const fr = new FileReader(); fr.onload = function(){ res(String(fr.result).split(',').pop()); }; fr.readAsDataURL(b); }); })()`);
      if (b64 && typeof b64 === 'string') return { ok: true, bytes: Buffer.from(b64, 'base64'), via: 'page' };
    } catch (e) { /* 两条路都不通 */ }
  }
  return { ok: false, why: '图取不下来（Node 与页面两条路都不通）' };
}

function mimeOf(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.length > 8 && buf.slice(4, 8).toString('ascii') === 'ftyp') return 'image/avif';
  return 'application/octet-stream';
}

/* 一张图 → id（并顺手把向量记进表）。已知 URL 直接返回，不再下载。 */
async function idForUrl(url, opts) {
  const o = opts || {};
  const table = o.table || loadTable(o.dir);
  if (url && table.urls[url]) return { ok: true, id: table.urls[url], cached: 'url', table: table };
  const g = await fetchImageBytes(url, o);
  if (!g.ok) return { ok: false, why: g.why };
  const dataUrl = 'data:' + mimeOf(g.bytes) + ';base64,' + g.bytes.toString('base64');
  if (typeof o.ev !== 'function') return { ok: false, why: '没有解码通道（ev）—— 页面解码才拿得到像素' };
  let d = null;
  try { d = await o.ev(decodeScript(dataUrl)); } catch (e) { return { ok: false, why: '解码失败：' + ((e && e.message) || e) }; }
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
  if (!d || !d.ok) return { ok: false, why: (d && d.why) || '解码没返回结果' };
  const gray = Buffer.from(d.gray, 'base64');
  if (gray.length !== d.w * d.h) return { ok: false, why: '灰度数据长度不对' };
  const vec = fingerprintOfGray(gray, d.w, d.h, o.grid || GRID);
  if (!vec) return { ok: false, why: '归一化失败' };
  const id = idOf(vec);
  /* 【先看是不是"已经收过的同一张"】阈值用 matchOne 的默认（0.90）——
     写 0.99 那次实测把"重压成 JPEG 的同一张图"漏掉了（jpg 掉点像素，分数就掉到 0.99 以下），
     结果同一张图被当成两张收了（表里会长出一堆近似重复）。 */
  const m = matchOne(vec, table, { min: o.dedupeMin || 0.90 });
  const useId = (m && m.hit) ? m.id : id;
  if (!table.ids[useId]) table.ids[useId] = vec.toString('base64');
  if (url) table.urls[url] = useId;
  return {
    ok: true, id: useId, via: g.via, native: d.native, grid: o.grid || GRID, table: table,
    fresh: !(m && m.hit), score: m ? m.score : 0
  };
}

module.exports = {
  GRID, TABLE_FILE, tablePath,
  fingerprintOfGray, ncc, idOf,
  emptyTable, loadTable, saveTable, mergeTable, matchOne,
  decodeScript, fetchImageBytes, mimeOf, idForUrl
};
