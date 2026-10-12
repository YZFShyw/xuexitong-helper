/*
 * 建参考字形.js —— 生成"平台无关的候选字位图库"（一次性，做完就随包发）。
 *
 * 为什么要这个库：
 *   学习通的替身字体是**每份卷子现生成**的（码位随机换），静态对照表只能覆盖一支。
 *   唯一的出路是运行时逐字识别："这一格画的是哪个字"。
 *   识别就要有"参照物"—— 把常用汉字的字形，用一支**本机就有的普通黑体**渲成小位图存下来。
 *   参考库跟平台无关（不依赖对方换不换字体），所以做一次长期有效。
 *
 * ★ 库必须**冻结随包发**，不要每台机器各渲一份：各机器渲染得略有差异，识别结果就会飘。
 *   冻结之后，识别只依赖"平台的字体 + 这份库"，两台机器结果一致。
 *
 * 做法：起一个独立无头 Edge（自己的端口/临时配置目录），在页面里
 *   把候选字逐个画到 canvas → 取墨水框归一化 → 16x16 灰度 → 拼成一个大二进制块。
 *
 * 用法：
 *   node 建参考字形.js              生成/覆盖 _字体\参考字形\ref-16.json.gz
 *   node 建参考字形.js --grid=24    换网格（默认 16；网格越大越准也越大）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.REF_PORT || 9224);
const gridArg = process.argv.find((a) => a.startsWith('--grid='));
const GRID = Math.max(12, Math.min(48, Number((gridArg || '').split('=')[1]) || 16));
const OUT_DIR = path.join(__dirname, '参考字形');
const OUT = path.join(OUT_DIR, 'ref-' + GRID + '.json.gz');

/* --------------------------------------------------------------- CDP 极简客户端 */
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b));
  }).on('error', rej);
});

function wsCall(wsUrl, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = require('net').connect(Number(u.port), u.hostname);
    let buf = Buffer.alloc(0), done = false;
    const fin = (v, e) => { if (done) return; done = true; try { sock.destroy(); } catch (x) {} e ? reject(e) : resolve(v); };
    const t = setTimeout(() => fin(null, new Error('CDP 超时')), timeoutMs || 900000);
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
    sock.on('connect', () => sock.write('GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\nHost: ' + u.host +
      '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') +
      '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!sock.up && buf.indexOf('\r\n\r\n') >= 0) {
        sock.up = true; buf = buf.slice(buf.indexOf('\r\n\r\n') + 4);
        send(JSON.stringify({ id: 1, method: method, params: params }));
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
        if ((b1 & 0x0F) === 0x8) return fin(null, new Error('对端关闭'));
        if ((b1 & 0x0F) === 0x1) {
          let j = null;
          try { j = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
          if (j.id === 1) { clearTimeout(t); return fin(j.error ? null : j.result, j.error ? new Error(JSON.stringify(j.error).slice(0, 200)) : null); }
        }
      }
    });
    sock.on('error', (e) => fin(null, e));
  });
}

const PAGE = (payload) => `(async function () {
  var P = ${JSON.stringify(payload)};
  var SZ = P.grid;
  async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function norm(cv) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    var d = ctx.getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return null;
    var o = document.createElement('canvas'); o.width = SZ; o.height = SZ;
    var oc = o.getContext('2d');
    oc.fillStyle = '#fff'; oc.fillRect(0, 0, SZ, SZ);          /* 白底 + 取反 = 墨水为亮 */
    oc.drawImage(cv, minX, minY, maxX - minX + 1, maxY - minY + 1, 0, 0, SZ, SZ);
    var od = oc.getImageData(0, 0, SZ, SZ).data;
    var v = new Uint8Array(SZ * SZ);
    for (var i = 0; i < SZ * SZ; i++) v[i] = 255 - od[i * 4];
    return v;
  }

  function draw(fam, ch) {
    var cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '64px "' + fam + '"';
    ctx.fillText(ch, 26, 93);
    return norm(cv);
  }

  var CAND = ['Source Han Sans CN', 'Noto Sans SC', 'Microsoft YaHei', 'SimHei', 'SimSun'];
  var used = '', inkOf = function (v) { var s = 0; for (var i = 0; i < v.length; i++) s += v[i]; return s; };
  var inkOK = function (v) { return v && inkOf(v) > 0.03 * 255 * v.length; };
  function ncc(a, b) { var n = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    var nu = 0, da = 0, db = 0;
    for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; nu += x * y; da += x * x; db += y * y; }
    return (!da || !db) ? 0 : nu / Math.sqrt(da * db); }
  /* 头几次渲染要给字体系统喘气的时间（实测：不等的话头一两次会画出空图） */
  async function drawA(fam, ch) {
    for (var a = 0; a < 6; a++) { var g = draw(fam, ch); if (g) return g; await sleep(130); }
    return null;
  }
  for (var ci = 0; ci < CAND.length; ci++) {
    var pa = await drawA(CAND[ci], '永'), pb = await drawA(CAND[ci], '木');
    if (inkOK(pa && pa) && inkOK(pb && pb) && ncc(pa, pb) < 0.97) { used = CAND[ci]; break; }
  }
  if (!used) return JSON.stringify({ ok: false, why: '找不到可用的参考字体' });

  var chars = P.chars, out = new Uint8Array(chars.length * SZ * SZ), miss = 0;
  for (var k = 0; k < chars.length; k++) {
    var g2 = await drawA(used, chars[k]);
    if (!g2) { miss++; continue; }
    out.set(g2, k * SZ * SZ);
  }
  /* 二进制转 base64（分块，别一次 apply 太多参数） */
  var bin = '';
  for (var o2 = 0; o2 < out.length; o2 += 8192) bin += String.fromCharCode.apply(null, out.subarray(o2, o2 + 8192));
  return JSON.stringify({ ok: true, refFont: used, miss: miss, data: btoa(bin) });
})()`;

function findEdge() {
  for (const c of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return '';
}

(async () => {
  /* 【--confuse】给"容易混的字"再建一份 48×48 的细库（运行时 16×16 认不准时用它再认一遍）。
     挑法：拿 16×16 全表按墨水总量排序，只跟邻居比相似度（形近字的墨量必然接近），
     挑出相似度 ≥ 0.9 的字对，再并上常用字表 —— 覆盖范围写在 字体识别.js 的注释里。 */
  const CONFUSE = process.argv.includes('--confuse');
  let chars = [];
  let refFontWanted = '';
  if (CONFUSE) {
    const FI = require(path.join(__dirname, '..', '字体识别.js'));
    const ref = FI.loadRef(GRID);
    if (!ref) { console.log('× 先跑一次 node 建参考字形.js 把 ref-' + GRID + ' 建出来'); process.exit(1); }
    const pick = FI.pickConfusable(ref, {});
    chars = pick.chars;
    refFontWanted = ref.refFont || '';
    console.log('形近字对 ' + pick.pairs + ' 组｜要细比的字共 ' + chars.length + ' 个（含常用字表）');
  } else {
    for (let c = 0x4E00; c <= 0x9FA5; c++) chars.push(String.fromCodePoint(c));
    '　 ！（）《》〈〉—…“”‘’、。；：？！·～＋－＝％＃＆＊@#%&*+-=,.;:?!()[]{}<>/\\|"\'`^~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch) => { if (chars.indexOf(ch) < 0) chars.push(ch); });
    console.log('候选字: ' + chars.length + ' 个｜网格 ' + GRID + 'x' + GRID + '（预计裸数据 ' + (chars.length * GRID * GRID / 1048576).toFixed(1) + ' MB）');
  }
  const USE_GRID = CONFUSE ? 48 : GRID;
  const OUT_FILE = CONFUSE ? path.join(OUT_DIR, 'ref-48-confuse.json.gz') : OUT;

  const exe = findEdge();
  if (!exe) { console.log('× 找不到 msedge.exe'); process.exit(1); }
  const profile = path.join(require('os').tmpdir(), 'refglyph-profile-' + process.pid);
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  try {
    let list = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { const l = JSON.parse(await get('/json/list')); if (l && l.length) { list = l; break; } } catch (e) {}
    }
    if (!list) throw new Error('无头 Edge 起不来');
    const target = list.filter((t) => t.type === 'page')[0];
    const t0 = Date.now();
    const res = await wsCall(target.webSocketDebuggerUrl, 'Runtime.evaluate',
      { expression: PAGE({ grid: USE_GRID, chars: chars.join('') }), returnByValue: true, awaitPromise: true }, 900000);
    const val = res && res.result && res.result.value;
    if (!val) throw new Error('页面没返回结果');
    const o = JSON.parse(val);
    if (!o.ok) throw new Error(o.why);
    const data = Buffer.from(o.data, 'base64');
    if (data.length !== chars.length * USE_GRID * USE_GRID) throw new Error('数据长度不对：' + data.length + '（期望 ' + (chars.length * USE_GRID * USE_GRID) + '）');
    console.log('渲染完成：参考字体 ' + o.refFont + '｜画空 ' + o.miss + ' 个｜用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');

    /* 常见字表：拿工程自己的记录当语料（异体字陷阱靠它兜底） */
    const freq = new Map();
    try {
      const rec = fs.readFileSync(path.join(ROOT, '章节测验记录.txt'), 'utf8');
      for (const ch of rec) {
        const c2 = ch.codePointAt(0);
        if (c2 < 0x3000) continue;
        freq.set(ch, (freq.get(ch) || 0) + 1);
      }
    } catch (e) { /* 没有记录也能做，只是少一层兜底 */ }
    const common = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([ch]) => ch).join('');
    console.log('常见字表: ' + common.length + ' 个（取自记录文件，按出现次数排序）');

    const pack = {
      ver: 1, grid: USE_GRID, refFont: o.refFont, at: new Date().toISOString(),
      n: chars.length, chars: chars.join(''), common: CONFUSE ? '' : common,
      data: data.toString('base64')
    };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(pack), 'utf8'), { level: 9 });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, gz);
    console.log('已写入: ' + OUT_FILE + '（' + (gz.length / 1048576).toFixed(2) + ' MB，裸数据 ' + (data.length / 1048576).toFixed(1) + ' MB）');
    console.log('sha256(库) = ' + crypto.createHash('sha256').update(gz).digest('hex').slice(0, 16) + '…');
  } finally {
    try { child.kill(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})().catch((e) => { console.log('× 失败：' + ((e && e.message) || e)); process.exit(1); });
