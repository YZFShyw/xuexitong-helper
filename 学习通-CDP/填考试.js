/* 填考试.js —— 对着「考试」页跑一次：读当前题 → 问 AI → 点选项 → 下一题。
 *
 * 只填，**绝不点提交/交卷**。交卷那一步永远留给本人按。
 *
 * 【和 填作业.js 的区别】
 * 作业页一页几十道题、一起答；考试页是**一页一题**（.singleQuesId），
 * 靠 getTheNextQuestion(1) 翻页，而且左边挂着倒计时（#timer）。
 * 所以这里不能走 fillFromText 那套"整章对位"，只能一题一题来。
 *
 * 【选项为什么按"显示字母"对位、而不是按 data】
 * 考试页的选项长这样（真页面实测）：
 *     <div class="clearfix answerBg singleoption" onclick="addChoice(this);" role="radio">
 *       <span data="C" qid="886257428" class="... num_option fl">A</span>
 *       <div class="fl answer_p">用水冲灭</div>
 *     </div>
 * 平台的 addChoice() 把 span 的 **data** 拼进 #answer —— 而这个 data 是**答案键**，
 * 不是屏幕上那个字母（打乱选项时显示 A、data 可能是 C）。
 * 所以：模型看着屏幕上的 A/B/C/D 选，我们就点那个**显示字母**对应的盒子；
 * 点完再拿 #answer<qid> 的值回读校验（它应该是那个盒子的 data）。
 *
 * 【不写题库、不写缓存】
 * 考试是一次性的，答案不落盘，免得污染平时那套题库。
 *
 * 用法：
 *   node 填考试.js --dry              只读当前题 + 问一次 AI，不点任何东西
 *   node 填考试.js                    从当前题一路填到底（跳过已经答过的）
 *   node 填考试.js --force            连已经答过的也重填
 *   node 填考试.js --max=20           最多处理 20 题（防止手滑一口气跑完）
 *   node 填考试.js --port=9222
 */
'use strict';
const Q = require('./答题助手.js');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 9222;
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
/* --check：只读一遍每题填了什么，不问 AI、不点任何东西（跑完自己核对用） */
const CHECK = process.argv.includes('--check');
/* --from=N：先把页面导到第 N 题（考试页翻题就是 URL 里的 start=N） */
const FROM = Number((process.argv.find((a) => a.startsWith('--from=')) || '').split('=')[1]) || 0;
const MAX = Number((process.argv.find((a) => a.startsWith('--max=')) || '').split('=')[1]) || 200;

const ts = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log('[' + ts() + '] ' + a.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP ---------------- */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.id && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); }
    };
    ws.onerror = () => reject(new Error('CDP 连接出错'));
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
      },
      close() { try { ws.close(); } catch (e) {} },
    });
  });
}

async function pickTarget() {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const pages = list.filter((x) => x.type === 'page');
  return pages.find((x) => /exam-ans|reVersionTestStartNew/i.test(x.url || '')) || null;
}

/* ---------------- 页面侧：读当前题 ---------------- */
const READ_Q = `(function(){
  function txt(el){ try { return String(el.innerText || el.textContent || ''); } catch(e){ return ''; } }
  function vis(el){ try { var r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; } catch(e){ return false; } }
  function ctr(el){ try { var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) }; } catch(e){ return null; } }
  var q = document.querySelector('.singleQuesId') || document.querySelector('.questionLi') || document.querySelector('.TiMu');
  var qid = q ? String(q.getAttribute('data') || '') : '';
  var stemEl = document.querySelector('.mark_name') || q;
  var stem = txt(stemEl).replace(/\\s+/g, ' ').trim();
  var boxes = q ? q.querySelectorAll('.answerBg') : [];
  var opts = [];
  for (var i = 0; i < boxes.length; i++){
    if (!vis(boxes[i])) continue;
    var sp = boxes[i].querySelector('span.num_option, span.num_option_dx');
    var data = sp ? String(sp.getAttribute('data') || '').trim() : '';
    var show = sp ? txt(sp).replace(/\\s+/g, '').trim() : '';
    var tEl = boxes[i].querySelector('.answer_p');
    var body = tEl ? txt(tEl) : txt(boxes[i]);
    opts.push({
      idx: i, data: data, show: show,
      text: body.replace(/\\s+/g, ' ').trim().slice(0, 300),
      role: String(boxes[i].getAttribute('role') || ''),
      aria: String(boxes[i].getAttribute('aria-checked') || ''),
      c: ctr(boxes[i])
    });
  }
  /* 题型：先看页面写的「(多选题)」，再看 role */
  var type = '';
  var m = stem.match(/[（(]\\s*(单选|多选|判断|填空|简答)\\s*题?/);
  if (m) type = m[1] + '题';
  if (!type){
    var roles = opts.map(function(o){ return o.role; }).join(',');
    if (roles.indexOf('checkbox') >= 0) type = '多选题';
    else if (roles.indexOf('radio') >= 0) type = '单选题';
  }
  var ansEl = qid ? document.querySelector('#answer' + qid) : null;
  /* 「下一题」按钮（最后一题可能没有） */
  var next = null, all = document.querySelectorAll('a, button, input');
  for (var k = 0; k < all.length; k++){
    var t = txt(all[k]) || String(all[k].value || '');
    if (t.replace(/\\s+/g, '') === '下一题' && vis(all[k])) { next = { c: ctr(all[k]), onclick: String(all[k].getAttribute('onclick') || '') }; break; }
  }
  /* 填空/简答的输入框 */
  var boxesIn = [];
  if (q){ var ins = q.querySelectorAll('textarea, input[type=text]'); for (var z = 0; z < ins.length; z++) if (vis(ins[z])) boxesIn.push(ctr(ins[z])); }
  return {
    qid: qid, stem: stem.slice(0, 1200), type: type || '未知',
    opts: opts, answer: ansEl ? String(ansEl.value || '') : '', next: next, inputs: boxesIn.length
  };
})()`;

/* 点「下一题」之前先把它滚到视口中间再取坐标 —— 考试页一屏放不下，
   直接拿页面加载时算的坐标去点，很可能点在视口外面（2026-10-27 实测：第 51 题点不动）。 */
const NEXT_BTN = `(function(){
  function txt(el){ try { return String(el.innerText || el.value || ''); } catch(e){ return ''; } }
  var all = document.querySelectorAll('a, button, input');
  for (var i = 0; i < all.length; i++){
    var t = txt(all[i]).replace(/\\s+/g, '');
    if (t !== '下一题') continue;
    try { all[i].scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    var r = all[i].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height),
             inView: (r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth) };
  }
  return null;
})()`;
const SYSTEM = [
  '你是考试答题助手，只输出答案本身。',
  '单选题：只输出一个大写字母，例如 B。',
  '多选题：只输出字母串，按字母序、不加分隔符，例如 ABD。',
  '判断题：只输出「对」或「错」。',
  '不要解释，不要复述题目。'
].join('\n');

async function askAI(cfg, q) {
  const lines = ['题型：' + q.type, '题干：' + q.stem, '选项：'];
  for (const o of q.opts) lines.push('  ' + (o.show || '?') + '. ' + o.text);
  const msgs = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
  const call = async (extra) => {
    const body = Object.assign({
      model: cfg.model,
      max_tokens: Q.maxTokensOf(cfg),
      ...Q.thinkParams(cfg),
      messages: msgs,
    }, extra || {});
    const r = await fetch(Q.apiUrlOf(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
    const j = await r.json();
    const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return t ? String(t).trim() : '';
  };
  /* 【思维档位和配额都从 答题设置.json 读 · 2026-10-31】
     原来这里写死 thinking:disabled + max_tokens:8000，改不动。
     现在跟放课那条链共用同一份配置（控制台里调 thinkMode / maxTokens）。
     退回逻辑只看"参数不认"这一种错：401/429/超时直接抛，别被伪装成"模型没返回正文"。 */
  let text = '';
  try { text = await call(null); } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/API 400/.test(msg)) throw e;
    text = await call({ thinking: { type: 'disabled' } });
  }
  if (!text) throw new Error('模型没返回正文（配额 ' + Q.maxTokensOf(cfg) + '，档位 ' + String(cfg.thinkMode || 'max') + '）');
  return text;
}

/* 页面写的是「多选题 / 判断题」，而 parseAnswer 只认「多选 / 判断 / 单选」——
   少一个字就会掉进单选分支，多选只取第一个字母（2026-10-27 实测踩到）。 */
function normType(type) {
  const t = String(type || '');
  if (/多选/.test(t)) return '多选';
  if (/判断/.test(t)) return '判断';
  if (/填空/.test(t)) return '填空';
  if (/简答/.test(t)) return '简答';
  if (/单选/.test(t)) return '单选';
  return t;
}

/* 把模型的答案翻译成"要点哪几个盒子" */
function pickTargets(q, answer, type) {
  const a = String(answer || '').trim();
  if (!a) return { want: [], why: '答案是空的' };
  if (type === '判断') {
    const want = /^(对|正确|是|真|T|TRUE|√)/i.test(a) ? '对' : (/^(错|错误|否|假|F|FALSE|×)/i.test(a) ? '错' : '');
    if (!want) return { want: [], why: '判断题答案认不出：' + a };
    const hit = q.opts.filter((o) => o.text.indexOf(want) >= 0 || o.show === want || o.data.toLowerCase() === (want === '对' ? 'true' : 'false'));
    return hit.length ? { want: [hit[0]], why: '' } : { want: [], why: '页面上找不到「' + want + '」这个选项' };
  }
  /* 选择：先按显示字母对位（屏幕上看到的 A/B/C/D），没有显示字母才退回 data */
  const letters = (a.toUpperCase().match(/[A-H]/g) || []);
  const uniq = [];
  for (const L of letters) if (uniq.indexOf(L) < 0) uniq.push(L);
  if (!uniq.length) return { want: [], why: '答案里没有 A-H 的字母：' + a };
  const want = [];
  const miss = [];
  for (const L of uniq) {
    const hit = q.opts.find((o) => (o.show || '').toUpperCase() === L) ||
                q.opts.find((o) => (o.data || '').toUpperCase() === L);
    if (hit) want.push(hit); else miss.push(L);
  }
  return { want, why: miss.length ? ('页面上没有这些字母：' + miss.join('')) : '' };
}

/* ---------------- 主流程 ---------------- */
(async () => {
  const cfg = Q.loadConfig();
  if (!cfg.apiKey) { log('✗ 没有 API key（答题设置.json）'); process.exit(1); }
  const t = await pickTarget();
  if (!t) { log('✗ 没找到考试页标签（exam-ans / reVersionTestStartNew）'); process.exit(1); }
  const c = await connect(t.webSocketDebuggerUrl);
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    const res = r && r.result;
    if (!res) throw new Error('CDP 没返回');
    if (res.exceptionDetails) throw new Error('页面脚本出错：' + JSON.stringify(res.exceptionDetails.exception || {}).slice(0, 120));
    return res.result ? res.result.value : null;
  };
  const clickAt = async (x, y) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
    await sleep(30);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(30);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };

  /* --from=N：考试页翻题就是 URL 里的 start=N，直接导过去比点一百次「下一题」快 */
  if (FROM > 0) {
    const u = String(t.url || '');
    const target = /([?&])start=\d+/.test(u) ? u.replace(/([?&])start=\d+/, '$1start=' + FROM) : (u + '&start=' + FROM);
    log('→ 导航到第 ' + FROM + ' 题…');
    await c.send('Page.navigate', { url: target });
    for (let w = 0; w < 12; w++) {
      await sleep(700);
      try { const st = await ev('document.readyState'); if (st === 'complete') break; } catch (e) {}
    }
    await sleep(600);
  }

  const first = await ev(READ_Q);  if (!first || !first.qid) { log('✗ 读不到当前题（.singleQuesId 没找到）'); c.close(); process.exit(1); }
  log('考试页：' + String(t.title || '') + '   当前题 qid=' + first.qid + '   题型=' + first.type +
      '   选项 ' + first.opts.length + ' 个   已填=' + (first.answer || '（空）'));

  if (DRY) {
    const raw = await askAI(cfg, first);
    const parsed = Q.parseAnswer(raw, normType(first.type));
    const pick = pickTargets(first, parsed.answer, normType(first.type));
    log('── dry run（一个都没点）');
    log('   题干：' + first.stem.slice(0, 100));
    for (const o of first.opts) log('   ' + (o.show || '?') + '/data=' + (o.data || '?') + '  ' + o.text.slice(0, 40));
    log('   AI 原始回复：' + raw.replace(/\n/g, ' | ').slice(0, 160));
    log('   解析答案：' + (parsed.answer === null ? '（认不出）' : parsed.answer) +
        (pick.why ? ('   问题：' + pick.why) : ('   将对位：' + pick.want.map((o) => o.show + '(data=' + o.data + ')').join(','))));
    c.close(); process.exit(0);
  }

  let done = 0, skipped = 0, failed = 0, emptyCount = 0, oddMulti = 0;
  let seen = new Set();
  for (let step = 0; step < MAX; step++) {
    const q = await ev(READ_Q);
    if (!q || !q.qid) { log('· 读不到题了，停。'); break; }
    if (seen.has(q.qid)) { log('· 又回到 qid=' + q.qid + '（翻页回环），停。'); break; }
    seen.add(q.qid);

    const no = (q.stem.match(/^(\d{1,3})\s*[.、]/) || [])[1] || '?';
    if (CHECK) {
      /* 只看，不动。把"空的"和"多选只填了一个"挑出来。 */
      const filled = String(q.answer || '');
      if (!filled) { emptyCount++; log('#' + no + ' ' + q.type + '：还没选 ⚠'); }
      else if (normType(q.type) === '多选' && filled.length < 2) { oddMulti++; log('#' + no + ' ' + q.type + '：只填了「' + filled + '」⚠'); }
      else skipped++;
    } else if (q.answer && !FORCE) {
      skipped++;
      log('#' + no + ' 已答（' + q.answer + '），跳过');
    } else if (!q.opts.length) {
      failed++;
      log('#' + no + ' ⚠ 没有可点的选项（可能是填空/简答），跳过 —— 题干：' + q.stem.slice(0, 60));
    } else {
      let answer = null, why = '';
      try {
        const raw = await askAI(cfg, q);
        answer = Q.parseAnswer(raw, normType(q.type)).answer;
      } catch (e) { why = '问 AI 失败：' + (e.message || e); }
      if (!answer) { failed++; log('#' + no + ' ⚠ ' + (why || '模型答不出')); }
      else {
        const pick = pickTargets(q, answer, normType(q.type));
        if (!pick.want.length) { failed++; log('#' + no + ' ⚠ 答案=' + answer + '，但' + (pick.why || '对不上选项')); }
        else {
          /* 【--force 时先把"答案里没有的已选项"取消掉】
             多选是 toggle，取消就是再点一次。单选（radio）不用管 —— 点新的自动顶掉旧的。
             只有 --force 才动它：正常跑的时候不替人改已经选好的东西。 */
          if (FORCE && normType(q.type) === '多选') {
            const extra = q.opts.filter((o) => String(o.aria) === 'true' && pick.want.indexOf(o) < 0);
            for (const o of extra) {
              if (!o.c) continue;
              await clickAt(o.c.x, o.c.y);
              await sleep(260);
              log('  · 取消多选的「' + o.show + '」（答案里没有它）');
            }
          }
          /* 重新取一次现场：上面可能刚取消过，aria 变了 */
          const fresh = (FORCE && normType(q.type) === '多选') ? await ev(READ_Q) : q;
          const wantNow = pick.want.map((o) => {
            if (fresh && fresh.qid === q.qid && fresh.opts) {
              const hit = fresh.opts.find((x) => x.idx === o.idx);
              if (hit) return hit;
            }
            return o;
          });
          for (const o of wantNow) {
            if (!o.c) continue;
            /* 【已经选着的别再点】平台的多选是 toggle：再点一次就取消了。
               2026-10-27 实测：这一题只填了 1 个，正是"把一个已经选上的又点掉了"。 */
            if (String(o.aria) === 'true') { log('  · 显示「' + o.show + '」本来就已经选着，不重复点'); continue; }
            await clickAt(o.c.x, o.c.y);
            await sleep(260);
          }
          /* 多选：把"选着、但答案里没有"的选项报出来（不去动它，交给人判断） */
          if (pick.want.length > 1 && !FORCE) {
            const extra = q.opts.filter((o) => String(o.aria) === 'true' && pick.want.indexOf(o) < 0);
            if (extra.length) log('  · ⚠ 还选着答案里没有的：' + extra.map((o) => o.show).join('') + '（没替你取消）');
          }
          /* 回读校验：#answer<qid> 应该等于点中那几张盒子的 data。
             但**顺序不可靠** —— 平台多选有时排序、有时按点击顺序拼（2026-10-27 实测：
             同一份卷子里 #51 给 "ABD"（排过序）、#67 给 "CB"（点击顺序））。
             所以只比"字符集合"，不比顺序；漏选/多选照样能发现。 */
          const after = await ev(READ_Q);
          const got = after && after.qid === q.qid ? String(after.answer || '') : '';
          const expect = q.opts.filter((o) => pick.want.indexOf(o) >= 0).map((o) => o.data).join('');
          const bag = (s) => String(s || '').toUpperCase().split('').sort().join('');
          const okSet = !!got && bag(got) === bag(expect);
          if (okSet) { done++; log('#' + no + ' 答案 ' + answer + ' → 点中显示「' + pick.want.map((o) => o.show).join('') + '」（平台答案键 ' + got + '）✓'); }
          else { failed++; log('#' + no + ' 答案 ' + answer + ' → 回读是「' + (got || '空') + '」，期望「' + expect + '」 ⚠ 自己看一眼'); }
        }
      }
    }

    if (!q.next || !q.next.c) { log('· 没有「下一题」了 → 到最后一题，停。'); break; }
    const nb = await ev(NEXT_BTN);
    if (!nb) { log('· 找不到「下一题」按钮（可能到末尾），停。'); break; }
    await clickAt(nb.x, nb.y);
    await sleep(800);
    let nxt = await ev(READ_Q);
    /* 整页导航的页面有时要等一会儿才换题 —— 最多再等 4 秒 */
    for (let w = 0; w < 5 && (!nxt || nxt.qid === q.qid); w++) { await sleep(800); nxt = await ev(READ_Q); }
    if (!nxt || nxt.qid === q.qid) { log('· 点了「下一题」但题号没变（到了末尾，或被平台弹窗拦住），停。'); break; }
  }

  if (CHECK) log('──── 检查完：已选 ' + skipped + '，还没选 ' + emptyCount + '，多选只填一个 ' + oddMulti);
  else log('──── 本轮：填了 ' + done + '，跳过 ' + skipped + '，没填上 ' + failed);
  log('⚠ 交卷那一步留给你自己：先从头过一遍，再点平台的「提交」/「交卷」。本脚本不含任何提交动作。');
  c.close();
  process.exit(0);
})().catch((e) => { console.log('✗ ' + (e && e.stack ? e.stack : e)); process.exit(1); });
