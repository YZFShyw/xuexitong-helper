/* 填作业.js —— 对着「作业作答」页跑一次答题助手：读题 → 问 AI → 勾选 → 点「暂时保存」。
 *
 * 只填草稿，**绝不提交**。提交那一步永远留给本人按。
 *
 * 【为什么不塞进 driver.js】
 * driver.js 的世界只有 studentstudy（课程学习页）：主循环在翻章 / 找视频 / 切测验栏，
 * 而且它挑标签页时只认 studentstudy，没有就报"没找到学习通课程页标签"直接退出。
 * 作业页是另一种页面，硬塞进去得动那条 3000 行的主流程。
 * 而答题助手本身**不挑页面** —— probe / handle 只认页面里的题目 DOM
 * （作业页实测：.questionLi 25 个、.answer_p 100 个，正好对得上它的选择器），
 * 所以这里把它的两个接口直接接上就行，driver.js 一行都不用改。
 *
 * 【提交闸不会因为这里放松】
 * 答题助手里那道硬闸门照旧：按钮文字沾「提交 / 交卷」、class 沾 btnSubmit、
 * 或者 onclick 去掉 noSubmit 之后还剩 submit 的，一律拒绝并如实报告。
 * 作业页的提交按钮是 onclick="submitValidate()" —— 含 submit，照样被挡。
 * 这脚本只是把「暂时保存」（作业页叫 saveWork()）这条路认了出来。
 *
 * 用法：
 *   node 填作业.js           真填（勾选 + 暂时保存）
 *   node 填作业.js --dry     只探测能认出几道题，不填、不存
 *   node 填作业.js --port=9222
 */
'use strict';
const quizMod = require('./答题助手.js');

const CDP_PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 9222;
const DRY = process.argv.includes('--dry');

function ts() { return new Date().toLocaleTimeString('zh-CN'); }
const log = (...a) => console.log('[' + ts() + '] ' + a.join(' '));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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

(async () => {
  console.log('=== 学习通 · 填作业（只填草稿，绝不提交）===');
  if (DRY) console.log('（--dry：只探测，不填不存）');
  console.log('');

  let list;
  try {
    list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
  } catch (e) {
    console.log('连不上调试端口 ' + CDP_PORT + '。先确认浏览器是用「开浏览器并开始」起的（端口 9222）。');
    process.exit(1);
  }
  const pages = (list || []).filter((t) => t && t.type === 'page');
  const hw = pages.find((p) => /work\/dowork/i.test(String(p.url)));
  if (!hw) {
    console.log('没找到「作业作答」页（地址里带 work/dowork）。当前开着的是：');
    pages.forEach((p) => console.log('   ' + String(p.title).slice(0, 30) + '   ' + String(p.url).slice(0, 88)));
    console.log('');
    console.log('先在浏览器里把那份作业打开，再跑一次。');
    process.exit(1);
  }
  console.log('作业页: ' + hw.title);
  console.log('        ' + String(hw.url).slice(0, 110));
  console.log('');

  const c = await connect(hw.webSocketDebuggerUrl);

  /* 【这两步不做，点击会被页面直接丢掉】
     实测（2026-10-10）：光发 Input.dispatchMouseEvent，DOM 一个变化都没有，
     连鼠标移动的 hover 效果都不出现 —— 因为那个浏览器窗口不在前台，
     页面不认为自己"聚焦"，输入事件到达之前就被扔了。
     driver.js 里正是这么处理的（它 2045 行那一带）：
         await c.send('Page.enable');
         await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
     加上之后，窗口被压在其他窗口后面也照样点得动。 */
  await c.send('Page.enable').catch(() => {});
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  /* 还要把它切成当前标签：后台标签收不到输入事件（实测：DOM 一个变化都没有，
     连 hover 都不出现）。这一步会把那个标签拿到最前面 —— 只是切换标签，
     不会动窗口大小、不会关任何东西。 */
  try { await c.send('Page.bringToFront'); } catch (e) {}
  await new Promise((r) => setTimeout(r, 400));

  /* 在页面里求值，直接拿回值 */
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, timeout: 30000,
    });
    if (r && r.result && r.result.exceptionDetails) {
      throw new Error('页面里执行出错: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 180));
    }
    return r && r.result ? r.result.result.value : undefined;
  };

  /* CDP 发真鼠标事件 —— 完全照抄 driver.js 的 clickTop，三下的字段和间隔都不能省。
     【别被误报骗了】2026-10-10 我一度以为这条路不通：每道题都报「点了但没选中」，
     DOM 也"没变化"。其实是答题助手的复查查错了层级 —— 选中的标记打在**父元素**
     .answerBg 上，它只查了子元素 .answer_p。截图看得清清楚楚：选项蓝圈早就亮了。
     （那次已经把 isOn() 改成连着往上找 4 层。）
     所以这里老老实实用 CDP 真鼠标，和章节测验走同一条路。 */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let _clickN = 0;
  const clickAt = async (x, y) => {
    _clickN++;
    const px = Math.round(x), py = Math.round(y);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0, clickCount: 0 });
    await sleep(180);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(90);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
    console.log('     [点击 ' + _clickN + '] (' + px + ',' + py + ')');
    return true;
  };

  /* 截图：返回 base64（JPEG）—— 和 driver.js 里的 shot 同一个契约。
     【不只是"能调用"】driver.js 给的那个 shot 上还挂着两个方法，
     答题助手在截图期间靠它们把被压小的视口临时撑回 1280x900：
         shot.setViewport(w, h)   撑大
         shot.clearViewport()     还原（**必须还原**，否则后面驱动的点击坐标全会偏）
     原来这里只定义了一个函数，两个方法都没挂 —— 于是答题助手里那句
     `await shot.setViewport && ...` 恒为假（属性不存在），视口撑不起来、
     拍出来是空白条，而日志一个字都不说。现在补齐，并且把失败如实返回，
     让答题助手能把"这次截图不可信"写进日志。 */
  /* 截图相关的小状态。声明放最前面 —— 后面几个函数都会写到它们，
     放在后面虽然运行时不会踩到暂时性死区，但读起来容易看漏。 */
  let lastShotError = '';
  let lastViewportError = '';
  let viewportOverridden = false;

  const shot = async (opts) => {
    try {
      const r = await c.send('Page.captureScreenshot',
        Object.assign({ format: 'jpeg', quality: 82 }, opts || {}));
      const b64 = (r && r.result && r.result.data) || '';
      if (!b64) lastShotError = 'CDP 返回了空图';
      return b64;
    } catch (e) {
      lastShotError = (e && e.message) ? e.message : String(e);
      return '';
    }
  };
  shot.setViewport = async (w, h) => {
    try {
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: w || 1280, height: h || 900, deviceScaleFactor: 1, mobile: false,
      });
      viewportOverridden = true;
      return true;
    } catch (e) {
      lastViewportError = (e && e.message) ? e.message : String(e);
      return false;
    }
  };
  shot.clearViewport = async () => {
    try {
      await c.send('Emulation.clearDeviceMetricsOverride', {});
      viewportOverridden = false;
      return true;
    } catch (e) {
      lastViewportError = (e && e.message) ? e.message : String(e);
      return false;
    }
  };

  /* 【重新打开作业卡 —— 只做"能证实"的那两种，绝不做未验证的跳转】
     为什么需要它：答题助手在"题目在 DOM 里但没显示出来"或者"抄录里一道题都没有"时，
     需要把装着题目的作业卡叫回来再拍一次。这一步不做的话，它只能报"结果不可信"，
     然后按设计**不自动填、不自动保存**。
     这里的做法刻意保守（审查要求：不可用未验证的跳转重开真实作业）：
       ① 页面上如果有明确指出"这个是作业/答题"的可点标签或链接，用真鼠标点一下，
          然后**回读页面上有几道题**来证实真的回来了；
       ② 页面没有这种入口，就重新加载作业卡的 iframe（同源、地址不变，等于刷新一次），
          同样回读证实；
       ③ 两条都不行就说"没法重开"，让上层走"不可信 → 不填不保存"那条路。
     注意这里**不碰任何按钮**（尤其不碰提交），只点被明确识别为"作业/答题"的标签。 */
  const reopenQuiz = async () => {
    let keep = null;
    try {
      keep = await ev(`(function () {
        function vis(el) {
          try { var r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; } catch (e) { return false; }
          try { var st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false; } catch (e) {}
          return true;
        }
        var sels = ["a", "li", "div[class*=tab]", "span[class*=tab]", "[role=tab]", "[class*=card]"];
        var cands = [], seen = [];
        for (var s = 0; s < sels.length; s++) {
          var list = null;
          try { list = document.querySelectorAll(sels[s]); } catch (e) { continue; }
          for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (seen.indexOf(el) >= 0) continue;
            seen.push(el);
            var t = ""; try { t = String(el.innerText || el.textContent || "").replace(/\\s+/g, ""); } catch (e) {}
            if (!t || t.length > 12) continue;
            if (!/作业|答题|作答/.test(t)) continue;
            var oc = String(el.getAttribute("onclick") || "");
            var cl = String(el.className || "");
            if (/提交|交卷|btnSubmit|submitValidate|btnBlueSubmit/i.test(t + " " + oc + " " + cl)) continue;
            if (!vis(el)) continue;
            var r2 = null; try { r2 = el.getBoundingClientRect(); } catch (e) { r2 = null; }
            if (!r2) continue;
            var frame = 0; try {
              var w = el.ownerDocument.defaultView;
              while (w && w !== window) { frame++; w = w.parent; }
            } catch (e) { frame = -1; }
            cands.push({ el: el, text: t, html: String(el.outerHTML || "").slice(0, 220), frame: frame, x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) });
          }
        }
        return { ok: true, n: cands.length, cands: cands.slice(0, 4) };
      })()`);
    } catch (e) {
      return '没法重开作业卡：找入口时页面报错（' + (e && e.message ? e.message : e) + '）';
    }
    const cands = (keep && keep.cands) || [];
    const hit = cands.find((x) => Number(x.frame) === 0) || cands[0];

    /* ① 有明确入口：真鼠标点一下，然后回读题数证实 */
    if (hit && typeof hit.x === 'number') {
      const beforeProbe = await countQuestionsSafe();
      log('     重开作业卡：点「' + hit.text + '」(' + hit.x + ',' + hit.y + '，框架' + hit.frame + ')');
      await clickAt(hit.x, hit.y);
      await sleep(2500);
      const after = await countQuestionsSafe();
      if (after > 0) return '点了「' + hit.text + '」后页面上有 ' + after + ' 道题（重开成功）';
      /* 【点完没回来就不再动手】没有第二次尝试、更不做任何跳转。
         宁可报"不行"，也不能靠猜去做会改页面的动作。 */
      return '点了「' + hit.text + '」但页面上还是 ' + after + ' 道题（重开没能证实，' +
        (beforeProbe > 0 ? '题目在 DOM 里但没显示' : '题目还是没渲染') + '）';
    }

    /* ② 没有入口：重新加载作业卡的 iframe（同源、地址不变） */
    let reloaded = null;
    try {
      reloaded = await ev(`(function () {
        function allDocs() {
          var out = [document], seen = [document];
          function walk(d, depth) {
            if (depth > 4) return;
            var fs = d.querySelectorAll("iframe");
            for (var i = 0; i < fs.length; i++) {
              var cd = null; try { cd = fs[i].contentDocument; } catch (e) {}
              if (cd && cd.body && seen.indexOf(cd) < 0) { seen.push(cd); out.push(cd); walk(cd, depth + 1); }
            }
          }
          walk(document, 0);
          return out;
        }
        var docs = allDocs();
        for (var d = 0; d < docs.length; d++) {
          var u = "";
          try { u = String(docs[d].location && docs[d].location.href || ""); } catch (e) { u = ""; }
          if (!/dowork|work|quiz|exam/i.test(u)) continue;
          /* 只重载地址里明确带作业/测验字样的那一层，别的层不碰 */
          try { docs[d].defaultView.location.reload(); return { ok: true, url: u.slice(0, 80) }; } catch (e) {}
        }
        return { ok: false, n: docs.length };
      })()`);
    } catch (e) {
      reloaded = { ok: false, err: (e && e.message) ? e.message : String(e) };
    }
    if (reloaded && reloaded.ok) {
      await sleep(3000);
      const after = await countQuestionsSafe();
      if (after > 0) return '重新加载作业卡后页面上有 ' + after + ' 道题（重开成功）';
      return '重新加载了作业卡（' + reloaded.url + '）但还是 0 道题（重开没能证实）';
    }
    return '没法重开作业卡：页面上找不到明确标着「作业/答题」的入口，' +
      '也不敢用未验证的跳转去重开真实作业（按"不可信"处理：不自动填、不自动保存）';
  };
  /* 只读地数一下页面上现在有几道题（不点任何东西） */
  const countQuestionsSafe = async () => {
    try {
      const p = await ev(quizMod.fillAct(0, { by: 'probe', v: [] }));
      return (p && typeof p.n === 'number') ? p.n : 0;
    } catch (e) { return 0; }
  };

  const cfg = quizMod.loadConfig();
  const MODE = ['不做题', '记下题·不问AI', '记下题·问AI'];
  console.log('答题助手: ' + (MODE[cfg.mode] || '不做题') + (cfg.mode >= 2 ? ('   模型 ' + cfg.model) : ''));
  if (cfg.mode <= 0) {
    console.log('现在是「不做题」模式 —— 双击 控制台.cmd → 4 改完再来。');
    c.close();
    process.exit(0);
  }
  console.log('');

  /* 【填和存要分开记账】
     原来小结里那句"填上了 N 道"是 `found - missed` 反推出来的 ——
     把"填了但没保存"也算成了填上。用户照着这句话离开页面，
     草稿其实是空的（慢网络下按钮停在"保存中…"就是这个现场）。
     现在各数字各管一件事：
       found   —— 探针认出几道题
       filled  —— 真的把答案勾进页面几道（由 fillFromText 直接报数字，不反推）
       saveConfirmed —— 保存被**平台的提示**证实了几**次**（不是题数）
       saveUnconfirmed —— 点过保存但没拿到成功证据的次数（**绝不能算成已保存**）
       saveFailed —— 保存这一步明确失败的次数
       missed  —— 明确没做成的（超上限、模型答不出、填不进页面…）

     【名字必须跟答题助手里写的完全一样 —— 这里踩过坑】
     答题助手的 noteSave 记的是 saveConfirmed / saveUnconfirmed / saveFailed，
     而这里原来建的是 saved / savedUnconfirmed：两边对不上，
     于是"保存被平台证实了"也可能在小结里显示 0 次。
     现在统一用助手那套名字，并留一个显式映射（见下面的 saveTally）
     兜住老写法，谁写哪一套都不会读成 0。
     再一次：这三个是**次数**，不是题数 —— 跟这一章有几道题无关。 */
  const stats = {
    chapters: 0, found: 0, filled: 0, missed: 0,
    saveConfirmed: 0, saveUnconfirmed: 0, saveFailed: 0,
    saveMsg: '', saveStatus: '', needConfirmSave: false,
  };
  /* 显式映射：先读统一名字，读不到再退回老名字（saved / savedUnconfirmed）。
     这样不管写的是哪一套名字，显示的都不会永远是 0。 */
  const saveTally = (canon, legacy) => {
    const n = Number(stats[canon]);
    if (Number.isFinite(n)) return n;
    const old = Number(stats[legacy]);
    return Number.isFinite(old) ? old : 0;
  };
  cfg.stats = stats;
  cfg.onUnanswered = (rec) => {
    log('  没做成：' + (rec.type || '?') + '  ' + String(rec.stem || '').slice(0, 46) + '   原因：' + (rec.why || ''));
  };

  /* 【reopenQuiz 拿真实实现填上】
     原来这里写的是 `reopenQuiz: null` —— 答题助手里那些自救路径
     （"题目在 DOM 里但没显示"和"抄录里一道题都没有"）全靠它，
     传 null 等于全部关掉：拍歪了也没人重拍，模型拿错图，
     答案就按题号顺序填到错位的题上（这是最难查的一类失败）。
     现在的实现只做能证实的动作：点明确标着"作业/答题"的标签，
     或者重载作业卡 iframe，然后回读题数确认；证实不了就如实说不行。 */
  const helper = quizMod.makeHelper(cfg, { ev, shot, clickAt, reopenQuiz });

  log('探测页面上的题目 …');
  let probe = null;
  try { probe = await helper.probe(ev); } catch (e) { log('探测出错: ' + e.message); }
  if (!probe) { log('探测拿不到结果，停。'); c.close(); process.exit(1); }

  log('认出 ' + (probe.found || 0) + ' 道题' +
      (probe.scanned !== undefined ? ('（扫了 ' + probe.scanned + ' 个文档层）') : '') +
      (probe.obfCount ? ('，其中 ' + probe.obfCount + ' 道用了反爬字体') : ''));
  if (!probe.found) { log('这一页没有题目，不用填。'); c.close(); process.exit(0); }

  if (DRY) {
    log('（--dry：到此为止，一个像素都没动）');
    c.close();
    process.exit(0);
  }

  log('开始处理：读题 → 问 AI → 勾选 → 暂时保存');
  console.log('');
  const chapter = '作业 · ' + String(hw.title || '').slice(0, 30);
  let lines = [];
  try { lines = await helper.handle(chapter, probe, (l) => log(l)); } catch (e) { log('处理出错: ' + e.message); }
  (lines || []).forEach((l) => console.log(l));

  /* 结构化落账：优先问 helper 要（它知道保存的真实状态），拿不到再回看小结文字 */
  let pending = { needConfirm: false, blocksContinue: false, status: '', message: '' };
  let saveRes = null;
  try { pending = helper.pendingSave() || pending; } catch (e) {
    log('  ⚠ 读 pendingSave() 出错：' + ((e && e.message) || e) + '（这次的保存状态看不到，按"没确认"处理）');
  }
  try {
    saveRes = (typeof helper.lastSaveResult === 'function') ? helper.lastSaveResult() : null;
  } catch (e) {
    /* 【别再默默吞掉】原来这个 catch 把 lastSaveResult() 里的 ReferenceError
       吃得干干净净 —— "接口坏了"和"这一趟没走到保存"在小结里长得一模一样。
       现在至少把死因打出来（接线错了就要看得见）。 */
    log('  ⚠ 读 lastSaveResult() 出错：' + ((e && e.message) || e) + '（这次拿不到结构化保存结果）');
  }
  if (saveRes) {
    stats.saveStatus = saveRes.status || '';
    stats.saveMsg = saveRes.msg || '';
    stats.needConfirmSave = !!saveRes.needConfirm;
  }
  const lastSaveLine = (lines || []).map(String).filter((l) => /已点|没能确认|已确认保存|没保存|保存出错/.test(l)).pop() || '';

  console.log('');
  console.log('=== 小结 ===');
  const nFound = Number(stats.found) || 0;
  const nFilled = Number(stats.filled) || 0;
  const nConfirmed = saveTally('saveConfirmed', 'saved');            /* 次数，不是题数 */
  const nUnconfirmed = saveTally('saveUnconfirmed', 'savedUnconfirmed');
  const nSaveFailed = saveTally('saveFailed', 'saveFailed');
  console.log('  遇到题目 : ' + nFound + ' 道');
  console.log('  填进页面 : ' + nFilled + ' 道  ← 只统计真的勾上去的，不按"题目数减没做成"反推');
  if (nConfirmed) {
    console.log('  已保存   : ' + nConfirmed + ' 次收到平台的「保存成功」提示（都是草稿，从未提交）');
  } else if (pending.needConfirm || nUnconfirmed) {
    console.log('  已保存   : 0 次 —— **没看到任何保存成功的证据**');
  } else if (nSaveFailed) {
    console.log('  已保存   : 0 次（保存这一步没做成，见下面）');
  } else {
    console.log('  已保存   : （这一趟没有走到保存那一步）');
  }
  if (nUnconfirmed) {
    console.log('  待确认   : ' + nUnconfirmed + ' 次「点了保存但没拿到成功提示」');
  }
  if (nSaveFailed) {
    console.log('  保存失败 : ' + nSaveFailed + ' 次（没按钮 / 被安全闸门拒绝 / 页面抛错）');
  }
  console.log('  没做成   : ' + (Number(stats.missed) || 0) + ' 道');
  if (pending.needConfirm) {
    console.log('');
    console.log('  ⚠ 有保存没被确认过（' + (pending.status === 'saving' ? '还在保存中' : '没看到成功提示') + '）。');
    console.log('    没能确认的草稿**可能没存上** —— 请先回页面看一眼答案还在不在，');
    console.log('    确认之后再做别的（别直接关页面或换节）。');
    if (lastSaveLine) console.log('    最后一次保存的结果：' + lastSaveLine.trim());
  } else if (nConfirmed) {
    console.log('');
    console.log('  （保存都有平台的提示作证；日志里不会出现"没证据却说已保存"这种话）');
  }
  console.log('');
  console.log('  → 回浏览器核对一遍，确认没问题再自己按「提交」。');
  c.close();
})().catch((e) => {
  console.error('失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
