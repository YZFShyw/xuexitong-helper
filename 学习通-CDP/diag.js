/* 一次性诊断：把课程页每个执行上下文里的 视频 / iframe / 任务点 / 目录 全 dump 出来。
   用法：  node diag.js            人类可读
           node diag.js --json     机器可读
   环境变量：CDP_PORT（默认 9222）
   零依赖，只用 Node 自带的 WebSocket / fetch。                              */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const AS_JSON = process.argv.includes('--json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- CDP 底层 ---------- */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    for (const f of listeners) { try { f(m); } catch {} }
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    });
  return { ws, send, on: (f) => listeners.push(f) };
}

async function pickTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  const chosen =
    pages.find((p) => p.url.includes('studentstudy')) ||
    pages.find((p) => p.url.includes('chaoxing')) ||
    pages[0];
  if (!chosen) throw new Error('没有找到可用的页面标签');
  return { chosen, pages };
}

/* ---------- 在页面里跑的探针 ---------- */
const PROBE = String.raw`(function(){
  function txt(el, n){
    if(!el) return '';
    var s = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return s.slice(0, n || 60);
  }
  function vis(el){
    if(!el) return false;
    if(el.getClientRects && el.getClientRects().length) return true;
    return !!el.offsetParent;
  }
  function clsOf(el){
    var c = el.className;
    if(typeof c === 'string') return c.slice(0, 70);
    return '';
  }
  var o = {};
  o.href = location.href.slice(0, 150);
  o.isTop = (window === window.top);
  o.title = (document.title || '').slice(0, 60);

  /* --- 视频 --- */
  o.videos = [];
  var vs = document.querySelectorAll('video, audio');
  for (var i = 0; i < vs.length; i++) {
    var v = vs[i];
    var src = '';
    try { src = v.currentSrc || v.src || ''; } catch (e) {}
    if (!src) { var s = v.querySelector && v.querySelector('source'); if (s) src = s.src || s.getAttribute('src') || ''; }
    o.videos.push({
      i: i,
      tag: v.tagName,
      id: v.id || '',
      cls: clsOf(v),
      src: String(src).slice(0, 120),
      rs: v.readyState,
      dur: Math.round((v.duration || 0) * 10) / 10,
      cur: Math.round((v.currentTime || 0) * 10) / 10,
      paused: v.paused,
      ended: v.ended,
      rate: v.playbackRate,
      muted: v.muted,
      w: v.offsetWidth,
      h: v.offsetHeight,
      vis: vis(v),
      inFinish: !!v.closest('.ans-job-finished, .ans-job-finish, .icon_Completed')
    });
  }

  /* --- iframe --- */
  o.iframes = [];
  var fs = document.querySelectorAll('iframe');
  for (var j = 0; j < fs.length; j++) {
    var f = fs[j];
    o.iframes.push({
      i: j,
      id: f.id || '',
      cls: clsOf(f),
      src: String(f.src || '').slice(0, 120),
      w: f.offsetWidth,
      h: f.offsetHeight,
      vis: vis(f),
      hasVideo: (function(){ try { return !!(f.contentDocument && f.contentDocument.querySelector('video')); } catch(e){ return null; } })()
    });
  }

  /* --- 任务点 / 附件容器 --- */
  var TASK_SEL = 'div.ans-attach-ct, .ans-attach-online, .ans-cc, [class*="ans-attach"], .ans-job-finished, .ans-job-finish';
  o.tasks = [];
  var seen = [];
  var ts = document.querySelectorAll(TASK_SEL);
  for (var k = 0; k < ts.length && o.tasks.length < 25; k++) {
    var t = ts[k];
    if (seen.indexOf(t) >= 0) continue;
    seen.push(t);
    o.tasks.push({
      i: o.tasks.length,
      cls: clsOf(t),
      tag: t.tagName,
      id: t.id || '',
      txt: txt(t, 55),
      w: t.offsetWidth,
      h: t.offsetHeight,
      vis: vis(t),
      hasVideo: !!t.querySelector('video'),
      hasIframe: !!t.querySelector('iframe'),
      finishedSelf: /ans-job-finished|ans-job-finish/.test(clsOf(t)),
      finishedInside: !!t.querySelector('.ans-job-finished, .ans-job-finish, .icon_Completed, [class*="jobFinish"], [class*="job-finished"]'),
      done: /已完成|已完成任务点/.test(txt(t, 40))
    });
  }
  o.ansJobFinished = document.querySelectorAll('.ans-job-finished, .ans-job-finish').length;
  o.iconCompleted = document.querySelectorAll('.icon_Completed').length;

  /* --- 文档阅读区 --- */
  o.docRoot = null;
  var docSel = ['#panView', '#container', '#scrollBox', '.reader-container', '#docContainer'];
  for (var d = 0; d < docSel.length; d++) {
    var de = document.querySelector(docSel[d]);
    if (de) {
      o.docRoot = {
        sel: docSel[d],
        w: de.offsetWidth,
        h: de.offsetHeight,
        sh: de.scrollHeight,
        ch: de.clientHeight,
        scrollable: de.scrollHeight > de.clientHeight + 20
      };
      break;
    }
  }

  /* --- 目录 --- */
  var catSel = ['.posCatalog_active .posCatalog_name', 'li.currents .posCatalog_name', '.currents .posCatalog_name', '.posCatalog_active'];
  o.catalog = [];
  for (var c = 0; c < catSel.length && !o.catalog.length; c++) {
    var cs = document.querySelectorAll(catSel[c]);
    for (var x = 0; x < cs.length && x < 5; x++) {
      o.catalog.push({ sel: catSel[c], txt: txt(cs[x], 50), cls: clsOf(cs[x].parentElement || cs[x]) });
    }
  }

  /* --- 播放按钮候选（可见性 + 位置） --- */
  o.playBtns = [];
  var pbSel = ['.vjs-big-play-button', '.vjs-play-control', '.prism-big-play-btn', '.xgplayer-play',
               '[class*="big-play"]', '[class*="play-btn"]', '[class*="playButton"]'];
  for (var p = 0; p < pbSel.length; p++) {
    var ps = document.querySelectorAll(pbSel[p]);
    for (var q = 0; q < ps.length && o.playBtns.length < 12; q++) {
      var pe = ps[q];
      var r = null;
      try { r = pe.getBoundingClientRect(); } catch (e) {}
      o.playBtns.push({
        sel: pbSel[p],
        cls: clsOf(pe),
        vis: vis(pe),
        txt: txt(pe, 20),
        x: r ? Math.round(r.left + r.width / 2) : null,
        y: r ? Math.round(r.top + r.height / 2) : null,
        w: r ? Math.round(r.width) : null,
        h: r ? Math.round(r.height) : null
      });
    }
  }

  /* --- 播放器容器线索 --- */
  o.playerHosts = [];
  var phSel = ['#video', '.videoCont', '.ans-video', '[class*="video"]', '[id*="video"]', '.prism-player', '.vjs-tech'];
  for (var h = 0; h < phSel.length && o.playerHosts.length < 12; h++) {
    var hs = document.querySelectorAll(phSel[h]);
    for (var y = 0; y < hs.length && o.playerHosts.length < 12; y++) {
      var he = hs[y];
      o.playerHosts.push({ sel: phSel[h], tag: he.tagName, cls: clsOf(he), id: he.id || '', w: he.offsetWidth, h: he.offsetHeight, vis: vis(he), vids: he.querySelectorAll('video').length });
    }
  }

  o.ready = document.readyState;
  return o;
})()`;

/* ---------- 主流程 ---------- */
(async () => {
  const { chosen, pages } = await pickTarget();
  if (!AS_JSON) {
    console.log('=== 学习通页面诊断 ===');
    console.log('端口 ' + PORT + '，共 ' + pages.length + ' 个页面标签：');
    for (const p of pages) console.log('  - ' + String(p.title).slice(0, 40) + '  |  ' + String(p.url).slice(0, 95));
    console.log('');
    console.log('目标：' + chosen.title);
    console.log('      ' + String(chosen.url).slice(0, 130));
    console.log('');
  }

  const c = await connect(chosen.webSocketDebuggerUrl);
  const ctxList = [];
  c.on((m) => {
    if (m.method === 'Runtime.executionContextCreated') {
      ctxList.push({ ctx: m.params.context, sessionId: m.sessionId });
    }
  });
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(3000);

  const results = [];
  for (const entry of ctxList) {
    const ctx = entry.ctx;
    if (!ctx || !ctx.id || (ctx.auxData && ctx.auxData.isDefault === false)) continue;
    let val = null;
    try {
      const r = await c.send(
        'Runtime.evaluate',
        { expression: PROBE, returnByValue: true, awaitPromise: false, contextId: ctx.id },
        entry.sessionId
      );
      val = r && r.result && r.result.result && r.result.result.value;
    } catch (e) {
      val = { error: String(e.message || e) };
    }
    results.push({ ctxId: ctx.id, sessionId: entry.sessionId || null, origin: ctx.origin, name: ctx.name, value: val });
  }

  if (AS_JSON) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('扫描到 ' + results.length + ' 个默认执行上下文：');
    console.log('');
    for (const r of results) {
      const v = r.value;
      if (!v) { console.log('  ctx#' + r.ctxId + '  ' + r.origin + '  —— 无数据'); continue; }
      if (v.error) { console.log('  ctx#' + r.ctxId + '  ' + r.origin + '  —— 出错: ' + v.error); continue; }
      const interesting =
        (v.videos && v.videos.length) || (v.iframes && v.iframes.length) ||
        (v.playerHosts && v.playerHosts.length) || (v.tasks && v.tasks.length);
      const head = '  ctx#' + r.ctxId + (r.sessionId ? ' [子会话]' : ' [主会话]') + '  ' + (v.isTop ? '顶层' : '子框架') + '  ' + String(v.href).slice(0, 90);
      if (!interesting && !v.isTop) { console.log(head + '   —— 空框架'); continue; }
      console.log(head);
      console.log('      就绪=' + v.ready + '  title=' + v.title);

      if (v.videos && v.videos.length) {
        console.log('      ── 视频 ' + v.videos.length + ' 个 ──');
        for (const vid of v.videos) {
          console.log('        #' + vid.i + ' <' + vid.tag + '> id=' + (vid.id || '-') + ' cls=' + (vid.cls || '-'));
          console.log('           ' + vid.cur + '/' + vid.dur + 's  rs=' + vid.rs + (vid.paused ? ' 暂停' : ' 播放中') + ' 倍速' + vid.rate + (vid.muted ? ' 静音' : '') + (vid.ended ? ' 已结束' : ''));
          console.log('           尺寸 ' + vid.w + 'x' + vid.h + ' 可见=' + vid.vis + ' 在完成区=' + vid.inFinish);
          console.log('           src=' + (vid.src ? vid.src : '(空 —— 源还没挂上)'));
        }
      }
      if (v.iframes && v.iframes.length) {
        console.log('      ── iframe ' + v.iframes.length + ' 个 ──');
        for (const f of v.iframes) {
          console.log('        #' + f.i + ' id=' + (f.id || '-') + ' ' + f.w + 'x' + f.h + ' 可见=' + f.vis + ' 内含video=' + f.hasVideo);
          console.log('           src=' + (f.src || '(空)'));
        }
      }
      if (v.tasks && v.tasks.length) {
        console.log('      ── 任务点 ' + v.tasks.length + ' 个 ──');
        for (const t of v.tasks) {
          console.log('        #' + t.i + ' ' + t.tag + '.' + (t.cls || '-') + ' ' + t.w + 'x' + t.h + ' 可见=' + t.vis +
            ' video=' + t.hasVideo + ' iframe=' + t.hasIframe + ' 完成标记=' + (t.finishedSelf || t.finishedInside) + ' 文案含已完成=' + t.done);
          console.log('           "' + t.txt + '"');
        }
      }
      console.log('      已完成任务点(.ans-job-finished)=' + v.ansJobFinished + '  icon_Completed=' + v.iconCompleted);
      if (v.docRoot) {
        console.log('      文档区 ' + v.docRoot.sel + ' ' + v.docRoot.w + 'x' + v.docRoot.h +
          ' scrollHeight=' + v.docRoot.sh + ' clientHeight=' + v.docRoot.ch + ' 可滚动=' + v.docRoot.scrollable);
      } else {
        console.log('      文档区：无');
      }
      if (v.catalog && v.catalog.length) {
        console.log('      目录当前位置：' + v.catalog.map((x) => x.txt).join(' / '));
      }
      if (v.playerHosts && v.playerHosts.length) {
        console.log('      ── 播放器容器候选 ──');
        for (const ph of v.playerHosts) {
          console.log('        ' + ph.sel + ' <' + ph.tag + '> id=' + (ph.id || '-') + ' cls=' + (ph.cls || '-') + ' ' + ph.w + 'x' + ph.h + ' 可见=' + ph.vis + ' 内含video=' + ph.vids);
        }
      }
      if (v.playBtns && v.playBtns.length) {
        console.log('      ── 播放按钮候选 ──');
        for (const pb of v.playBtns) {
          console.log('        ' + pb.sel + ' cls=' + (pb.cls || '-') + ' 可见=' + pb.vis + ' 坐标=(' + pb.x + ',' + pb.y + ') ' + pb.w + 'x' + pb.h + ' "' + pb.txt + '"');
        }
      }
      console.log('');
    }
  }
  c.ws.close();
})().catch((e) => {
  console.error('诊断失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
