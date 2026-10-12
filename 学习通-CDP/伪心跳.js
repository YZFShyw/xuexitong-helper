/* 伪心跳 —— 60 倍速模式
 * ============================================================================
 * 目标：不碰 video.playbackRate（平台的 1Hz 看门狗一发现就 pause + 按回 1，
 *      见 原理说明.txt 第一、四节），改为**替播放器把进度上报出去**，
 *      让服务端在几秒内收到"这一节按正常速度看完了"的记录。
 *
 * 为什么不能只改 playbackRate：
 *      平台的一致性检查是「观看时长必须等于真实流逝的时间」。
 *      2 倍速会让 220 秒里记下 439 秒 —— 平台的 1Hz 检测就是冲着这个来的。
 *      要么让上报与真实时间严格匹配（= 老实看，省不掉），
 *      要么**绕过播放器，自己发上报**。这就是「伪心跳」。
 *
 * 三个必须解决的问题，这里全部不靠猜：
 *
 *   1) 上报去哪、带什么字段
 *      不猜。hook 页面自己的 XMLHttpRequest / fetch / sendBeacon，
 *      把播放器真实发出的上报原样抓下来（URL 与 body 逐字保留）。
 *      判据以 body 里的字段为准（clipTime / playingTime / dtoken / objectId），
 *      URL 只作辅助 —— 免得把别的日志请求当成上报去改。
 *
 *   2) dtoken 是哪来的
 *      也不猜。两条自动反推：
 *        a) 如果页面里有 md5 / CryptoJS.MD5 / 类似的哈希函数，hook 它，
 *           把每次调用的「输入串 → 输出哈希」记下来。抓到上报样本后，
 *           拿样本里的 dtoken 去哈希日志里**反查**是哪一次调用产生的 ——
 *           那次调用的输入串就是拼接口令。
 *        b) 反查到之后，不改字段顺序、只把输入串里的「旧值」替换成「新值」，
 *           再交给同一个哈希函数算一次，就是新参数的合法 dtoken。
 *           替换逻辑**必须先自校验**：用旧值重算要能还原出样本里的 dtoken，
 *           还原不出来就整条路作废（绝不硬着头皮发）。
 *      这一条是整套方案的关键：不需要事先知道公式，也能算出合法令牌。
 *
 *   3) 平台认不认
 *      绝不假装。每一条上报的响应都存下来，按 200 / successful / isPassed
 *      判定 accepted / rejected，结论如实写进日志，并把原始样本落到
 *      伪心跳-样本.json —— 万一被拒，那份样本里有全部线索。
 *
 * 用法（由 driver.js 接线，一般不用手敲）：
 *   node driver.js --run --next --force --speed=60
 *     --speed=N         伪心跳倍速（0 = 关；60 = 1 秒真实时间报 60 秒进度）
 *     --speed-tick=MS   补报间隔（默认 2000）
 *                       不要往小里调：成熟开源项目的原话是
 *                       「上报进度极其容易卡验证码，限制 2s 一次」。
 *     --speed-no-jump   关掉「报满后把播放位置推到末尾」这个收尾动作
 *     SPEED_JUMP=0      同上（环境变量写法）
 *
 * 默认 0 倍速 = 完全不启用，driver.js 的行为跟以前一模一样。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAMPLE_FILE = path.join(__dirname, '伪心跳-样本.json');
/* 最多发几条就收手（含首发）。base.py 那边是 while not passed 无限循环，
   咱们在别人的账号上跑，宁可少发也不要拿废请求去撞验证码。 */
const HB_MAX_TRIES = 8;

/* ============================================================
 * 一、页面内脚本
 * ============================================================ */

/* 找播放器，以及它所在的文档与 window。
   不复用 driver.js 的 CHAIN：这边不需要坐标换算，链子短一点就不容易
   跟 driver.js 的改动打架。识别判据跟 CHAIN 保持一致 —— 播放器容器里的
   <video> 一律认（还没加载时它也是 0x0、没 src），散落别处的要有源或有尺寸，
   否则会认下 UEditor 留下的 0x0 <audio> 残渣。 */
const FIND_MEDIA = `
function findMedia(){
  var docs = [document], i, k;
  (function walk(d, dep){
    if (dep > 6) return;
    var fs = null; try { fs = d.querySelectorAll('iframe, frame'); } catch (e) { return; }
    for (var j = 0; j < fs.length; j++){
      var cd = null; try { cd = fs[j].contentDocument; } catch (e) { cd = null; }
      if (cd && docs.indexOf(cd) < 0){ docs.push(cd); walk(cd, dep + 1); }
    }
  })(document, 0);
  /* 【和 driver 那边的 chain() 用同一套挑选规则（2026-10-08 最终复查发现）】
     原来这里只按文档序挑"第一个未播完的"。可 chain() 已经改成
     "未播完的里面优先挑已加载元数据的" —— 一页两个视频卡时，
     卡片1 的还没加载、卡片2 的已加载，driver 会去播卡片2；
     心跳要是还按老规矩挑卡片1，就是往一个**没在播的**播放器上报进度。
     两边判据必须一致：已加载且未播完的最优先，其次未播完的，最后随便一个。 */
  var firstAny = null, lazyUnfinished = null;
  for (i = 0; i < docs.length; i++){
    var vs = null; try { vs = docs[i].querySelectorAll('video, audio'); } catch (e) { continue; }
    for (k = 0; k < vs.length; k++){
      var el = vs[k], real = false;
      try {
        if (el.id && String(el.id).indexOf('video_html5') >= 0) real = true;
        else if (el.closest && el.closest('.video-js, [class*=vjs], [class*=player], [class*=Player]')) real = true;
        else if (el.currentSrc || el.getAttribute('src')) real = true;
        else if (el.readyState > 0 || (el.duration > 0)) real = true;
        else { var r = el.getBoundingClientRect(); if (r.width > 20 && r.height > 20) real = true; }
      } catch (e) {}
      if (!real) continue;
      if (!firstAny) firstAny = { doc: docs[i], v: el };
      var fin = false;
      try { fin = el.ended || (el.duration > 0 && el.currentTime >= el.duration - 1.5); } catch (e2) {}
      if (fin) continue;
      if (el.readyState > 0 || el.duration > 0) return { doc: docs[i], v: el, docs: docs.length };
      if (!lazyUnfinished) lazyUnfinished = { doc: docs[i], v: el };
    }
  }
  if (lazyUnfinished) return { doc: lazyUnfinished.doc, v: lazyUnfinished.v, docs: docs.length };
  if (firstAny) return { doc: firstAny.doc, v: firstAny.v, docs: docs.length };
  return { doc: null, v: null, docs: docs.length };
}
`;

/* 工具与 hook 的安装体。装好之后所有函数都挂在 W.__cxHB 上，
   后面的 status / beacon / finish 表达式直接引用它们 ——
   页面内的引用不经过 CDP 序列化，函数是活的。 */
const INSTALL_BODY = `
/* ---- 上报的识别与改写 ---- */
var TIME_RE = /^(clipTime|playingTime|playTime|lastTime|realTime|viewTime|rt)$/i;

function decodeForm(body){
  var out = [], parts = String(body || '').split('&');
  for (var i = 0; i < parts.length; i++){
    if (!parts[i]) continue;
    var eq = parts[i].indexOf('=');
    var k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
    var val = eq < 0 ? '' : parts[i].slice(eq + 1);
    var dk = k; try { dk = decodeURIComponent(k.replace(/\\+/g, ' ')); } catch (e) {}
    out.push({ raw: parts[i], key: dk, val: val });
  }
  return out;
}
function fieldMap(body){
  var m = {}, f = decodeForm(body);
  for (var i = 0; i < f.length; i++) m[f[i].key] = f[i].val;
  return m;
}
/* 只改时间类字段。duration 绝不能乘 —— 那是视频总长，乘了就露。 */
function bumpForm(body, speed, dur){
  var hit = 0;
  var out = String(body).replace(/(^|&)([^=&]*)=([^&]*)/g, function(all, sep, k, val){
    var kk = k; try { kk = decodeURIComponent(String(k).replace(/\\+/g, ' ')); } catch (e) {}
    if (!TIME_RE.test(kk)) return all;
    var n = Number(val);
    if (!isFinite(n) || n <= 0) return all;
    var nv = n * speed;
    if (dur > 0 && nv > dur) nv = dur;
    hit++;
    return sep + k + '=' + (Math.round(nv * 1000) / 1000);
  });
  return hit ? { body: out, hit: hit } : null;
}
/* 把指定字段替换成新值（补报用）。
   字段不存在时默认追加 —— 服务端按名字取值，位置无所谓。
   append=false 时**只替换已存在的字段**：拆分 query / body 时要用它，
   免得把本该留在 query 里的字段又串一份到 body 上去。 */
function buildForm(tpl, fields, append){
  var parts = String(tpl || '').split('&'), seen = {}, out = [];
  for (var i = 0; i < parts.length; i++){
    var eq = parts[i].indexOf('=');
    var rawK = eq < 0 ? parts[i] : parts[i].slice(0, eq);
    var k = rawK; try { k = decodeURIComponent(rawK.replace(/\\+/g, ' ')); } catch (e) {}
    if (Object.prototype.hasOwnProperty.call(fields, k)){
      out.push(rawK + '=' + fields[k]);
      seen[k] = 1;
    } else if (parts[i]) out.push(parts[i]);
  }
  if (append !== false){
    for (var kk in fields){
      if (!seen[kk]) out.push(encodeURIComponent(kk) + '=' + fields[kk]);
    }
  }
  return out.join('&');
}

/* URL 一拆二：基址 + query。
   上报字段可能全在 body，也可能在 query 里（老接口那种形态）——
   两种都得认：只认 body 的话，后一种连样本都抓不到。 */
function splitUrl(u){
  var s = String(u || '');
  var i = s.indexOf('?');
  if (i < 0) return { base: s, q: '' };
  var h = s.indexOf('#', i);
  return { base: s.slice(0, i), q: (h < 0 ? s.slice(i + 1) : s.slice(i + 1, h)) };
}
/* 把 query 与 body 合成一份字段串（body 优先、query 补缺）。
   后面所有字段分析、改写、判定都只看这一份，不用再关心它原本在哪。 */
function mergedForm(url, body){
  var q = splitUrl(url).q;
  var b = String(body || '');
  if (!q) return b;
  if (!b) return q;
  var have = fieldMap(b), extra = [], f = decodeForm(q);
  for (var i = 0; i < f.length; i++){ if (have[f[i].key] === undefined) extra.push(f[i].raw); }
  return extra.length ? (b + '&' + extra.join('&')) : b;
}

function isReport(url, body){
  var b = String(body || '');
  /* 判据以字段为准：真上报里一定有这几个字段之一。
     传进来的 body 应当是 mergedForm 的结果（query + body 合并过）。 */
  if (/clipTime=|playingTime=|dtoken=|objectId=/i.test(b)) return true;
  var u = String(url || '');
  if (/[?&](clipTime|playingTime|dtoken|objectId)=/i.test(u)) return true;
  if (/(multimedia\\/log|\\/log\\/a\\/|ananas|report|progress)/i.test(u) && /time|job|object|dur/i.test(b)) return true;
  return false;
}

/* 把字段分回它们原本待的地方（query / body），返回可直接发出去的形状。
   规则：
     原本在 query 里、不在 body 里 → 留在 query（老接口只读 query，搬到 body 就废）；
     原本在 body 里的             → 留在 body；
     新字段（比如重算出来的 dtoken）→ 原请求有 body 就进 body，没有就追加到 query。 */
function splitFields(url, rawBody, fields){
  var sp = splitUrl(url);
  var qMap = fieldMap(sp.q), bMap = fieldMap(rawBody || '');
  var inQ = {}, inB = {};
  for (var k in fields){
    if (qMap[k] !== undefined && bMap[k] === undefined) inQ[k] = fields[k];
    else if (bMap[k] !== undefined) inB[k] = fields[k];
    else if (rawBody) inB[k] = fields[k];
    else inQ[k] = fields[k];
  }
  return {
    base: sp.base,
    q: buildForm(sp.q, inQ, false),
    body: buildForm(rawBody || '', inB, false),
  };
}

/* ---- 哈希函数 hook：把「输入串 → 输出」记下来，用来反查 dtoken ---- */
var HASH_NAMES = ['md5', 'MD5', 'hex_md5', 'sha1', 'SHA1', 'hex_sha1', 'hmac',
                  'encrypt', 'Encrypt', 'getDtoken', 'getToken', 'dtoken', 'sign'];
function wrapHash(W, name, owner){
  try {
    var fn = owner ? owner[name] : W[name];
    if (typeof fn !== 'function' || fn.__cxHBWrapped) return;
    var wrapped = function(){
      var out;
      try { out = fn.apply(this, arguments); } catch (e) { throw e; }
      try {
        H.hashes.push({
          f: (owner ? 'obj.' : '') + name,
          args: Array.prototype.slice.call(arguments).map(function(a){ return String(a).slice(0, 220); }),
          out: String(out).slice(0, 72)
        });
        if (H.hashes.length > 60) H.hashes.shift();
      } catch (e) {}
      return out;
    };
    wrapped.__cxHBWrapped = true;
    try { if (owner) owner[name] = wrapped; else W[name] = wrapped; } catch (e) {}
  } catch (e) {}
}
function hookHashes(){
  for (var i = 0; i < HASH_NAMES.length; i++) wrapHash(W, HASH_NAMES[i], null);
  try { if (W.CryptoJS){ wrapHash(W, 'MD5', W.CryptoJS); wrapHash(W, 'HmacMD5', W.CryptoJS); } } catch (e) {}
  try { if (W.CryptoJS && W.CryptoJS.algo){ /* 有的版本挂在 algo 上，留着不亏 */ } } catch (e) {}
}

/* ---- 反查：样本里的 dtoken 是哪一次哈希调用产生的 ---- */
function lookupHash(dtoken){
  if (!dtoken) return null;
  var want = String(dtoken).toLowerCase();
  for (var i = H.hashes.length - 1; i >= 0; i--){
    if (String(H.hashes[i].out).toLowerCase() === want) return H.hashes[i];
  }
  return null;
}
/* 用「旧值 → 新值」做替换再哈希。先自校验：用旧值必须能还原出原 dtoken。 */
function rehash(found, oldMap, newMap, hashFn){
  if (!found || !hashFn) return null;
  /* 自校验：先确认「找到的这条记录确实是用这个样本的参数算的」 */
  var back = null;
  try { back = String(hashFn.apply(null, found.args.map(function(a){ return a; }))); } catch (e) { back = null; }
  if (back === null || back.toLowerCase() !== String(found.out).toLowerCase()) return null;

  /* 替换：只替换长度 >= 2 的旧值，免得把 "0"、"1" 这种短串换得满目全非 */
  var replaced = found.args.map(function(a){
    var s = String(a);
    for (var k in newMap){
      var ov = oldMap[k];
      if (ov === undefined || ov === null) continue;
      var os = String(ov), ns = String(newMap[k]);
      if (os === ns || os.length < 2) continue;
      s = s.split(os).join(ns);
    }
    return s;
  });
  /* 替换后必须真的变了，没变说明这个哈希跟时间字段无关，不能用 */
  if (replaced.join('|') === found.args.join('|')) return null;
  try {
    var out = hashFn.apply(null, replaced);
    return out ? { dtoken: String(out), args: replaced } : null;
  } catch (e) { return null; }
}

/* ---- 改写一条上报：时间字段按 speed 放大，并尽量把 dtoken 也按新参数重算 ----
   为什么连 dtoken 一起重算：平台的令牌大概率与时间字段绑定，只改时间不改令牌，
   服务端一眼就能看出这条是伪造的。算不出来也不拦着 —— 照样发出去，
   让平台自己回答"认不认"，那个答案我们要如实记下来。 */
function rewriteOne(rec, speed, dur){
  var nb = bumpForm(rec.body, speed, dur);
  if (!nb) return null;
  function scaled(v){ var n = Number(v) * speed; if (dur > 0 && n > dur) n = dur; return Math.round(n * 1000) / 1000; }
  try {
    if (typeof H.recompute === 'function'){
      var om = fieldMap(rec.body);
      var nr = H.recompute(scaled(om.clipTime || 0), scaled(om.playingTime || 0));
      if (nr && nr.ok && nr.dtoken){ nb.body = buildForm(nb.body, { dtoken: nr.dtoken }); nb.rebuilt = true; }
      else { nb.rebuilt = false; nb.why = (nr && nr.why) || ''; }
    }
  } catch (e) { nb.rebuilt = false; nb.why = '重算出错: ' + (e && e.message); }
  return nb;
}

/* ---- 响应判定 ----
   顺序讲究：先认「明确的假」，再认「明确的真」，最后才看关键词。
   以前把裸的 successful 当接受信号，遇到 {"successful":false} 会误判成"接受"——
   那种误判比不判还糟：它会让整个流程以为成功了。 */
function verdictOf(txt){
  var t = String(txt || '');
  if (!t) return 'empty';
  if (/验证码|captcha/i.test(t)) return 'rejected';
  if (/"(successful|isPassed|success)"\\s*:\\s*false/i.test(t)) return 'rejected';
  if (/"(successful|isPassed|success)"\\s*:\\s*true/i.test(t)) return 'accepted';
  if (/"(status|code|errorCode)"\\s*:\\s*"?0"?\\b/.test(t)) return 'accepted';
  if (/\\b(ok|success)\\b/i.test(t) && !/\\b(false|error|fail|失败)\\b/i.test(t)) return 'accepted';
  if (/\\b(false|error|fail|失败)\\b/i.test(t)) return 'rejected';
  return 'unknown';
}

/* ---- 拦掉「失焦 / 不可见」这一类事件 ----
   做法与理由都来自 uxuescript（2026/09 仍在跑的开源实现，见 对照研究\_网上参考）：
   窗口一失焦或被别的窗口盖住，Chromium 就把定时器降频，播放器的心跳与上报
   定时器跟着变慢 —— 我们迟迟等不到第一条真实上报，整个伪心跳就卡在"等样本"上。
   它的做法是四件一起做：清掉内联监听、捕获阶段掐断、拦后续 addEventListener、
   再把 document.hidden / visibilityState / hasFocus 伪造成"一直可见"。

   【只拦这一类】pause / play / timeupdate / ended 一个都不能碰 ——
   拦了播放器自己就废了（那是 uxuescript 里没有的，我们这边更不能出错）。 */
function preserveFocus(W, doc){
  if (W.__cxHBFocus) return { ok: true, reused: true };
  W.__cxHBFocus = 1;
  var blocked = ['blur', 'focusout', 'mouseleave', 'mouseout', 'pagehide', 'visibilitychange'];
  var i;
  for (i = 0; i < blocked.length; i++){
    try { W['on' + blocked[i]] = null; } catch (e) {}
    try { doc['on' + blocked[i]] = null; } catch (e) {}
  }
  function stop(e){ try { e.stopImmediatePropagation(); e.stopPropagation(); } catch (err) {} }
  for (i = 0; i < blocked.length; i++){
    try { W.addEventListener(blocked[i], stop, true); } catch (e) {}
    try { doc.addEventListener(blocked[i], stop, true); } catch (e) {}
  }
  try {
    var OA = W.EventTarget && W.EventTarget.prototype && W.EventTarget.prototype.addEventListener;
    if (OA){
      W.EventTarget.prototype.addEventListener = function(type, fn, opt){
        if (blocked.indexOf(String(type)) >= 0) return undefined;
        return OA.call(this, type, fn, opt);
      };
    }
  } catch (e) {}
  try {
    Object.defineProperty(doc, 'hidden', { get: function(){ return false; }, configurable: true });
    Object.defineProperty(doc, 'visibilityState', { get: function(){ return 'visible'; }, configurable: true });
    doc.hasFocus = function(){ return true; };
  } catch (e) {}
  return { ok: true, blocked: blocked.length };
}

function snap(){
  return {
    ok: true, ver: 1, speed: H.speed, mode: H.mode,
    samples: H.samples.length,
    hashes: H.hashes.length,
    rewritten: H.rewritten, sent: H.sent, okCount: H.ok, badCount: H.bad,
    lastVerdict: H.lastVerdict, lastResp: String(H.lastResp || '').slice(0, 180),
    lastPassed: !!H.lastPassed,
    lastParams: H.lastParams || null,
    tpl: H.tpl ? { url: H.tpl.url, body: H.tpl.body.slice(0, 1400) } : null,
    dtoken: H.dtoken || '', dtokenFrom: H.dtokenFrom || '未反推出来',
    progress: H.progress, dur: H.dur, note: H.note || '', docs: M.docs
  };
}
`;

/* 装有 hook 的表达式（幂等）。 */
function installExpr(speed) {
  const sp = Number(speed);
  return `(function(){
  var SPEED = ${sp > 0 ? sp : 60};
  ${FIND_MEDIA}
  var M = findMedia();
  if (!M.v) return { ok: false, why: '这一章没找到播放器（可能不是视频章）', docs: M.docs };
  var d2 = M.doc;
  var W = null; try { W = d2.defaultView; } catch (e) { W = null; }
  if (!W) return { ok: false, why: '拿不到播放器所在的 window', docs: M.docs };
  var v = M.v;

  var H = W.__cxHB;
  if (H && H.ver === 1){
    H.speed = SPEED; H.tickAt = Date.now();
    try { H.dur = v.duration || H.dur; } catch (e) {}
    return { ok: true, reused: true, st: (function(){ ${INSTALL_BODY}
      return snap(); })() };
  }

  H = W.__cxHB = {
    ver: 1, speed: SPEED, mode: 'observe',
    samples: [], hashes: [], rewritten: 0, sent: 0, ok: 0, bad: 0,
    lastResp: '', lastVerdict: '', progress: 0, dur: 0,
    tpl: null, dtoken: '', dtokenFrom: '未反推出来', note: '', tickAt: Date.now()
  };
  try { H.dur = v.duration || 0; } catch (e) {}
  ${INSTALL_BODY}

  var XO = W.XMLHttpRequest && W.XMLHttpRequest.prototype.open;
  var XS = W.XMLHttpRequest && W.XMLHttpRequest.prototype.send;
  if (XO && XS && !W.__cxHBXhr){
    W.__cxHBXhr = 1;
    W.XMLHttpRequest.prototype.open = function(m, u){
      try { this.__cxUrl = u; } catch (e) {}
      return XO.apply(this, arguments);
    };
    W.XMLHttpRequest.prototype.send = function(body){
      try {
        var u = this.__cxUrl || '';
        var merged = mergedForm(u, body);
        if (isReport(u, merged)){
          /* raw 留着：补报时要按「字段原本在 query 还是 body」把请求拆回去 */
          var rec = { url: String(u), raw: String(body || ''), body: merged, t: Date.now() };
          if (rec.body){
            H.samples.push(rec);
            if (H.samples.length > 6) H.samples.shift();
            if (!H.tpl) H.tpl = rec;                 /* 模板：URL + 字段结构 */
            H.mode = 'rewrite';
            try { H.dur = v.duration || H.dur; } catch (e) {}
            var nb = H.speed > 1 ? rewriteOne(rec, H.speed, H.dur) : null;
            if (nb){
              H.rewritten++;
              /* 响应要留证：改写后被拒的话，证据全在这一条上 */
              this.addEventListener('load', function(){
                try {
                  H.lastResp = String(this.responseText || '').slice(0, 400);
                  H.lastVerdict = verdictOf(H.lastResp);
                  if (H.lastVerdict === 'accepted') H.ok++; else if (H.lastVerdict === 'rejected') H.bad++;
                } catch (e) {}
              });
              return XS.call(this, nb.body);
            }
          }
        }
      } catch (e) { H.note = '改写出错: ' + (e && e.message); }
      return XS.apply(this, arguments);
    };
  }

  var XF = W.fetch;
  if (typeof XF === 'function' && !W.__cxHBFetch){
    W.__cxHBFetch = 1;
    W.fetch = function(input, init){
      try {
        var u = (typeof input === 'string') ? input : (input && input.url) || '';
        var b = (init && init.body) || (input && typeof input === 'object' && input.body) || '';
        var merged = mergedForm(u, b);
        if (isReport(u, merged)){
          var rec = { url: String(u), raw: String(b || ''), body: merged, t: Date.now() };
          if (rec.body){
            H.samples.push(rec);
            if (H.samples.length > 6) H.samples.shift();
            if (!H.tpl) H.tpl = rec;
            H.mode = 'rewrite';
            try { H.dur = v.duration || H.dur; } catch (e) {}
            var nb = H.speed > 1 ? rewriteOne(rec, H.speed, H.dur) : null;
            if (nb){
              H.rewritten++;
              if (init) init = Object.assign({}, init, { body: nb.body });
              else if (input && typeof input === 'object') input = new W.Request(input, { body: nb.body });
              var pr = XF.call(this, input, init);
              if (pr && pr.then) pr.then(function(r){
                try { return r.clone().text().then(function(t){
                  H.lastResp = String(t || '').slice(0, 400);
                  H.lastVerdict = verdictOf(H.lastResp);
                  if (H.lastVerdict === 'accepted') H.ok++; else if (H.lastVerdict === 'rejected') H.bad++;
                }); } catch (e) {}
              }).catch(function(){});
              return pr;
            }
          }
        }
      } catch (e) { H.note = 'fetch 改写出错: ' + (e && e.message); }
      return XF.apply(this, arguments);
    };
  }

  var SB = W.navigator && W.navigator.sendBeacon;
  if (typeof SB === 'function' && !W.__cxHBBeacon){
    W.__cxHBBeacon = 1;
    W.navigator.sendBeacon = function(u, data){
      try {
        var merged = mergedForm(u, data);
        if (isReport(u, merged)){
          var rec = { url: String(u), raw: String(data || ''), body: merged, t: Date.now() };
          if (rec.body){
            H.samples.push(rec);
            if (H.samples.length > 6) H.samples.shift();
            if (!H.tpl) H.tpl = rec;
            H.mode = 'rewrite';
            var nb = H.speed > 1 ? rewriteOne(rec, H.speed, H.dur) : null;
            if (nb) { H.rewritten++; return SB.call(W.navigator, u, nb.body); }
          }
        }
      } catch (e) {}
      return SB.apply(W.navigator, arguments);
    };
  }

  try { hookHashes(); } catch (e) {}
  try { preserveFocus(W, d2); } catch (e) { H.note = '可见性处理失败: ' + (e && e.message); }

  /* ---- 反推 dtoken：从哈希日志里找到样本 dtoken 的来源 ---- */
  H.recompute = function(targetClip, targetPlay){
    if (!H.tpl) return { ok: false, why: '还没有真实上报样本' };
    var oldMap = fieldMap(H.tpl.body);
    if (!oldMap.dtoken) return { ok: false, why: '样本里没有 dtoken 字段（可能不是这个接口）' };
    if (!H.dtoken){                       /* 第一次：反查 */
      var found = lookupHash(oldMap.dtoken);
      if (found){
        H.dtoken = oldMap.dtoken;
        H.dtokenFrom = '哈希日志命中: ' + found.f + '  args=' + found.args.join(' | ').slice(0, 160);
        H.found = found;
      } else {
        return { ok: false, why: '哈希日志里没有与 dtoken 匹配的调用（页面可能没用标准 md5）' };
      }
    }
    var newMap = {};
    for (var k in oldMap) newMap[k] = oldMap[k];
    if (targetClip !== null && targetClip !== undefined) newMap.clipTime = String(targetClip);
    if (targetPlay !== null && targetPlay !== undefined) newMap.playingTime = String(targetPlay);
    /* 找一个能用的哈希函数重放 */
    var hashFn = null;
    try {
      if (H.found && H.found.f.indexOf('obj.') === 0 && W.CryptoJS && typeof W.CryptoJS[H.found.f.slice(4)] === 'function')
        hashFn = W.CryptoJS[H.found.f.slice(4)];
    } catch (e) {}
    if (!hashFn){
      var nm = H.found ? H.found.f.replace(/^obj\\./, '') : '';
      if (nm && typeof W[nm] === 'function') hashFn = W[nm];
      else if (W.CryptoJS && typeof W.CryptoJS.MD5 === 'function') hashFn = W.CryptoJS.MD5;
      else if (typeof W.md5 === 'function') hashFn = W.md5;
    }
    if (!hashFn) return { ok: false, why: '找不到可调用的哈希函数' };
    var r = rehash(H.found, oldMap, newMap, hashFn);
    if (!r) return { ok: false, why: '替换+重算失败（自校验没过，或不含时间字段）' };
    return { ok: true, dtoken: r.dtoken, args: r.args };
  };

  /* ---- 补报：拿样本当模板，改字段后由页面自己发 ---- */
  H.beacon = function(targetClip, targetPlay, cb){
    if (!H.tpl) return { ok: false, why: '还没有真实上报样本（播放器还没上报过一次）' };
    var oldMap = fieldMap(H.tpl.body);
    var fields = {
      clipTime: String(targetClip),
      playingTime: String(targetPlay)
    };
    /* duration 不参与改写；但有些接口要求 clipTime 不超过它 */
    var rec = H.recompute(targetClip, targetPlay);
    if (rec.ok) fields.dtoken = rec.dtoken;

    /* 字段放回它原本的地方 —— 规则与理由见 splitFields 上面那段 */
    var sp = splitFields(H.tpl.url, H.tpl.raw, fields);
    var body = sp.body;
    var url = sp.base;
    if (sp.q) url += (url.indexOf('?') >= 0 ? '&' : '?') + sp.q;
    try { url = new W.URL(url, (d2.location ? d2.location.href : W.location.href)).href; } catch (e) { url = H.tpl.url; }

    var x = new W.XMLHttpRequest();
    x.open('POST', url, true);
    try { x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded'); } catch (e) {}
    x.onload = function(){
      H.lastResp = String(x.responseText || '').slice(0, 400);
      H.lastVerdict = verdictOf(H.lastResp);
      if (H.lastVerdict === 'accepted') H.ok++; else if (H.lastVerdict === 'rejected') H.bad++;
      H.sent++;
      H.progress = Math.max(H.progress, targetClip || 0);
      if (cb) { try { cb(); } catch (e) {} }
    };
    x.onerror = function(){ H.sent++; H.lastVerdict = '网络错误'; };
    try { x.send(body); } catch (e) { return { ok: false, why: '发送失败: ' + e.message }; }
    H.lastSent = { clipTime: targetClip, playingTime: targetPlay, rebuilt: rec.ok,
                   dtokenNote: rec.ok ? '重算成功' : rec.why };
    return { ok: true, rebuilt: rec.ok, note: rec.ok ? '' : rec.why };
  };

  /* ---- 发一条上报 ----
     参数由 node 侧算好（含 enc 签名），这里只负责拼 query、用页面自己的 XHR 发出去。
     这样 cookie、Referer、UA 全是真的，跟播放器自己发的那条没有区别 ——
     这也是为什么这条路能在"不碰账号密码"的前提下走通。
     GET 形态是照 base.py:685 抄的（它也是 GET + query）。 */
  H.sendLog = function(params){
    if (!H.tpl) return { ok: false, why: '还没有真实上报样本' };
    var sp = splitUrl(H.tpl.url);
    var qs = [];
    for (var k in params){
      if (params[k] === undefined || params[k] === null) continue;
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    var url = sp.base + (qs.length ? ('?' + qs.join('&')) : '');
    var x = new W.XMLHttpRequest();
    x.open('GET', url, true);
    x.onload = function(){
      H.lastResp = String(x.responseText || '').slice(0, 500);
      H.lastVerdict = verdictOf(H.lastResp);
      /* isPassed 才是真正的完成判据（base.py 全程以它为准）——
         successful:true 只说明请求收下了，不代表这一节算完成。 */
      H.lastPassed = /"isPassed"\s*:\s*true/i.test(H.lastResp);
      if (H.lastVerdict === 'accepted') H.ok++; else if (H.lastVerdict === 'rejected') H.bad++;
      H.sent++;
      H.progress = Math.max(H.progress, Number(params.playingTime) || 0);
      H.lastParams = params;
    };
    x.onerror = function(){ H.sent++; H.lastVerdict = '网络错误'; };
    try { x.send(); } catch (e) { return { ok: false, why: '发送失败: ' + e.message }; }
    return { ok: true };
  };

  /* ---- 报满之后：把播放位置推到末尾 ----
     为什么需要：服务端记录已经被伪心跳写满，但**页面自己**是按
     video.currentTime 判"看完没"的。不推这一下，卡片上的任务点标记
     不会变，driver 的完成判定也永远不成立。
     推位置不影响服务端记录（那条记录早就是满的了）。 */
  H.jumpToEnd = function(){
    try {
      if (!isFinite(v.duration) || v.duration <= 0) return { ok: false };
      var t = Math.max(0, v.duration - 1.2);
      if (v.currentTime < t) v.currentTime = t;
      return { ok: true, at: v.currentTime, dur: v.duration };
    } catch (e) { return { ok: false, why: e.message }; }
  };

  return { ok: true, st: snap() };
})()`;
}

/* 轻量探针：只回答一件事 —— 播放器那个 window 上还挂着 hook 吗。
   为什么不每轮直接重灌安装体（23 KB）：主循环大约一秒一轮，
   每秒往页面里塞 23 KB 脚本再编译一遍纯属浪费。稳态下用这个探针短路，
   换章（播放器 iframe 重建、__cxHB 跟着消失）时它才会报 false，那时才重装。 */
const PING_EXPR = `(function(){
  try { if (window.__cxHB) return { ok: true, on: 'top' }; } catch (e) {}
  function dig(d, dep){
    if (dep > 6) return null;
    var fs = null; try { fs = d.querySelectorAll('iframe, frame'); } catch (e) { return null; }
    for (var i = 0; i < fs.length; i++){
      var cd = null; try { cd = fs[i].contentDocument; } catch (e) { cd = null; }
      if (!cd) continue;
      var w = null; try { w = cd.defaultView; } catch (e) {}
      if (w && w.__cxHB) return w.__cxHB;
      var r = dig(cd, dep + 1);
      if (r) return r;
    }
    return null;
  }
  var H = dig(document, 0);
  return H ? { ok: true, on: 'frame', ver: H.ver, speed: H.speed } : { ok: false };
})()`;

const STATUS_EXPR = `(function(){
  ${FIND_MEDIA}
  var M = findMedia();
  if (!M.v) return { ok: false, why: '这一章没找到播放器', docs: M.docs };
  var W = null; try { W = M.doc.defaultView; } catch (e) { W = null; }
  var H = W && W.__cxHB;
  if (!H) return { ok: false, why: '还没装 hook（本轮还没到视频章）', docs: M.docs };
  try { H.dur = M.v.duration || H.dur; } catch (e) {}
  var o = {
    ok: true, ver: H.ver, speed: H.speed, mode: H.mode,
    samples: H.samples.length, hashes: H.hashes.length,
    rewritten: H.rewritten, sent: H.sent, okCount: H.ok, badCount: H.bad,
    lastVerdict: H.lastVerdict, lastResp: String(H.lastResp || '').slice(0, 180),
    lastPassed: !!H.lastPassed,
    lastParams: H.lastParams || null,
    tpl: H.tpl ? { url: H.tpl.url, body: H.tpl.body.slice(0, 1400) } : null,
    dtokenFrom: H.dtokenFrom || '', progress: H.progress, dur: H.dur,
    note: H.note || '', docs: M.docs,
    cur: Math.round((M.v.currentTime || 0) * 10) / 10
  };
  return o;
})()`;

function beaconExpr(clip, play) {
  return `(function(){
  ${FIND_MEDIA}
  var M = findMedia();
  if (!M.v) return { ok: false, why: '这一章没找到播放器' };
  var W = null; try { W = M.doc.defaultView; } catch (e) { W = null; }
  var H = W && W.__cxHB;
  if (!H || typeof H.beacon !== 'function') return { ok: false, why: 'hook 还没装好' };
  return H.beacon(${Number(clip) || 0}, ${Number(play) || 0});
})()`;
}

/* 发一条上报：参数由 node 侧算好（含 enc），页面只负责发。
   JSON 内插是安全的：参数全是字符串/数字，JSON.stringify 会把引号转义掉。 */
function sendLogExpr(params) {
  return `(function(){
  ${FIND_MEDIA}
  var M = findMedia();
  if (!M.v) return { ok: false, why: '这一章没找到播放器' };
  var W = null; try { W = M.doc.defaultView; } catch (e) { W = null; }
  var H = W && W.__cxHB;
  if (!H || typeof H.sendLog !== 'function') return { ok: false, why: 'hook 还没装好' };
  return H.sendLog(${JSON.stringify(params)});
})()`;
}

const JUMP_EXPR = `(function(){
  ${FIND_MEDIA}
  var M = findMedia();
  if (!M.v) return { ok: false, why: '这一章没找到播放器' };
  var W = null; try { W = M.doc.defaultView; } catch (e) { W = null; }
  var H = W && W.__cxHB;
  if (!H || typeof H.jumpToEnd !== 'function') return { ok: false, why: 'hook 还没装好' };
  return H.jumpToEnd();
})()`;

/* ============================================================
 * 二、node 侧：可选的离线反推（页面里没有哈希函数时的第二手）
 * ============================================================ */
const CAND_KEYS = ['objectId', 'clipTime', 'playingTime', 'jobid', 'duration',
                   'otherInfo', 'attachments', 'userid', 'clazzid', 'formType', 'api'];

/* 拿样本的字段去试常见拼接式。命中就返回公式名 —— 命中不了才是常态，
   所以这里只当补充手段，主路是页面里的哈希 hook。 */
function guessFormula(sample) {
  try {
    if (!sample || !sample.body) return null;
    const map = {};
    for (const part of String(sample.body).split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      map[decodeURIComponent(part.slice(0, eq))] = part.slice(eq + 1);
    }
    const dt = map.dtoken;
    if (!dt) return null;
    const cands = [];
    cands.push(['全字段按出现顺序', Object.keys(map).filter((k) => k !== 'dtoken').map((k) => map[k]).join('')]);
    cands.push(['时间+id', (map.objectId || '') + (map.clipTime || '') + (map.playingTime || '')]);
    cands.push(['id+时间', (map.objectId || '') + (map.playingTime || '') + (map.clipTime || '')]);
    cands.push(['时间+id+dur', (map.clipTime || '') + (map.playingTime || '') + (map.objectId || '') + (map.duration || '')]);
    for (const [name, s] of cands) {
      const h = crypto.createHash('md5').update(s, 'utf8').digest('hex');
      if (h.toLowerCase() === String(dt).toLowerCase()) return { name, input: s };
    }
  } catch (e) {}
  return null;
}

/* ============================================================
 * 三、node 侧：签名与参数构造
 * ============================================================
 *
 * 这一段的依据不是猜的 —— 是 Samueli924/chaoxing 的 api/base.py 原文
 * （源码在 …\对照研究\cx_b64\out\api__base.py，另一台会话扒下来的，逐字可核）：
 *
 *   base.py:620  get_enc()
 *     md5(f"[{clazzId}][{userid}][{jobid}][{objectId}][{playingTime*1000}]"
 *         f"[d_yHJ!$pdA~5][{duration*1000}][0_{duration}]")
 *     ↑ 那个 d_yHJ!$pdA~5 是写死在代码里的盐
 *
 *   base.py:625  video_progress_log()
 *     GET https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/{cpi}/{dtoken}
 *     参数 clazzId/playingTime/duration/clipTime=f"0_{duration}"/objectId/
 *          otherInfo/courseId/jobid/userid/isdrag/view=pc/enc/dtype
 *     另带 rt 与 _t（时间戳）
 *
 *   base.py:819  study_video()
 *     **第一发就直接报满**（playingTime=duration, isdrag=4）；
 *     服务端认了就"任务瞬间完成"，不认才进 30~90 秒一轮的补发循环，
 *     循环里 play_time 按 _speed 缩放推进 —— 这就是所谓 60 倍速。
 *     base.py:859 注释原文：Sometimes the last request needs to be sent
 *     several times to complete the task（最后一条要发几次才算完成）。
 *
 * 咱们这边不能照抄它的"账号密码 + 直连接口"，但**签名算法与节奏可以照搬**：
 * 请求仍然从页面里发（带着你已经登录的 cookie 与正确的 Referer），
 * 只是参数由我们自己拼。
 */
const SALT = 'd_yHJ!$pdA~5';

const md5hex = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

/* 把抓到的字段串拆成对象（键与值都做 URL 解码）。 */
function parseForm(body) {
  const out = {};
  for (const part of String(body || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try { out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' ')); }
    catch (e) { out[k] = v; }
  }
  return out;
}

/* 逐字复刻 base.py:620。四个 id 都会参与，playingTime 与 duration 要乘 1000。 */
function chaoxingEnc(f) {
  const playingTime = Math.round(Number(f.playingTime) || 0);
  const duration = Math.round(Number(f.duration) || 0);
  const s = '[' + f.clazzId + '][' + f.userid + '][' + f.jobid + '][' + f.objectId + '][' +
            (playingTime * 1000) + '][' + SALT + '][' + (duration * 1000) + '][0_' + duration + ']';
  return { enc: md5hex(s), input: s };
}

/* 用抓到的真实上报当模板，拼出这一发要用的完整参数。
   nothing 是凭空发明的：字段名全部来自抓到的那条真实请求。 */
function buildParams(tplFields, playingTime, opts) {
  const o = opts || {};
  const f = Object.assign({}, tplFields);
  const duration = Math.round(Number(o.duration || f.duration) || 0);
  const pt = Math.max(0, Math.min(duration || 1e9, Math.round(Number(playingTime) || 0)));

  f.playingTime = String(pt);
  f.duration = String(duration);
  /* base.py 就是这么写的：clipTime 是 "0_" 拼上总长，不是纯数字。
     我原来那版按数值去改写时间字段，碰到这种值直接解析成 NaN —— 改了个寂寞。 */
  f.clipTime = '0_' + duration;
  /* isdrag：base.py 首发用 4（拖到底），后续循环用默认 3 */
  f.isdrag = String(o.first ? 4 : 3);
  if (f.view === undefined) f.view = 'pc';
  if (f.dtype === undefined) f.dtype = 'Video';
  /* rt 拿不到就按 base.py 的兜底：先试 0.9，再试 1 */
  if (f.rt === undefined || f.rt === '') f.rt = String(o.rt || '1');
  f._t = String(Date.now());

  const e = chaoxingEnc(f);
  f.enc = e.enc;
  return { params: f, encInput: e.input };
}

/* ============================================================
 * 四、控制器：driver.js 只用它三个方法
 * ============================================================ */
function makeHeartbeat(cfg) {
  const speed = Number(cfg && cfg.speed) || 0;
  const tickMs = Math.max(500, Number(cfg && cfg.tickMs) || 2000);
  /* 最多发几条。默认 HB_MAX_TRIES；能调是为了让自检不必真等 8×2 秒，
     顺带也让你在真机上想保守一点时有个旋钮。 */
  const maxTries = Math.max(1, Number(cfg && cfg.maxTries) || HB_MAX_TRIES);
  const jump = !(cfg && cfg.jump === false);
  const log = (cfg && cfg.log) || (() => {});
  /* 样本文件路径可换：自检脚本要拿假样本跑状态机，绝不能让它写进
     真正的那份 伪心跳-样本.json —— 否则真样本会被测试数据顶掉。 */
  const sampleFile = (cfg && cfg.sampleFile) || SAMPLE_FILE;

  const st = {
    installed: false, announcedWait: false, announcedReady: false,
    announcedDone: false, doneReason: '', lastBeacon: 0, sentUpTo: 0, sampleDumped: false,
    lastLine: '', rejectStreak: 0, started: Date.now(), chapter: '', announcedNoDur: false,
    /* 照 base.py 的节奏：第一发报满，之后按倍速补发。这两个字段记它的账。 */
    firstSent: false, tries: 0, lastSent: 0, encInput: '', doneUncertain: false,
  };

  const api = {
    enabled: speed > 1,
    speed,

    /* 每轮调一次。s = PROBE 的结果（含 video），v = s.video。
       返回 { done, reason, line } —— done 为真时 driver 直接翻节。 */
    async tick(ev, s, v) {
      if (!api.enabled) return { done: false };
      const dur = (v && v.dur) || 0;

      /* 换章就把这一章的账清零（进度、日志节流、完成标记）。
         样本文件不重置 —— 它的用途是「抓到一次真实上报」，跨章同样有效，
         而且第一章没视频时本来就没抓到，重置反而会把好样本弄丢。 */
      const chap = (s && s.chapter) || '';
      if (chap && chap !== st.chapter) {
        st.chapter = chap;
        st.sentUpTo = 0; st.lastBeacon = 0;
        st.announcedWait = false; st.announcedReady = false;
        st.announcedDone = false; st.doneReason = '';
        st.rejectStreak = 0; st.announcedNoDur = false;
        st.firstSent = false; st.tries = 0; st.lastSent = 0; st.doneUncertain = false;
      }
      if (st.announcedDone) {
        /* 【必须把结论一起带上】第一次 done 之后 driver 还会推好几轮，
           如果这里只回一个裸的 done:true，driver 拿到的就没有 uncertain，
           那一条"记进待办"的动作可能被漏掉 —— 漏了就等于悄悄替你伪造了完成标记。 */
        return { done: true, line: '', reason: st.doneReason, uncertain: !!st.doneUncertain };
      }

      const ping = await ev(PING_EXPR);
      if (!ping || !ping.ok) {
        const inst = await ev(installExpr(speed));
        if (!inst || inst.__err || !inst.ok) return { done: false };
      }
      st.installed = true;

      const hb = await ev(STATUS_EXPR);
      if (!hb || !hb.ok) return { done: false };

      /* 落一次样本供事后分析（只落一次，不覆盖好样本） */
      if (hb.tpl && !st.sampleDumped) {
        st.sampleDumped = true;
        try {
          const formula = guessFormula(hb.tpl);
          fs.writeFileSync(sampleFile, JSON.stringify({
            生成时间: new Date().toISOString(),
            说明: '这是被 hook 抓到的第一条真实进度上报。URL 与 body 逐字保留。',
            上报URL: hb.tpl.url,
            上报body: hb.tpl.body,
            字段: Object.fromEntries(String(hb.tpl.body).split('&').map((p) => {
              const i = p.indexOf('='); return i < 0 ? [p, ''] : [decodeURIComponent(p.slice(0, i)), p.slice(i + 1)];
            })),
            页面哈希日志: hb.hashes,
            dtoken反推: hb.dtokenFrom,
            node侧候选公式: formula,
            当前状态: { 补报条数: hb.sent, 改写条数: hb.rewritten, 成功: hb.okCount, 被拒: hb.badCount, 最后响应: hb.lastResp },
          }, null, 2), 'utf8');
          log('（伪心跳：已抓到真实上报样本，写到 伪心跳-样本.json）');
        } catch (e) { /* 写不了就算了，不影响运行 */ }
      }

      if (!hb.tpl) {
        if (!st.announcedWait) {
          st.announcedWait = true;
          log('伪心跳 ' + speed + 'x：已挂钩子，正在等播放器发出第一条真实上报（拿到它才能照着抄）。');
        }
        return { done: false };
      }

      if (!st.announcedReady) {
        st.announcedReady = true;
        log('伪心跳 ' + speed + 'x：样本到手，开始按 ' + speed + ' 倍速补报（每 ' +
            Math.round(tickMs / 1000) + ' 秒一条，总长 ' + Math.round(dur) + 's）');
      }

      /* 【没有总长就不发报】
         读不到 duration 的时候，进度会一路往上涨却没有天花板 ——
         那种 clipTime 超过视频真实长度的请求发出去，轻则被拒，重则直接吃风控。
         所以这里宁可等着：卡片页的 duration 一般几秒内就出来了。 */
      if (!(dur > 0)) {
        if (!st.announcedNoDur) {
          st.announcedNoDur = true;
          log('伪心跳：还读不到视频总长（duration），先不发报，等它加载出来。');
        }
        return { done: false };
      }

      /* 抓到的字段表：字段名一个都不是编的，全部来自那条真实上报。 */
      const tplFields = parseForm(hb.tpl.body);
      const fDur = Math.round(Number(tplFields.duration) || dur);
      const now = Date.now();
      let line = '';

      if (!(fDur > 0)) {
        if (!st.announcedNoDur) {
          st.announcedNoDur = true;
          log('伪心跳：样本里读不到视频总长（duration），先不发报。');
        }
        return { done: false };
      }

      /* ---- 第一发：直接报满 ----
         照 base.py:850 抄：它一上来就 playingTime=duration、isdrag=4，
         服务端认的话作者注释里叫「任务瞬间完成」。
         认不认由响应里的 isPassed 说了算，不是我们说了算。 */
      if (!st.firstSent) {
        st.firstSent = true;
        st.lastSent = now;
        st.tries = 1;
        const built = buildParams(tplFields, fDur, { duration: fDur, first: true });
        st.encInput = built.encInput;
        const r = await ev(sendLogExpr(built.params));
        if (r && r.ok === false) {
          log('✗ 伪心跳：上报发不出去（' + r.why + '）');
          return { done: false, fatal: r.why };
        }
        line = '伪心跳 ' + speed + 'x：首发已发（直接按看完上报 ' + fDur + 's，isdrag=4），等平台回话';
      } else if (now - st.lastSent >= tickMs && st.tries < maxTries) {
        /* ---- 没认才进补发 ----
           base.py 的 _speed 就是干这个的：把「真实过了多久」乘上倍速当进度；
           它注释里还写明「最后一条要发几次才算完成」，所以最后一发仍然发满值。 */
        const step = speed * (tickMs / 1000);
        const from = Math.max(st.sentUpTo || 0, hb.progress || 0);
        const target = Math.min(fDur, from + step);
        st.sentUpTo = target;
        st.lastSent = now;
        st.tries += 1;
        const built = buildParams(tplFields, target, { duration: fDur, first: target >= fDur });
        const r = await ev(sendLogExpr(built.params));
        line = (r && r.ok === false)
          ? ('伪心跳：补报没发出去（' + r.why + '）')
          : ('伪心跳 ' + speed + 'x：已补 ' + st.tries + ' 发，最后一条报 ' + Math.round(target) + '/' + fDur + 's');
      }

      const hb2 = await ev(STATUS_EXPR);
      if (hb2 && hb2.ok) {
        if (hb2.sent > 0) {
          line = '伪心跳 ' + speed + 'x：共发 ' + hb2.sent + ' 条，最后一条 ' +
                 Math.round(hb2.progress || 0) + '/' + fDur + 's   平台回话 ' +
                 (hb2.lastVerdict || '无') + (hb2.lastPassed ? '   isPassed=true ✅' : '') +
                 (hb2.badCount ? ('（被拒 ' + hb2.badCount + ' 条）') : '');
        }

        /* 【完成判据：isPassed】base.py 全程只认这一个字段 ——
           successful:true 只说明请求收下了，不代表这一节在服务端算完成。
           这条判据是那次对照研究里 6 条「无论走哪条路都值得抄」的第 1 条：
           完成状态一律以服务端字段为准，从不相信本地计时器。 */
        if (hb2.lastPassed) {
          if (!st.announcedDone) {
            st.announcedDone = true;
            st.doneUncertain = false;      /* 平台明确回了 isPassed=true，这是确定的完成 */
            st.doneReason = '平台回了 isPassed=true —— 这一节在服务端算完成了（共发 ' + hb2.sent +
                            ' 条上报，' + (st.tries > 1 ? ('第 ' + st.tries + ' 条才认') : '首发就认') + '）';
            log('✅ 伪心跳：' + st.doneReason);
          }
          if (jump) {
            const jr = await ev(JUMP_EXPR);
            if (jr && jr.ok) log('  ↳ 已把播放位置推到片尾（让页面自己走完它的完成流程）');
          }
          return { done: true, reason: st.doneReason, line: '' };
        }

        /* 平台明确全拒 —— 这条路在这门课上是走不通的，停下来说清楚，
           不要拿几十条废请求去撞验证码。 */
        if (hb2.badCount >= 3 && hb2.okCount === 0) {
          const why = '连续 ' + hb2.badCount + ' 条上报被平台拒绝（最后回话：' +
                      String(hb2.lastResp || '').slice(0, 120) + '）';
          log('✗ 伪心跳：' + why);
          log('  ↳ 样本已存在 伪心跳-样本.json —— 把这个文件发给小代码酱，照真实字段对一遍 enc。');
          return { done: false, fatal: why };
        }

        /* 发满上限还没拿到 isPassed：如实收手并记账，绝不当成功。 */
        if (st.tries >= maxTries) {
          const why = '已按 ' + speed + ' 倍速发满 ' + st.tries + ' 条（最后一条报到 ' +
                      Math.round(st.sentUpTo || 0) + '/' + fDur + 's），平台始终没回 isPassed —— ' +
                      '认没认要看卡片上的任务点标记';
          if (!st.announcedDone) {
            st.announcedDone = true;
            st.doneUncertain = true;       /* 没拿到 isPassed —— 认没认不知道，得记账 */
            st.doneReason = why;
            log('⚠ 伪心跳：' + why);
          }
          return { done: true, reason: why, line: '', uncertain: true };
        }
      }

      return { done: false, line };
    },

    summary() {
      return st.announcedDone
        ? ('伪心跳 ' + speed + 'x —— ' + st.doneReason)
        : ('伪心跳 ' + speed + 'x —— 本轮没走完（' + (st.installed ? '钩子装上了但没报满' : '没装到钩子') + '）');
    },
  };

  return api;
}

module.exports = {
  makeHeartbeat,
  SAMPLE_FILE,
  HB_MAX_TRIES,
  /* 签名与参数构造（自检要单独验这几条，公式必须与 base.py:620 逐字一致） */
  SALT,
  chaoxingEnc,
  buildParams,
  parseForm,
  guessFormula,
  installExpr,
  STATUS_EXPR,
  PING_EXPR,
  sendLogExpr,
  beaconExpr,   /* 备用路径：不改写、不重算时用的老表达式，当前主路不走它 */
  JUMP_EXPR,
  /* 下面这两个是给 离线自检 用的：页面脚本里的工具函数没法直接单测，
     这里把原文放出来，测试脚本用 new Function 搭个最小沙箱去跑它。 */
  INSTALL_BODY,
  FIND_MEDIA,
};
