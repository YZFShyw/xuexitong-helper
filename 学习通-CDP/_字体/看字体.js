/* 字体反爬取证 —— 把 @font-face 里的内嵌字体挖出来
 *
 * 用法：
 *   node 看字体.js            只看元信息（字体族、base64 大小）
 *   node 看字体.js --dump     把字体解出来存成 _字体\font-*.ttf
 *
 * ------------------------------------------------------------------
 * 背景：学习通答题页的题干和选项用了一个叫 font-cxsecret 的字体。
 * DOM 里存的是"替换字"（比如 庘庝律），浏览器用内嵌的 base64 字体
 * 把字形画回真字（尼布楚）。所以：
 *   innerText 读出来 = 乱码
 *   屏幕上看到的     = 真字
 *
 * 想破它只有两条路：
 *   A. 截图 + OCR         —— 作者走的路，受截图质量和识别率影响
 *   B. 把字体解出来       —— 字体里存的是真字的字形轮廓，
 *                            拿到字形就能反查真字，零识别误差
 *
 * 这个脚本干的是 B 的第一步：把字体文件原样挖出来。
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.CDP_PORT || 9222);
const DUMP = process.argv.includes('--dump');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('连不上调试端口')));
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (onEvent) onEvent(m);
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    });
  return { ws, send };
}

/* 只返回元信息，不把几百 KB 的 base64 拉回来 */
const PROBE_META = `(function () {
  var out = { url: location.href.slice(0, 120), fonts: [], fontFaces: 0, err: '' };
  try {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var ss = document.styleSheets[i];
      var rules = null;
      try { rules = ss.cssRules; } catch (e) { out.err += 'sheet' + i + '跨域; '; continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        if (!r || r.type !== 5) continue;            /* 5 = FONT_FACE_RULE */
        out.fontFaces++;
        var fam = (r.style.getPropertyValue('font-family') || '').replace(/["']/g, '');
        var src = r.style.getPropertyValue('src') || '';
        var m = src.match(/base64,([A-Za-z0-9+/=\\s]+)/);
        out.fonts.push({
          family: fam,
          srcLen: src.length,
          format: (src.match(/format\\(["']?([a-z0-9-]+)/i) || [])[1] || '?',
          b64Len: m ? m[1].replace(/\\s/g, '').length : 0,
          head: src.slice(0, 100)
        });
      }
    }
  } catch (e) { out.err += String(e); }
  return out;
})()`;

/* 只把某一个字体族的 base64 拉回来 */
const PROBE_DATA = (family) => `(function () {
  var want = ${JSON.stringify(family)};
  for (var i = 0; i < document.styleSheets.length; i++) {
    var ss = document.styleSheets[i], rules = null;
    try { rules = ss.cssRules; } catch (e) { continue; }
    if (!rules) continue;
    for (var j = 0; j < rules.length; j++) {
      var r = rules[j];
      if (!r || r.type !== 5) continue;
      var fam = (r.style.getPropertyValue('font-family') || '').replace(/["']/g, '');
      if (fam !== want) continue;
      var src = r.style.getPropertyValue('src') || '';
      var m = src.match(/base64,([A-Za-z0-9+/=\\s]+)/);
      if (m) return { ok: true, b64: m[1].replace(/\\s/g, '') };
    }
  }
  return { ok: false };
})()`;

(async () => {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch (e) {
    console.error('连不上调试端口 ' + PORT + '。先双击 启动.cmd。');
    process.exit(1);
  }
  const pages = list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  const page = pages.find((p) => /exam|work|quiz|test|studentstudy|chaoxing/i.test(p.url)) || pages[0];
  if (!page) { console.error('没有可用的标签页'); process.exit(1); }

  const ctxList = [];
  const c = await connect(page.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Runtime.executionContextCreated') ctxList.push({ ctx: m.params.context, sessionId: m.sessionId });
  });
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(2500);

  console.log('扫到 ' + ctxList.length + ' 个执行上下文');
  console.log('');

  const jobs = [];
  for (const entry of ctxList) {
    const ctx = entry.ctx;
    if (!ctx || !ctx.id || !ctx.origin || !/^https?:/.test(ctx.origin)) continue;
    const r = await c.send('Runtime.evaluate',
      { expression: PROBE_META, returnByValue: true, contextId: ctx.id }, entry.sessionId);
    const v = r && r.result && r.result.result && r.result.result.value;
    if (!v) continue;
    if (v.fontFaces) {
      console.log('--- ' + String(v.url).slice(0, 100));
      for (const f of v.fonts) {
        console.log('    font-family: ' + (f.family || '(空)') +
          '   format=' + f.format + '   base64=' + f.b64Len + ' 字符 (~' + Math.round(f.b64Len * 3 / 4 / 1024) + ' KB)');
      }
      jobs.push({ sessionId: entry.sessionId, ctxId: ctx.id, fonts: v.fonts });
    }
  }

  const targets = [];
  for (const job of jobs) for (const f of job.fonts) if (f.b64Len && f.family) targets.push({ job, f });

  if (!targets.length) { console.log('\n没找到内嵌 base64 字体。'); c.ws.close(); process.exit(0); }

  console.log('\n找到 ' + targets.length + ' 个内嵌字体');
  if (!DUMP) { console.log('（加 --dump 就把它们解出来存到 _字体\\）'); c.ws.close(); process.exit(0); }

  const dir = __dirname;
  fs.mkdirSync(dir, { recursive: true });

  let n = 0;
  for (const t of targets) {
    const r = await c.send('Runtime.evaluate',
      { expression: PROBE_DATA(t.f.family), returnByValue: true, contextId: t.job.ctxId }, t.job.sessionId);
    const v = r && r.result && r.result.result && r.result.result.value;
    if (!v || !v.ok) { console.log('  取 ' + t.f.family + ' 失败'); continue; }
    n++;
    const buf = Buffer.from(v.b64, 'base64');
    const fp = path.join(dir, 'font-' + String(n).padStart(2, '0') + '-' + t.f.family + '.ttf');
    fs.writeFileSync(fp, buf);
    const sig = buf.length >= 4 ? buf.readUInt32BE(0).toString(16) : '????';
    console.log('  ' + path.basename(fp) + '   ' + buf.length + ' 字节   魔术字=' + sig +
      (sig === '10000' ? ' (TrueType)' : sig === '4f54544f' ? ' (OpenType/CFF)' : ' (未知)'));
  }

  console.log('\n已存到 ' + dir);
  c.ws.close();
})().catch((e) => { console.error('出错: ' + (e && e.message ? e.message : e)); process.exit(1); });
