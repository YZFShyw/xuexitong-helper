/*
 * 字体识别.js —— 运行时把"替身字"认回"真字"（不靠 AI、不靠平台固定表）
 *
 * 【为什么必须有这个模块】
 *   学习通的 font-cxsecret 是**每份卷子现生成**的：码位随机换、字形集合不同、sha 每次都变。
 *   实测（2026-10-12 实跑取证）：
 *     页面字体 sha=8a6135f6…（34 个码位：帧帪帬帯帰…） vs 老对照表 ddfc75f9…（41 个码位：厐厙厠厦庘…）
 *     两边码位**交集 0 个**；拿老表解页面文本 → 一个替身字都认不出。
 *   所以静态表只能解它诞生的那一支 ⇒ 新卷子全部降级"截图 + AI"，连本地题库也用不上
 *   （库里是真字、页面上是替身字，指纹对不上）。
 *
 * 【这一版怎么做】
 *   1) 从页面 CSSOM 里拿到这支字体的 base64（答题助手已经在抓了）；
 *   2) 解析它的 cmap，知道要认哪些码位；
 *   3) 在**当前页面**里把这几个码位画出来（页面已经装好这支字体，直接 canvas 画就行），
 *      取墨水框归一化成 16×16 灰度 —— 这一步只看"形状"，跟字体大小/位置无关；
 *   4) 跟**冻结随包发的参考字形库**（_字体\参考字形\ref-16.json.gz，两万多个常用字）
 *      做归一化互相关（NCC）：粗筛 12×12 → 细比 16×16；
 *   5) 认出来就**按 sha 缓存**成 _字体\对照表-<sha前8>.json —— 同一份卷子下次直接查表（零成本）。
 *
 * 【三条红线（宁可不用，绝不猜）】
 *   · 每个字都要"分数够高 + 跟第二名拉开距离"，两条都满足才算认出来；
 *   · 分差小的（异体字陷阱：国/囯、未/末）在**前两名里挑更常见的那个**（常见字表来自工程自己的记录）；
 *   · 还有拿不准的 → 那个字标成"不确定"，**只要页面文本里真出现它，整页就不解码**（走截图）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DIR = __dirname;
const FONT_DIR = path.join(DIR, '_字体');
const REF_DIR = path.join(FONT_DIR, '参考字形');

const GRID = 16;                 /* 与参考库一致；改这里要同时重建库 */
const COARSE = 12;               /* 粗筛网格 */
const SCORE_MIN = 0.70;          /* 第一名至少要这么像（实测：认对的都在 0.86 以上） */
const MARGIN_MIN = 0.02;         /* 跟第二名的分差（小于它 → 标"不确定"） */
const TIEBREAK_BAND = 0.05;      /* 分差小于它 → 在"分数第一/更常见"之间做取舍 */

let REF = null;                  /* 参考库（进程内缓存） */
let REF_TRIED = false;

/* ------------------------------------------------------------------ 参考库 */

function refPath(grid) { return path.join(REF_DIR, 'ref-' + (grid || GRID) + '.json.gz'); }

function loadRef(grid) {
  if (REF && (!grid || REF.grid === grid)) return REF;
  if (grid && REF && REF.grid !== grid) { /* 换网格就重读 */ }
  else if (REF_TRIED && !grid) return REF;
  REF_TRIED = true;
  const p = refPath(grid);
  try {
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    const data = Buffer.from(j.data, 'base64');
    const n = j.n, g = j.grid;
    if (data.length !== n * g * g) return null;
    REF = {
      grid: g, n: n, chars: j.chars, refFont: j.refFont, at: j.at,
      common: new Set(String(j.common || '').split('')),
      data: data,
      vec: (i) => data.subarray(i * g * g, (i + 1) * g * g)
    };
    return REF;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------ 纯计算 */

function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  if (!da || !db) return 0;
  return num / Math.sqrt(da * db);
}

/* 16×16 灰度 → 12×12 粗筛向量（整数分块均值，跟建库/识别两边同一套算法） */
function toCoarse(v, grid, coarse) {
  const g = grid, c = coarse, out = new Float32Array(c * c);
  for (let y = 0; y < c; y++) {
    for (let x = 0; x < c; x++) {
      let s = 0, n = 0;
      for (let yy = Math.floor(y * g / c); yy < Math.floor((y + 1) * g / c); yy++) {
        for (let xx = Math.floor(x * g / c); xx < Math.floor((x + 1) * g / c); xx++) { s += v[yy * g + xx]; n++; }
      }
      out[y * c + x] = n ? s / n : 0;
    }
  }
  return out;
}

/* 【认一个字形】返回 {ch, score, second, margin, conf}
   conf=false 的那些字，运行时只要在文本里遇到就整页不解码（宁可走截图）。 */
function identifyOne(vec, ref) {
  const grid = ref.grid;
  const q12 = toCoarse(vec, grid, COARSE);
  const scored = [];
  for (let i = 0; i < ref.n; i++) scored.push([ncc(q12, toCoarse(ref.vec(i), grid, COARSE)), i]);
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, 30);
  const fine = top.map((s) => [ncc(vec, ref.vec(s[1])), s[1]]);
  fine.sort((a, b) => b[0] - a[0]);
  let first = fine[0], second = fine[1];
  const chOf = (i) => ref.chars.charAt(i);
  /* 异体字陷阱：分数第一可能是异体字（囯 vs 国）。分差小的时候，谁更常见就认谁。 */
  let tiebreak = false;
  if (second && (first[0] - second[0]) < TIEBREAK_BAND) {
    const c1 = chOf(first[1]), c2 = chOf(second[1]);
    const inC1 = ref.common.has(c1), inC2 = ref.common.has(c2);
    if (!inC1 && inC2) { const t = first; first = second; second = t; tiebreak = true; }
  }
  const ch = chOf(first[1]);
  const score = Number(first[0].toFixed(4));
  const margin = Number((first[0] - (second ? second[0] : 0)).toFixed(4));
  return {
    ch: ch, score: score, margin: margin,
    second: second ? chOf(second[1]) : '', tiebreak: tiebreak,
    /* 分差不够时**不是**判"认出"，除非是"异体字陷阱 + 已经在更常见的那个上面"——
       那是有依据的取舍（不是猜），所以放行；否则一律标"不确定"，运行时整页不用它。 */
    conf: score >= SCORE_MIN && (margin >= MARGIN_MIN || tiebreak)
  };
}

/* ------------------------------------------------------------------ TTF cmap */

function parseCmap(buf) {
  const num = buf.readUInt16BE(4);
  let cmapOff = 0;
  for (let i = 0; i < num; i++) {
    const o = 12 + i * 16;
    if (buf.toString('ascii', o, o + 4) === 'cmap') cmapOff = buf.readUInt32BE(o + 8);
  }
  if (!cmapOff) return [];
  const n = buf.readUInt16BE(cmapOff + 2);
  let best = 0, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    const pid = buf.readUInt16BE(rec), eid = buf.readUInt16BE(rec + 2), off = buf.readUInt32BE(rec + 4);
    const score = (pid === 3 && (eid === 1 || eid === 10)) ? 3 : (pid === 0 ? 2 : 1);
    if (score > bestScore) { bestScore = score; best = cmapOff + off; }
  }
  if (!best) return [];
  const fmt = buf.readUInt16BE(best);
  const out = [];
  if (fmt === 4) {
    const segX2 = buf.readUInt16BE(best + 6), segs = segX2 / 2;
    const endO = best + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let s = 0; s < segs; s++) {
      const end = buf.readUInt16BE(endO + s * 2), start = buf.readUInt16BE(startO + s * 2);
      const delta = buf.readInt16BE(deltaO + s * 2), ro = buf.readUInt16BE(rangeO + s * 2);
      if (start === 0xFFFF) continue;
      for (let c = start; c <= end && c !== 0xFFFF; c++) {
        let g = 0;
        if (ro === 0) g = (c + delta) & 0xFFFF;
        else {
          const gi = rangeO + s * 2 + ro + (c - start) * 2;
          if (gi + 2 > buf.length) continue;
          g = buf.readUInt16BE(gi);
          if (g) g = (g + delta) & 0xFFFF;
        }
        if (g) out.push(c);
      }
    }
  }
  return out;
}

/* 【红线：认出来的东西不能"就是它自己"】
   回退字体的特征就是"每个码位画出来就是它本来的字" ⇒ 识别结果大面积自我映射。
   实测（2026-10-12）：在顶层文档渲染（看不到 iframe 里的 @font-face）时，
   分数高达 0.999、解出来的文本一个字都没变 —— 这种"沉默的假成功"最危险，
   一旦拿去做答案就是错一整页。所以：自我映射超过一半 → 直接判失败，走截图。 */
function looksLikeFallback(map) {
  const keys = Object.keys(map || {});
  if (keys.length < 4) return false;
  const same = keys.filter((k) => map[k] === k).length;
  return same / keys.length > 0.5;
}

/* -------------------------------------------------------- 页面里渲染（用页面自己的字体） */
/* 注意：这段在**页面**里跑，用的是页面上已经装好的 font-cxsecret ——
   不需要重新装字体，也不需要把字体传进传去。
   ★ 必须在**声明了这支字体的那个文档**里渲染：实测（2026-10-12）在顶层文档画，
   顶层看不到 iframe 里的 @font-face，canvas 会用回退字体 —— 画出来的就是替身字本身，
   于是"认出来的"全是它自己（分数高达 0.999、解出来的文本一个字没变）。见下面的 docIndex。 */
function renderScript(codepoints, grid, opts) {
  const G = grid || GRID;
  const wantDoc = (opts && Number.isInteger(opts.docIndex)) ? opts.docIndex : -1;
  return `(async function () {
  var CP = ${JSON.stringify(codepoints)};
  var SZ = ${G};
  var WANT_DOC = ${wantDoc};          /* -1 = 自己找"哪个文档声明了 font-cxsecret" */
  async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 跟取字体时**同一套遍历顺序**（顶层 → 各层 iframe，深度优先），
     这样"第几个文档"两边对得上。 */
  function allDocs() {
    var out = [document], seen = [document];
    function walk(d, dep) {
      if (dep > 4) return;
      var fs = null; try { fs = d.querySelectorAll('iframe'); } catch (e) { return; }
      for (var i = 0; i < fs.length; i++) {
        var cd = null; try { cd = fs[i].contentDocument; } catch (e) { cd = null; }
        if (cd && cd.body && seen.indexOf(cd) < 0) { seen.push(cd); out.push(cd); walk(cd, dep + 1); }
      }
    }
    walk(document, 0);
    return out;
  }
  function docHasFont(doc) {
    var sheets = null; try { sheets = doc.styleSheets; } catch (e) { return false; }
    if (!sheets) return false;
    for (var s = 0; s < sheets.length; s++) {
      var rules = null; try { rules = sheets[s].cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (var r = 0; r < rules.length; r++) {
        var rr = rules[r];
        if (!rr || (rr.type !== 5 && !(rr.constructor && rr.constructor.name === 'CSSFontFaceRule'))) continue;
        /* 【别写花活】这里原来写的是 【rr.style.ownerNode ? … : ''】—— 那是个恒假表达式，
           于是"自己找哪个文档声明了这套字体"永远找不到，回退到顶层文档渲染，
           画出来就是替身字本身（45/45 自我映射）。
           还有一个坑：这段字符串是模板字面量，注释里**不能出现反引号**（会把模板截断）。
           就老老实实读 font-family。 */
        var fam = String(rr.style.getPropertyValue('font-family') || '').replace(/["']/g, '');
        if (fam === 'font-cxsecret') return true;
      }
    }
    return false;
  }
  function docHasQ(doc) {
    try { return doc.querySelectorAll('.TiMu, .questionLi, .question-item').length > 0; } catch (e) { return false; }
  }
  var docs = allDocs(), host = document, hostIdx = 0;
  if (WANT_DOC >= 0 && docs[WANT_DOC]) { host = docs[WANT_DOC]; hostIdx = WANT_DOC; }
  else {
    /* 优先"既有这套字体、又装着题目"的那个文档 —— 字体就是在那儿声明的 */
    for (var i2 = 0; i2 < docs.length; i2++) { if (docHasFont(docs[i2]) && docHasQ(docs[i2])) { host = docs[i2]; hostIdx = i2; break; } }
    if (host === document && !docHasFont(document)) {
      for (var i3 = 0; i3 < docs.length; i3++) { if (docHasFont(docs[i3])) { host = docs[i3]; hostIdx = i3; break; } }
    }
  }

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
    oc.fillStyle = '#fff'; oc.fillRect(0, 0, SZ, SZ);      /* 白底 + 取反 = 墨水为亮 */
    oc.drawImage(cv, minX, minY, maxX - minX + 1, maxY - minY + 1, 0, 0, SZ, SZ);
    var od = oc.getImageData(0, 0, SZ, SZ).data;
    var v = new Uint8Array(SZ * SZ);
    for (var i = 0; i < SZ * SZ; i++) v[i] = 255 - od[i * 4];
    return v;
  }

  /* 【canvas 必须建在**那个文档**里】字体是按文档注册的 */
  function draw(ch) {
    var cv = host.createElement('canvas');
    cv.width = 128; cv.height = 128;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '64px "font-cxsecret"';
    ctx.fillText(ch, 26, 93);
    return norm(cv);
  }
  /* 头几次渲染要给字体系统喘气时间（实测：不等会画出空图） */
  async function drawA(ch) {
    for (var a = 0; a < 6; a++) { var g = draw(ch); if (g) return g; await sleep(130); }
    return null;
  }
  /* 先摸一下：这个文档里的字体到底能不能画（画不出来就别往下走） */
  var probe = await drawA(String.fromCodePoint(CP[0]));
  if (!probe) return { ok: false, why: '页面上的字体画不出来（可能还没加载好）' };

  var out = new Uint8Array(CP.length * SZ * SZ), miss = [];
  for (var k = 0; k < CP.length; k++) {
    var g2 = k === 0 ? probe : await drawA(String.fromCodePoint(CP[k]));
    if (!g2) { miss.push(CP[k]); continue; }
    out.set(g2, k * SZ * SZ);
  }
  var bin = '';
  for (var o2 = 0; o2 < out.length; o2 += 8192) bin += String.fromCharCode.apply(null, out.subarray(o2, o2 + 8192));
  /* 【直接返回对象，别 JSON.stringify】驱动的 ev 是 returnByValue ——
     返回对象就拿到对象（跟 PROBE 那些探针一样）；返回字符串反而要多解一层。 */
  return { ok: true, miss: miss, docIndex: hostIdx, docs: docs.length, data: btoa(bin) };
})()`;
}

/* ------------------------------------------------------------------ 表缓存 */

function shaOf(b64) {
  return crypto.createHash('sha256').update(Buffer.from(String(b64 || ''), 'base64')).digest('hex');
}
/* dir 可选：用例要往临时目录写，别污染真的 _字体\ */
function tablePathFor(sha, dir) { return path.join(dir || FONT_DIR, '对照表-' + String(sha || '').slice(0, 8) + '.json'); }

function loadTable(sha, dir) {
  try {
    const p = tablePathFor(sha, dir);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (!j || j.sha256 !== sha || !j.map) return null;
    return j;
  } catch (e) { return null; }
}

function saveTable(t, dir) {
  try {
    const p = tablePathFor(t.sha256, dir);
    fs.writeFileSync(p, JSON.stringify(t, null, 2), 'utf8');
    return p;
  } catch (e) { return ''; }
}

/* ------------------------------------------------------------------ 对外主入口 */

/*
 * identifyFont({ b64, ev, force }) → 
 *    { ok:true, table, source:'已缓存'|'刚认出来', confident:true|false, uncertain:[…], note:'…' }
 *    { ok:false, why:'…' }
 *
 * b64 = 页面 CSSOM 里那支字体的 base64；ev = 在页面里求值的函数（答题助手的 evFn）
 */
/*
 * 【给"拿不准"的码位做一次 48×48 细比】单独抽出来，因为**两条路都要用**：
 *   ① 当场认字（下面 identifyFont 的新表路径）
 *   ② 从缓存读表（上次认的时候还没有细库，或者那次细比没跑成）
 * 实测踩过的坑（2026-10-12 监控抓到）：缓存里的表带着 conf:false 的码位，
 * 一路"已缓存：直接用了上次认出来的表 —— 但有一个拿不准的字，整页不用（走截图）"，
 * 每天早上重跑一遍还是这样 —— 因为细比只挂在新表那条路上，缓存这条路永远补不上。
 * 只重画那几个码位（几十毫秒），改的就是传进来的 table（map/conf/from）。
 */
async function refineUncertain(table, ev, opts) {
  const o = opts || {};
  const out = { refined: 0, tried: 0 };
  if (!table || !table.map || typeof ev !== 'function') return out;
  const un = Object.keys(table.map).filter((k) => table.conf && table.conf[k] === false);
  if (!un.length) return out;
  const ref48 = loadRef48();
  if (!ref48) return out;
  out.tried = un.length;
  const cps = un.map((c) => c.codePointAt(0));
  let raw = null;
  try { raw = await ev(renderScript(cps, ref48.grid, { docIndex: o.docIndex })); } catch (e) { return out; }
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
  if (!raw || !raw.ok) return out;
  const d = Buffer.from(raw.data, 'base64');
  if (d.length !== cps.length * ref48.grid * ref48.grid) return out;
  const missSet = new Set(raw.miss || []);
  table.from = table.from || {};
  un.forEach((ch, i) => {
    if (missSet.has(cps[i])) return;
    const sub = d.subarray(i * ref48.grid * ref48.grid, (i + 1) * ref48.grid * ref48.grid);
    const r2 = refineWith48(sub, ref48);
    if (!r2 || !r2.conf) return;
    table.map[ch] = r2.ch;
    table.conf[ch] = true;
    table.from[ch] = 'fine48:' + r2.margin;
    const sc = (table.scores || []).filter((s) => s.cp === cps[i])[0];
    if (sc) { sc.ch = r2.ch; sc.score = r2.score; sc.margin = r2.margin; sc.second = r2.second; sc.fine48 = true; }
    out.refined++;
  });
  return out;
}

async function identifyFont(opts) {
  const o = opts || {};
  const b64 = o.b64;
  if (!b64) return { ok: false, why: '没拿到字体（页面上没有内嵌字体）' };
  if (typeof o.ev !== 'function') return { ok: false, why: '没有给"在页面里求值"的通道（ev）' };
  const sha = o.sha || shaOf(b64);

  if (!o.force) {
    const cached = loadTable(sha);
    if (cached) {
      /* 【缓存里也可能有"拿不准"的字，先拿细库补一把再决定用不用】
         补上了 → 这张表就能用（省一次截图 + 一次 AI）；补不上 → 老实说"拿不准"。 */
      let fix = { refined: 0, tried: 0 };
      try { fix = await refineUncertain(cached, o.ev, { docIndex: o.docIndex }); } catch (e) {}
      if (fix.refined) { try { saveTable(cached); } catch (e) {} }
      const un = Object.keys(cached.map).filter((k) => cached.conf && cached.conf[k] === false);
      return {
        ok: true, table: cached, source: '已缓存', confident: un.length === 0, uncertain: un,
        note: '直接用了上次认出来的表' + (fix.refined ? ('（其中 ' + fix.refined + ' 个拿不准的字用 48×48 细比补上了）') : '')
      };
    }
  }

  const ref = loadRef(o.grid || GRID);
  if (!ref) return { ok: false, why: '缺参考字形库（_字体\\参考字形\\ref-' + GRID + '.json.gz）—— 跑一次 建参考字形.js 就有了' };

  let cps;
  try { cps = parseCmap(Buffer.from(String(b64), 'base64')); } catch (e) { return { ok: false, why: '字体解不开（base64 坏了？）' }; }
  if (!cps.length) return { ok: false, why: '这支字体里没有可用的码位' };

  let raw;
  try { raw = await o.ev(renderScript(cps, ref.grid, { docIndex: o.docIndex })); } catch (e) { return { ok: false, why: '在页面里渲染字形失败：' + ((e && e.message) || e) }; }
  /* 兼容两种返回：对象（项目的探针习惯）/ JSON 字符串（万一别处包了一层） */
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
  if (!raw || !raw.ok) return { ok: false, why: (raw && raw.why) || '页面没返回字形数据' };
  const data = Buffer.from(raw.data, 'base64');
  if (data.length !== cps.length * ref.grid * ref.grid) return { ok: false, why: '字形数据长度不对' };

  /* 认字（跳过硬件的码位用 {ch:null} 占位，保持索引对齐） */
  const missSet = new Set(raw.miss || []);
  const map = {}, conf = {}, uncertain = [], scores = [];
  for (let i = 0; i < cps.length; i++) {
    const sub = data.subarray(i * ref.grid * ref.grid, (i + 1) * ref.grid * ref.grid);
    if (missSet.has(cps[i]) || !sub.length) continue;
    const r = identifyOne(sub, ref);
    map[String.fromCodePoint(cps[i])] = r.ch;
    conf[String.fromCodePoint(cps[i])] = r.conf;
    scores.push({ cp: cps[i], ch: r.ch, score: r.score, margin: r.margin, second: r.second, tiebreak: r.tiebreak });
    if (!r.conf) uncertain.push(r.ch);
  }
  if (!Object.keys(map).length) return { ok: false, why: '一个字都没认出来' };
  if (looksLikeFallback(map)) {
    const same = Object.keys(map).filter((k) => map[k] === k).length;
    return { ok: false, why: '画出来的字形像是"回退字体"（' + same + '/' + Object.keys(map).length + ' 个自我映射），不敢用' };
  }

  /* 【16×16 认不准的那几个，用 48×48 再认一遍】
     只重画那几个码位（几十毫秒），跟"只收形近字+常用字"的细库比 —— 分辨率上去了，形近字分得开。
     合成那份细库：node _字体\建参考字形.js --confuse
     没覆盖到的字仍然保持"拿不准"（绝不猜）。 */
  const fineFrom = {};                    /* 细比补上的字 → 证据（下面并进表里） */
  let refined = 0;
  {
    /* 复用上面那个函数（新表这条路和缓存那条路走的是同一套细比，不写两遍） */
    const tmp = { map: map, conf: conf, scores: scores, from: fineFrom };
    const fix = await refineUncertain(tmp, o.ev, { docIndex: o.docIndex });
    refined = fix.refined;
  }
  if (refined) {
    uncertain.length = 0;
    uncertain.push(...Object.keys(map).filter((k) => conf[k] === false));
  }

  const table = {
    sha256: sha, map: map, conf: conf,
    at: new Date().toISOString(), method: 'render-match',
    refVer: path.basename(refPath(ref.grid)), refFont: ref.refFont,
    scores: scores, from: fineFrom
  };
  /* 【16×16 认不准的那几个，用 48×48 再认一遍】……（细比代码在上面，这里只收尾） */
  const saved = saveTable(table);
  const low = scores.filter((s) => s.score < SCORE_MIN).length;
  return {
    ok: true, table: table, source: '刚认出来', confident: uncertain.length === 0,
    uncertain: uncertain, saved: saved, scored: scores.length,
    note: '认出 ' + scores.length + ' 个字' + (low ? ('（其中 ' + low + ' 个分数偏低）') : '') +
      (uncertain.length ? ('；' + uncertain.length + ' 个拿不准（遇到就整页不解码）') : '') +
      (saved ? '（已缓存，下次同一份卷子直接查表）' : '（**缓存没写成**，下次还得再认一遍）')
  };
}

/* 【拿识别出来的表解码】返回 {text, hits, uncertain}
   uncertain>0 表示文本里碰到了"拿不准"的替身字 → 调用方**必须放弃这一页**（走截图）。 */
function decodeWith(table, s) {
  const out = { text: String(s == null ? '' : s), hits: 0, uncertain: 0 };
  if (!table || !table.map) return out;
  out.text = out.text.replace(/[\s\S]/gu, (c) => {
    const r = table.map[c];
    if (r === undefined) return c;
    if (table.conf && table.conf[c] === false) { out.uncertain++; return c; }
    out.hits++;
    return r;
  });
  return out;
}

/* ------------------------------------------------------------------ 整句对齐反推 */

/*
 * 【为什么要有这个】逐字认字形总有"拿不准"的字（实测：45 个字里 3 个；有一页就因为有 1 个，
 * 整页被拒、退回截图 + AI）。而**我们自己的记录里已经有上千道题的"真字"文本**
 * （AI 抄录来的 + DOM 解码来的）—— 拿同一道题的替身文本跟它逐字对齐，
 * 那些认不准的位置就能**直接定下来**（免费、精确、不花 AI）。
 *
 * 判据（缺一不可，宁可不补）：
 *   ① 两段文本"同长 + 大部分位置都对得上"才算对齐上（锚点 ≥ minAnchors，且错位极少）；
 *   ② 每个要补的字至少要有 minVotes 次**独立对齐**给出同一个答案（默认 2 次）；
 *   ③ 得票最多的那个还要占压倒多数（≥ 2/3），否则视为有争议，不补。
 * 就这三条 —— 认错一个字就可能填错一道题，所以宁可留着"拿不准"。
 *
 * opts = { table, texts: [页面文本…], known: [真字文本…], norm: (s)=>s, minAnchors: 0.7, minVotes: 2 }
 * 返回 { ok, added: [{sub, real, votes}], votes: {sub:{real:n}}, aligned, checked }
 */
function alignFill(opts) {
  const o = opts || {};
  const table = o.table;
  if (!table || !table.map) return { ok: false, why: '没有表' };
  const norm = (typeof o.norm === 'function') ? o.norm : ((s) => String(s == null ? '' : s));
  const minAnchors = typeof o.minAnchors === 'number' ? o.minAnchors : 0.7;
  const minVotes = typeof o.minVotes === 'number' ? o.minVotes : 2;

  const unk = new Set(Object.keys(table.map).filter((k) => table.conf && table.conf[k] === false));
  const texts = (o.texts || []).map((s) => norm(s)).filter((s) => s && s.length >= 4);
  const known = (o.known || []).map((s) => String(s == null ? '' : s)).filter((s) => s && s.length >= 4);
  if (!unk.size || !texts.length || !known.length) {
    return { ok: true, added: [], votes: {}, aligned: 0, checked: texts.length, why: !unk.size ? '没有拿不准的字' : '没有可对齐的文本' };
  }
  /* 按长度建索引：只有**同长**的两段才可能对得上（替身字与真字一一对应，长度不变） */
  const byLen = {};
  for (const k of known) (byLen[k.length] = byLen[k.length] || []).push(k);

  const votes = {};          /* sub → real → 次数 */
  let aligned = 0;
  for (const P of texts) {
    const cands = byLen[P.length] || [];
    let used = 0;
    for (const K of cands) {
      if (used >= 50) break;                       /* 同一段文本最多对 50 个候选，别把时间烧在长表上 */
      let hit = 0, miss = 0;
      for (let i = 0; i < P.length; i++) {
        const m = table.map[P[i]];
        if (m === undefined || (table.conf && table.conf[P[i]] === false)) continue;   /* 拿不准的当"没锚" */
        if (m === K[i]) hit++; else miss++;
      }
      const anchor = hit + miss;
      if (!anchor) continue;
      if (hit / anchor < minAnchors) continue;      /* 对上的比例太低 → 不是同一段 */
      if (miss > Math.max(1, Math.round(anchor * 0.05))) continue;   /* 错位太多 → 不是同一段 */
      used++;
      aligned++;
      for (let i = 0; i < P.length; i++) {
        if (!unk.has(P[i])) continue;
        const real = K[i];
        if (!real || real === P[i]) continue;
        votes[P[i]] = votes[P[i]] || {};
        votes[P[i]][real] = (votes[P[i]][real] || 0) + 1;
      }
    }
  }

  const added = [];
  for (const sub of Object.keys(votes)) {
    const tally = Object.entries(votes[sub]).sort((a, b) => b[1] - a[1]);
    const total = tally.reduce((n, x) => n + x[1], 0);
    const [real, n] = tally[0];
    if (n < minVotes) continue;                     /* 证据不够 */
    if (n / total < 2 / 3) continue;                /* 有争议 */
    added.push({ sub: sub, real: real, votes: n, total: total });
  }
  return { ok: true, added: added, votes: votes, aligned: aligned, checked: texts.length };
}

/* 把对齐结果并进表（新增的标 conf=true + from:'align'，并且**可追溯**：记下票数） */
function applyAlign(table, added) {
  const t = table || { map: {}, conf: {} };
  t.map = t.map || {}; t.conf = t.conf || {}; t.from = t.from || {};
  let n = 0;
  for (const a of (added || [])) {
    if (!a || !a.sub || !a.real) continue;
    if (t.map[a.sub] && t.conf[a.sub] !== false) continue;    /* 已经有把握的别覆盖 */
    t.map[a.sub] = a.real;
    t.conf[a.sub] = true;
    t.from[a.sub] = 'align:' + a.votes;
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ 48×48 细比（形近字） */

/*
 * 【为什么要有它】16×16 是我们为体积选的（3 MB 随包发）。它在少数"形近字"上分不开
 * （实测：某一格画的是"国"，可"囯"（囗+王）分数只低 0.03；还有个只给 0.5943 的失败案例）。
 * 而那些字一旦"拿不准"，整页就被拒、退回截图 + AI。
 * 办法：**只给容易混的那批字**再存一份 48×48 的向量（几百 KB），
 *       运行时先 16×16 粗认；认不准的，把那几个码位**按 48×48 重画一遍**，
 *       跟这份细库比 —— 分辨率上去了，笔画内部的差别就分得开。
 * 【覆盖范围（说清）】细库 = ①16×16 下就分不开的"形近字对" + ②常用字表。
 *       没覆盖到的字仍然是"拿不准"（宁可走截图，绝不猜）—— 这条红线不动。
 */
const REF48_FILE = 'ref-48-confuse.json.gz';
function ref48Path() { return path.join(REF_DIR, REF48_FILE); }

let REF48 = null, REF48_TRIED = false;
function loadRef48() {
  if (REF48_TRIED) return REF48;
  REF48_TRIED = true;
  try {
    const p = ref48Path();
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    const data = Buffer.from(j.data, 'base64');
    const g = j.grid, n = j.n;
    if (data.length !== n * g * g) return null;
    REF48 = { grid: g, n: n, chars: j.chars, at: j.at, refFont: j.refFont, data: data, vec: (i) => data.subarray(i * g * g, (i + 1) * g * g) };
    return REF48;
  } catch (e) { return null; }
}

/* 【挑"容易混的字"】离线跑一次：把 16×16 下长得太像的字挑出来，再并上常用字表。
   全表两两比是 21k² ✗ 太慢，所以先按"墨水总量"排序 —— 形近字的墨量必然接近，
   只跟邻居比就够了（近似，但只用于**扩容候选**，不影响安全：没挑到的仍是"拿不准"）。 */
function pickConfusable(ref, opts) {
  const o = opts || {};
  const thr = typeof o.threshold === 'number' ? o.threshold : 0.90;
  const window = o.window || 60;
  const cap = o.cap || 2600;
  if (!ref || !ref.chars) return { chars: [], pairs: 0 };
  const n = ref.n, g = ref.grid;
  const ink = [];
  for (let i = 0; i < n; i++) {
    const v = ref.vec(i);
    let s = 0;
    for (let k = 0; k < v.length; k++) s += v[k];
    ink.push({ i: i, s: s });
  }
  ink.sort((a, b) => a.s - b.s);
  const chosen = new Set();
  let pairs = 0;
  for (let a = 0; a < ink.length; a++) {
    for (let b = a + 1; b < Math.min(ink.length, a + window); b++) {
      const d = Math.abs(ink[a].s - ink[b].s) / Math.max(1, ink[a].s);
      if (d > 0.12) break;                      /* 墨量差太多，不必比 */
      if (ncc(ref.vec(ink[a].i), ref.vec(ink[b].i)) >= thr) {
        pairs++;
        chosen.add(ref.chars.charAt(ink[a].i));
        chosen.add(ref.chars.charAt(ink[b].i));
      }
    }
  }
  for (const ch of (ref.common || [])) chosen.add(ch);      /* 常用字一并覆盖（对手常常是常用字） */
  const out = [...chosen].filter((c) => ref.chars.indexOf(c) >= 0).slice(0, cap);
  return { chars: out, pairs: pairs };
}

/* 拿 48×48 的查询向量，在这份细库里再认一遍（只用细库覆盖到的那些字） */
function refineWith48(vec, ref48) {
  if (!ref48 || !vec || vec.length !== ref48.grid * ref48.grid) return null;
  let best = null, second = null;
  for (let i = 0; i < ref48.n; i++) {
    const s = ncc(vec, ref48.vec(i));
    if (!best || s > best.s) { second = best; best = { s: s, ch: ref48.chars.charAt(i) }; }
    else if (!second || s > second.s) second = { s: s, ch: ref48.chars.charAt(i) };
  }
  if (!best) return null;
  const margin = best.s - (second ? second.s : 0);
  return {
    ch: best.ch, score: Number(best.s.toFixed(4)), second: second ? second.ch : '',
    margin: Number(margin.toFixed(4)),
    conf: best.s >= SCORE_MIN && margin >= MARGIN_MIN
  };
}

module.exports = {
  GRID, COARSE, SCORE_MIN, MARGIN_MIN, TIEBREAK_BAND,
  loadRef, refPath, ncc, toCoarse, identifyOne, parseCmap, looksLikeFallback,
  renderScript, shaOf, tablePathFor, loadTable, saveTable,
  identifyFont, decodeWith, alignFill, applyAlign,
  REF48_FILE, ref48Path, loadRef48, pickConfusable, refineWith48
};
