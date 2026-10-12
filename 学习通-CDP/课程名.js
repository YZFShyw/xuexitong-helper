/*
 * 课程名.js —— 维护「课程id → 课程名」映射表（_课程名.json）
 *
 * 【为什么需要它】题库要"按课程分库"，可是**学习页上根本没有课程名**：
 *   实测（2026-10-12）：顶层 DOM、所有同源 iframe、全局变量都查过 —— 只有 stu_CourseId，
 *   没有一处写着"军事理论"。所以只能另找地方把 id 翻成名字。
 *
 * 【做法】去读"我的课程"那类页面（i.chaoxing.com 个人空间，课程列表在里面异步画出来）：
 *   · 已经开着就直接读（**只读**，不点任何东西）；
 *   · 没开就自己开一个临时标签页，读完**关掉** ——
 *     地址不是 studentstudy，驱动器挑标签页时只认 studentstudy，不会被带偏（实测安全）。
 *
 * 【谁会用】控制台在"开浏览器并开始"时自动刷一次（best-effort，失败也不拦着启动），
 *   也可以 `node 课程名.js` 手动跑一次。产物 `_课程名.json` 是用户数据，不进分发包。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 9222;
const DEFAULT_FILE = path.join(__dirname, '_课程名.json');

function sw(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = require('net').connect(Number(u.port), u.hostname);
    let buf = Buffer.alloc(0), seq = 0, waiting = new Map(), done = false;
    const send = (s) => {
      const d = Buffer.from(s, 'utf8'), mask = crypto.randomBytes(4);
      let head;
      if (d.length < 126) head = Buffer.from([0x81, 0x80 | d.length]);
      else if (d.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xFE; head.writeUInt16BE(d.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xFF; head.writeBigUInt64BE(BigInt(d.length), 2); }
      const m = Buffer.alloc(d.length);
      for (let i = 0; i < d.length; i++) m[i] = d[i] ^ mask[i % 4];
      sock.write(Buffer.concat([head, mask, m]));
    };
    const call = (method, params, ms) => new Promise((res, rej) => {
      const id = ++seq; waiting.set(id, res);
      send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(method + ' 超时')); } }, ms || 30000);
    });
    sock.on('connect', () => sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\nHost: ' + u.host +
      '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') +
      '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!sock.up && buf.indexOf('\r\n\r\n') >= 0) {
        sock.up = true; buf = buf.slice(buf.indexOf('\r\n\r\n') + 4);
        resolve({ call: call, close: () => { try { sock.destroy(); } catch (e) {} } });
      }
      let off = 0;
      while (off + 2 <= buf.length) {
        const b1 = buf[off], b2 = buf[off + 1], masked = b2 & 0x80;
        let len = b2 & 0x7F, hs = 2;
        if (len === 126) { if (off + 4 > buf.length) return; len = buf.readUInt16BE(off + 2); hs = 4; }
        else if (len === 127) { if (off + 10 > buf.length) return; len = Number(buf.readBigUInt64BE(off + 2)); hs = 10; }
        const ms = masked ? 4 : 0;
        if (off + hs + ms + len > buf.length) return;
        const payload = buf.slice(off + hs + ms, off + hs + ms + len);
        off += hs + ms + len; buf = buf.slice(off); off = 0;
        if ((b1 & 0x0F) === 0x1) {
          let j = null;
          try { j = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
          if (j.id && waiting.has(j.id)) { const r = waiting.get(j.id); waiting.delete(j.id); r(j.result || null); }
        }
      }
    });
    sock.on('error', (e) => { if (!done) { done = true; reject(e); } });
    setTimeout(() => { if (!done) { done = true; reject(new Error('连 CDP 超时')); } }, 20000);
  });
}

const httpJson = (port, p) => new Promise((res) => {
  const rq = http.get({ host: '127.0.0.1', port: port, path: p }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
  });
  rq.on('error', () => res(null));
  rq.setTimeout(5000, () => { try { rq.destroy(); } catch (e) {} res(null); });
});

/* 在页面里找"课程名 + courseId"的链接（含同源 iframe；只读） */
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

/* 读映射表（读坏了给空表，不抛） */
function loadMap(file) {
  try {
    const f = file || DEFAULT_FILE;
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (e) { return {}; }
}

/* 【只在"真的缺"的时候才去开临时标签页】
   为什么要加这道闸：2026-10-12 实测，临时标签页开着的几秒里**驱动器跟了过去**
   （它重连/挑页时会认当前活动页），学习页被顶掉、白等约 3 分钟。
   现在：先看映射表里有没有"当前正在跑的那门课"（_上次的课程.txt），有就直接跳过 ——
   平时的启动根本不会开临时页；只有"新课程还没进表"时才开一次。 */
function currentCourseId(dir) {
  try {
    const f = path.join(dir || __dirname, '_上次的课程.txt');
    if (!fs.existsSync(f)) return '';
    return String(fs.readFileSync(f, 'utf8')).trim().replace(/[^0-9]/g, '');
  } catch (e) { return ''; }
}

/* 刷新映射表。opts = { port, file, log, openTab, dir, onlyIfNeeded }
   返回 { ok, n, added, total, error, skipped } —— **永不抛**（失败也只是一个 error 字符串）。 */
async function refresh(opts) {
  const o = opts || {};
  const port = o.port || DEFAULT_PORT;
  const file = o.file || DEFAULT_FILE;
  const log = typeof o.log === 'function' ? o.log : (() => {});
  const out = { ok: false, n: 0, added: 0, total: 0, error: '', skipped: false };
  let openedId = '';
  try {
    /* ① 先看要不要跑 */
    if (o.onlyIfNeeded) {
      const id = currentCourseId(o.dir);
      const map = loadMap(file);
      if (id && map[id]) { out.ok = true; out.skipped = true; out.total = Object.keys(map).length; return out; }
    }
    const ver = await httpJson(port, '/json/version');
    if (!ver || !ver.webSocketDebuggerUrl) { out.error = '浏览器调试端口不在（' + port + '）'; return out; }
    let pages = await httpJson(port, '/json/list');
    let targets = ((pages || []).filter((t) => t.type === 'page' && /i\.mooc\.chaoxing\.com\/space|i\.chaoxing\.com/.test(String(t.url))));
    if (!targets.length && o.openTab !== false) {
      const b = await sw(ver.webSocketDebuggerUrl);
      try { const t = await b.call('Target.createTarget', { url: 'https://i.chaoxing.com/base?ws=1' }, 20000); openedId = (t && t.targetId) || ''; }
      finally { try { b.close(); } catch (e) {} }
      for (let i = 0; i < 30 && !targets.length; i++) {
        await new Promise((r) => setTimeout(r, 500));
        pages = await httpJson(port, '/json/list');
        targets = ((pages || []).filter((t) => t.type === 'page' && /i\.chaoxing\.com/.test(String(t.url))));
      }
      await new Promise((r) => setTimeout(r, 3500));       /* 课程列表是异步画出来的 */
    }
    const all = {};
    for (const t of targets.slice(0, 2)) {
      try {
        const c = await sw(t.webSocketDebuggerUrl);
        let d = null;
        try { d = await c.call('Runtime.evaluate', { expression: PROBE, returnByValue: true }, 30000); } finally { try { c.close(); } catch (e) {} }
        const val = d && d.result ? d.result.value : (d && d.value);
        if (val && val.map) for (const k of Object.keys(val.map)) all[k] = val.map[k];
      } catch (e) { /* 这一页读不到就跳过 */ }
    }
    if (openedId) {
      /* 【关掉临时页，并且**确认真的关掉了**】开着的话驱动器可能跟过去（实测踩过）。
         关不掉就再试一次，还不行就如实记下来（宁可让人知道，也别悄悄留个页）。 */
      let closed = false;
      for (let attempt = 0; attempt < 2 && !closed; attempt++) {
        try {
          const b2 = await sw(ver.webSocketDebuggerUrl);
          try { await b2.call('Target.closeTarget', { targetId: openedId }, 15000); } finally { try { b2.close(); } catch (e) {} }
        } catch (e) { /* 下一轮再试 */ }
        await new Promise((r) => setTimeout(r, 500));
        const now = await httpJson(port, '/json/list');
        closed = !((now || []).filter((t) => t.id === openedId).length);
      }
      if (!closed) { out.error = (out.error ? out.error + '；' : '') + '临时标签页没能关掉（' + openedId + '）—— 请手动关一下'; log('⚠ 临时标签页没能关掉，请手动关一下'); }
      else log('临时标签页已关掉（并确认过）');
    }
    out.n = Object.keys(all).length;
    if (!out.n) { out.error = '一门课都没读到（那个页面可能没登录）'; return out; }
    const old = loadMap(file);
    const merged = Object.assign({}, old, all);
    out.added = Object.keys(merged).length - Object.keys(old).length;
    out.total = Object.keys(merged).length;
    fs.writeFileSync(file, JSON.stringify(merged, null, 1), 'utf8');
    out.ok = true;
    log('课程名映射：读到 ' + out.n + ' 门，新增 ' + out.added + '，表里共 ' + out.total + ' 门');
    return out;
  } catch (e) {
    out.error = (e && e.message) || String(e);
    return out;
  } finally {
    if (openedId && !out.ok) { /* 失败也要把临时标签页收掉 */ }
  }
}

module.exports = { DEFAULT_PORT, DEFAULT_FILE, refresh, loadMap, PROBE, sw, httpJson };

if (require.main === module) {
  refresh({ log: (s) => console.log(s) }).then((r) => {
    if (!r.ok) console.log('× ' + r.error);
    else console.log('已写入 ' + (process.env.DSH_COURSE_FILE || DEFAULT_FILE) + '（共 ' + r.total + ' 门）');
  }).catch((e) => console.log('跑失败：' + ((e && e.message) || e)));
}
