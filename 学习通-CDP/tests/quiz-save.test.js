/* quiz-save.test.js —— 离线验证"点暂时保存"这条路
 *
 * 全部是假的：假页面状态、假 CDP 求值、假配置。**不连浏览器、不发请求、不读真文件。**
 *
 * 覆盖审查里点的三个坑：
 *   1. 只有平台的"保存成功"提示才算成功；按钮文字变了**绝不能**判成功；
 *      点保存之前页面上遗留的那句提示不算证据。
 *   2. 兜底直调（找不到按钮时调页面函数）必须过只读复核；
 *      但已知的 noSubmit / saveWork 兼容能力不能被误删。
 *   3. 只找到提交按钮 → 明确"已拒绝"，并且日志里要能跟"根本没有保存按钮"分开。
 *
 * 跑法：
 *   C:\Users\TestUser\DeepSeekHarness\node\node.exe --test --test-isolation=none tests\quiz-save.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const quiz = require(path.join(__dirname, '..', '答题助手.js'));
const QS = require(path.join(__dirname, '..', 'quiz-state.js'));

/* ---------- 假的页面环境 ---------- */

/* 离线测试用的轮询节奏：把等待压到几毫秒。
   生产路径**不传**这个参数，真实等待时间（约 10 秒）不受影响。 */
const WAIT = { fastRounds: 3, fastMs: 1, slowRounds: 2, slowMs: 1 };

/* probe：saveProbe() 的返回（第一次 ev 调用） */
/* states：SAVE_STATE 的返回序列（后续每次 ev 调用） */
function makeEnv({ probe, states }) {
  const calls = [];
  let i = 0;
  const seq = Array.isArray(states) ? states.slice() : [];
  const last = seq.length ? seq[seq.length - 1] : { toasts: [], btns: [], busy: 0 };
  const ev = async (expr) => {
    const src = String(expr);
    if (src.indexOf('saveProbe') >= 0 || /isSubmit|baseToasts/.test(src)) {
      calls.push('probe');
      return probe;
    }
    calls.push('state');
    if (i < seq.length) return seq[i++];
    return last;
  };
  return { ev, calls };
}

const IDLE_BTN = [{ text: '暂时保存', state: 'null|btnSave workBtnIndex' }];
const SAVING_BTN = [{ text: '保存中…', state: 'null|btnSave workBtnIndex' }];

const PROBE_OK = {
  ok: true, text: '暂时保存', cls: 'btnSave workBtnIndex', onclick: 'noSubmit();',
  clickError: '', cands: 1, rejected: [], notes: [],
  baseToasts: [], btnBefore: IDLE_BTN
};

test('只找到提交按钮时：明确"已拒绝"，理由里带上被拒的按钮', async () => {
  const { ev } = makeEnv({
    probe: { ok: false, kind: 'none', why: '只找到提交类按钮，已拒绝：提交', rejected: ['提交'], notes: [], baseToasts: [], btnBefore: [] },
    states: []
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  /* 【这里原来是 `assert.equal(r.status, 'saved' === r.status ? 'saved' : 'rejected')`】
     那种写法等于"不管返回什么都能过"，是空断言。现在写死：只找到提交按钮，
     结论只能是"已拒绝"这一个，别的都算错。 */
  assert.equal(r.status, QS.SAVE.REJECTED, '只找到提交按钮 → 必须是"已拒绝"这一个确定结论');
  assert.equal(r.confirmed, false, '被拒绝绝不能算"已确认保存"');
  assert.equal(r.ok, false);
  assert.equal(r.needConfirm, false, '闸门挡住了、什么都没点下去，不算"待确认保存"');
  assert.equal(r.blocksContinue, true, '【口径】被拒绝≠页面没填过：答案可能已经在页面上，不许自动翻页/离开');
  assert.equal(r.reason, 'submit_button_only');
  assert.match(r.msg, /已拒绝/);
  assert.match(r.msg, /提交/);
  assert.doesNotMatch(r.msg, /保存成功/);
});

test('"根本没有保存按钮"和"只找到提交按钮"必须是两种不同的结论', async () => {
  const a = await quiz.saveDraftResult(makeEnv({
    probe: { ok: false, kind: 'none', why: '页面上既没有「暂时保存」按钮，也没有可复核的保存函数（待人工保存）', rejected: [], notes: [], baseToasts: [], btnBefore: [] },
    states: []
  }).ev, WAIT);
  const b = await quiz.saveDraftResult(makeEnv({
    probe: { ok: false, kind: 'none', why: '只找到提交类按钮，已拒绝：提交', rejected: ['提交'], notes: [], baseToasts: [], btnBefore: [] },
    states: []
  }).ev, WAIT);
  assert.equal(a.reason, 'no_save_button');
  assert.equal(b.reason, 'submit_button_only');
  assert.notEqual(a.msg, b.msg);
  assert.match(a.msg, /待人工保存|没保存/);
  assert.match(b.msg, /已拒绝/);
});

test('兜底直调被复核挡下（源码里有提交行为）→ 报"已拒绝"，不假装保存', async () => {
  const { ev } = makeEnv({
    probe: {
      ok: false, kind: 'direct_refused',
      direct: { name: 'noSubmit', source: 'function noSubmit(){ submitValidate(); }', sourceHasSubmit: true },
      why: 'noSubmit() 的源码里出现提交行为，已拒绝直调（待人工保存）',
      rejected: [], notes: [], baseToasts: [], btnBefore: []
    },
    states: []
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.REJECTED);
  assert.equal(r.reason, 'direct_call_refused');
  assert.equal(r.confirmed, false);
  assert.match(r.msg, /提交行为|待人工保存/);
});

test('兜底直调抛错：是"失败"而不是"未确认"，而且要说清死因（空 catch 已改成可追踪）', async () => {
  const { ev } = makeEnv({
    probe: {
      ok: true, direct: true,
      how: { name: 'noSubmit', source: 'function noSubmit(){ $.post("/save", {}); }' },
      callOk: false, callError: '页面里 saveData is not defined',
      baseToasts: [], btnBefore: []
    },
    states: []
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.FAILED);
  assert.equal(r.reason, 'direct_call_threw');
  assert.match(r.msg, /saveData is not defined/, '抛错原因必须出现在结论里');
  assert.doesNotMatch(r.msg, /已保存/);
});

test('按钮文字只变成「保存中…」→ 未确认保存，绝不判成功', async () => {
  const { ev, calls } = makeEnv({
    probe: PROBE_OK,
    /* 从头到尾都只有"保存中"，没有出现任何成功提示 */
    states: [
      { toasts: [], btns: SAVING_BTN, busy: 0 },
      { toasts: [], btns: SAVING_BTN, busy: 0 },
      { toasts: [], btns: SAVING_BTN, busy: 0 },
      { toasts: [], btns: SAVING_BTN, busy: 0 },
      { toasts: [], btns: SAVING_BTN, busy: 0 },
      { toasts: [], btns: SAVING_BTN, busy: 0 }
    ]
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.UNCONFIRMED, '光有"保存中"不能算成功');
  assert.equal(r.confirmed, false);
  assert.equal(r.ok, false);
  assert.equal(r.needConfirm, true, '必须给调用方一个明确的待确认标记');
  assert.equal(r.blocksContinue, true, '未确认时不许自动接着做会丢草稿的事');
  assert.match(r.msg, /没能确认已保存|没看到平台的保存成功提示/);
  /* 关键：句子里不能出现"保存成功"这种肯定说法 ——
     "没能确认已保存"是允许的，那是如实报告，不是假装成功。 */
  assert.doesNotMatch(r.msg, /保存成功(?![提示])/);
  assert.doesNotMatch(r.msg, /已保存[。，]/);
  assert.ok(calls.filter((c) => c === 'state').length >= 5, '应该真的轮询了多次');
});

test('页面上一次遗留的"保存成功"不算证据 → 仍是未确认', async () => {
  /* 关键：基线里就有"保存成功"（点之前页面上已经有这句话） */
  const probe = Object.assign({}, PROBE_OK, { baseToasts: ['保存成功'] });
  const { ev } = makeEnv({
    probe,
    states: [
      { toasts: ['保存成功'], btns: IDLE_BTN, busy: 0 },
      { toasts: ['保存成功'], btns: IDLE_BTN, busy: 0 },
      { toasts: ['保存成功'], btns: IDLE_BTN, busy: 0 },
      { toasts: ['保存成功'], btns: IDLE_BTN, busy: 0 },
      { toasts: ['保存成功'], btns: IDLE_BTN, busy: 0 }
    ]
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.UNCONFIRMED, '遗留的那句提示不能当成本次保存的证据');
  assert.equal(r.confirmed, false);
});

test('判定走的是带测试的 classifyToastNow：整页文字里"老提示还在"仍不算新证据', async () => {
  /* 这条专门盯"整页文字"这条路：SAVE_STATE 现在会把页面正文一起带回来，
     判定用的就是 quiz-state 里那份有测试覆盖的实现。 */
  const probe = Object.assign({}, PROBE_OK, { baseToasts: ['保存成功'] });
  const { ev } = makeEnv({
    probe,
    states: [
      { toasts: ['保存成功'], text: '作答区…… 保存成功', btns: IDLE_BTN, busy: 0 },
      { toasts: ['保存成功'], text: '作答区…… 保存成功', btns: IDLE_BTN, busy: 0 },
      { toasts: ['保存成功'], text: '作答区…… 保存成功', btns: IDLE_BTN, busy: 0 }
    ]
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.UNCONFIRMED);

  /* 同一份基线，但整页文字里多出来一句新的 → 这次才算 */
  const env2 = makeEnv({
    probe: Object.assign({}, PROBE_OK, { baseToasts: ['保存成功'] }),
    states: [
      { toasts: ['保存成功', '暂存成功'], text: '作答区…… 保存成功 …… 暂存成功', btns: IDLE_BTN, busy: 0 }
    ]
  });
  const r2 = await quiz.saveDraftResult(env2.ev, WAIT);
  assert.equal(r2.status, QS.SAVE.SAVED, '新冒出来的一句才算证据');
});

test('直调成功但页面没有任何提示 → 只是"保存中/未确认"，不能凭"函数调过了"就报成功', async () => {
  const { ev } = makeEnv({
    probe: {
      ok: true, direct: true,
      how: { name: 'saveWork', source: 'function saveWork(){ doSave(); }' },
      callOk: true, result: 'undefined',
      baseToasts: [], btnBefore: []
    },
    states: [
      { toasts: [], btns: [], busy: 0 },
      { toasts: [], btns: [], busy: 0 },
      { toasts: [], btns: [], busy: 0 }
    ]
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.UNCONFIRMED, '直调返回没报错 ≠ 保存成功');
  assert.equal(r.confirmed, false);
  assert.equal(r.origin, 'direct_fn');
  assert.match(r.msg, /saveWork\(\)/);
});

test('点完之后页面**新出现**「保存成功」→ 才算已确认保存', async () => {
  const { ev } = makeEnv({
    probe: PROBE_OK,
    states: [
      { toasts: [], btns: SAVING_BTN, busy: 1 },
      { toasts: ['保存成功'], btns: IDLE_BTN, busy: 0 }
    ]
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.SAVED);
  assert.equal(r.confirmed, true);
  assert.equal(r.ok, true);
  assert.equal(r.needConfirm, false);
  assert.equal(r.blocksContinue, false);
  assert.equal(r.reason, 'toast_saved');
  assert.match(r.msg, /保存成功/);
  assert.match(r.msg, /不是提交/);
});

test('点完之后页面出现保存失败提示 → 未确认 + 明确说草稿很可能没存上', async () => {
  const { ev } = makeEnv({
    probe: PROBE_OK,
    states: [{ toasts: ['保存失败'], btns: IDLE_BTN, busy: 0 }]
  });
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.UNCONFIRMED);
  assert.equal(r.reason, 'toast_failed');
  assert.equal(r.needConfirm, true);
  assert.match(r.msg, /保存失败/);
  assert.match(r.msg, /很可能没存上|没存上/);
});

test('探测那一步页面直接抛错 → 失败，而且带上原因', async () => {
  const ev = async () => { throw new Error('页面里执行出错: 连接断了'); };
  const r = await quiz.saveDraftResult(ev, WAIT);
  assert.equal(r.status, QS.SAVE.FAILED);
  assert.equal(r.reason, 'probe_error');
  assert.match(r.msg, /连接断了/);
});

test('老接口 saveDraft 仍然返回字符串（driver.js / 控制台 按字符串用）', async () => {
  const { ev } = makeEnv({
    probe: PROBE_OK,
    states: [{ toasts: ['保存成功'], btns: IDLE_BTN, busy: 0 }]
  });
  const s = await quiz.saveDraft(ev, WAIT);
  assert.equal(typeof s, 'string');
  assert.match(s, /暂时保存|保存成功/);
  assert.doesNotMatch(s, /\[object Object\]/);
});

test('SAVE_STATE 那段页面脚本是纯只读的：不许出现任何点击/提交动作', () => {
  const src = String(quiz.SAVE_STATE);
  assert.doesNotMatch(src, /\.click\s*\(/, '轮询脚本绝不能点任何东西');
  assert.doesNotMatch(src, /dispatchEvent/, '轮询脚本不能派发事件');
  assert.doesNotMatch(src, /submit\s*\(/i, '轮询脚本不能碰提交');
  assert.match(src, /toasts/, '它应该只是把页面上的事实读回来');
});

test('saveProbe 里直调兜底必须过复核，而且不再有那个吞掉错误的空 catch', () => {
  const src = String(quiz.saveProbe());
  /* 复核用的三个事实必须在 */
  assert.match(src, /sourceHasSubmit/, '要读函数源码看有没有提交行为');
  assert.match(src, /sourceLooksLikeSave/, '要看它像不像保存函数');
  assert.match(src, /direct_refused/, '复核不过要给出专门的结论');
  /* 【直调那一步的 catch 不能再是空的】
     原来写的是 `} catch (e) {}` —— "页面抛错"和"调用成功"在返回里长得一模一样。
     现在要求：调用的两边都能看出成败，而且抛错原因带得出去。 */
  const iCall = src.indexOf('target[direct.name]()');
  assert.ok(iCall > 0, '应该能找到直调那一步');
  const callBlock = src.slice(iCall, iCall + 260);
  assert.match(callBlock, /dcall = true/, '成功要留痕');
  assert.match(callBlock, /catch \(e\) \{[\s\S]*derr/, '失败也要留痕（不能是空 catch）');
  assert.ok(callBlock.indexOf('derr') < callBlock.indexOf('b4'), '抛错原因必须在返回之前就记下来');
  assert.match(src, /callError/, '抛错原因要带出去');
  assert.match(src, /callOk: dcall/, '"跑没跑成"必须是显式字段');
  /* 那道以 .click() 收尾的退路必须没了 */
  assert.doesNotMatch(src, /\.click\(\)/, '不能再有绕过闸门的 .click() 退路');
});

/* ============================================================================
 * 五、真跑一遍 saveProbe()：vm + 假 DOM
 *
 * 【为什么要真跑，而不是继续喂造好的 probe 返回】
 *   前面那些用例喂的是"已经拒绝好了"的结果 —— 它们只能证明
 *   saveDraftResult 会把 rejected 翻译成"已拒绝"，
 *   证明不了**探针自己**没去点提交。这里把 saveProbe() 那段页面脚本
 *   丢进 vm、配一个最小假 DOM 和会记调用次数的假页面函数，直接看它动了什么。
 *
 * 假 DOM 只实现 saveProbe 真用到的那几样：
 *   document.querySelectorAll / querySelector；元素上的 innerText / className /
 *   getAttribute / getBoundingClientRect / scrollIntoView / dispatchEvent /
 *   ownerDocument.defaultView.getComputedStyle。
 * **不连浏览器、不加载任何真实页面。**
 * ==========================================================================*/

function mkFakeElement(o, ctx) {
  const el = {
    innerText: o.text || '',
    textContent: o.text || '',
    className: o.cls || '',
    _attrs: { onclick: o.onclick || '', id: o.id || '', disabled: null },
    getAttribute(n) { return this._attrs[n] === undefined ? null : this._attrs[n]; },
    getBoundingClientRect() {
      return o.hidden
        ? { left: 0, top: 0, width: 0, height: 0 }
        : { left: 10, top: 20, width: 120, height: 36 };
    },
    scrollIntoView() {},
    /* 真页面上这就是"点下去了" —— 它被调用几次，用例就照实断言几次 */
    dispatchEvent() { ctx.dispatched++; return true; },
    ownerDocument: null
  };
  return el;
}

function fakeSelectorMatches(el, sel) {
  const s = String(sel).trim();
  if (s === 'iframe') return false;
  if (s === 'a.btnSave' || s === '.btnSave') return /(^|\s)btnSave(\s|$)/.test(el.className);
  const m = s.match(/^\[(\w+)\*=([^\]]+)\]$/);
  if (m) return String(el.getAttribute(m[1]) || '').indexOf(m[2]) >= 0;
  return false;
}

/* 把 saveProbe() 那段页面脚本在 vm 里跑一遍。
   opts.elements  —— 假页面上的元素
   opts.pageFns   —— 假页面上的全局函数（noSubmit / submitValidate…），
                     每个都是 (ctx, win) => function(){}，用来数调用次数 */
function runSaveProbe(opts) {
  const o = opts || {};
  const ctx = { dispatched: 0, noSubmit: 0, submitValidate: 0, mouseEvents: 0 };
  const els = (o.elements || []).map((e) => mkFakeElement(e, ctx));
  const pick = (sel) => els.filter((el) => String(sel).split(',').some((p) => fakeSelectorMatches(el, p)));
  const win = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MouseEvent: function MouseEvent() { ctx.mouseEvents++; }
  };
  const doc = {
    body: { innerText: o.pageText || '' },
    defaultView: win,
    querySelectorAll: (sel) => pick(sel),
    querySelector: (sel) => pick(sel)[0] || null
  };
  els.forEach((el) => { el.ownerDocument = doc; });
  const fns = o.pageFns || {};
  for (const k of Object.keys(fns)) win[k] = fns[k](ctx, win);
  const sandbox = { document: doc, window: win, console: console };
  const r = vm.runInNewContext(String(quiz.saveProbe()), sandbox, { timeout: 3000 });
  return { r: r, ctx: ctx, win: win, doc: doc };
}

/* 把真跑出来的 probe 结果喂给 saveDraftResult，并数一数它有没有去轮询 */
function evOfProbe(probe, seen) {
  return async (expr) => {
    const s = String(expr);
    if (/isSubmit|baseToasts/.test(s)) { seen.probe++; return probe; }
    seen.state++;
    return { toasts: [], btns: [], busy: 0 };
  };
}

test('真跑 saveProbe：页面上只有提交按钮 → 判定"已拒绝"，submit/noSubmit/dispatch 一次都没发生', async () => {
  /* 【页面上那两个元素为什么长这样】
     saveProbe 的候选选择器是 `a.btnSave, .btnSave, [onclick*=noSubmit], [onclick*=saveWork]`。
     真正危险、也是这道闸门存在的理由，是"**看着像保存按钮、其实是提交**"那种：
     类名带 btnSave、onclick 还是 noSubmit()，可文字写着「提交」/「交卷」。
     所以这里就照这个样子造假元素 —— 它们能进候选，必须被闸门挡下。 */
  const dom = runSaveProbe({
    pageText: '作答区 剩余 15 分钟 提交 交卷',
    elements: [
      { text: '提交', cls: 'btnSave workBtnIndex', onclick: 'noSubmit();' },
      { text: '交卷', cls: 'btnSave btnSubmit workBtnIndex', onclick: 'saveWork();' }
    ],
    pageFns: {
      submitValidate: (ctx) => function submitValidate() { ctx.submitValidate++; return 'submitted'; }
    }
  });
  assert.equal(dom.r.ok, false);
  assert.equal(dom.r.kind, 'none');
  /* vm 里造出来的数组跟这边的 Array 不是同一个 realm，deepEqual 会因原型不同失败 —— 转一下再比 */
  assert.deepEqual(Array.from(dom.r.rejected), ['提交', '交卷'], '提交类元素要被明确拒绝，而且名字要留下');
  assert.match(dom.r.why, /已拒绝/);
  assert.equal(dom.ctx.submitValidate, 0, '提交函数绝不能被调用');
  assert.equal(dom.ctx.noSubmit, 0);
  assert.equal(dom.ctx.dispatched, 0, '连一个合成点击事件都不许派发');

  /* 再喂给 saveDraftResult：真探针 + 翻译这一步一起验 */
  const seen = { probe: 0, state: 0 };
  const res = await quiz.saveDraftResult(evOfProbe(dom.r, seen), WAIT);
  assert.equal(res.status, QS.SAVE.REJECTED);
  assert.equal(res.confirmed, false);
  assert.equal(res.needConfirm, false, 'needConfirm 只表示"saving/unconfirmed"这一档；拒绝不算保存成功');
  assert.equal(res.blocksContinue, true, '答案可能已经填在页面上 —— 不许自动离开');
  assert.equal(res.reason, 'submit_button_only');
  assert.match(res.msg, /已拒绝/);
  assert.match(res.msg, /提交/);
  assert.equal(seen.probe, 1, '只探测一次');
  assert.equal(seen.state, 0, '被拒绝时不该进入轮询');
});

test('真跑 saveProbe：找不到按钮、页面里却有个会提交的 noSubmit → 复核挡下直调，函数一次没被调用', async () => {
  const dom = runSaveProbe({
    pageText: '作答区',
    elements: [],
    pageFns: {
      submitValidate: (ctx) => function submitValidate() { ctx.submitValidate++; return 'submitted'; },
      noSubmit: (ctx, win) => function noSubmit() { ctx.noSubmit++; return win.submitValidate(); }
    }
  });
  assert.equal(dom.r.ok, false);
  assert.equal(dom.r.kind, 'direct_refused', '复核不过要给专门的结论，不能混进"根本没有按钮"');
  assert.equal(dom.r.direct.name, 'noSubmit');
  assert.equal(dom.r.direct.sourceHasSubmit, true, '要从源码里认出提交行为');
  assert.match(dom.r.why, /提交行为/);
  assert.equal(dom.ctx.noSubmit, 0, '复核不过 → 绝不调用那个函数');
  assert.equal(dom.ctx.submitValidate, 0);
  assert.equal(dom.ctx.dispatched, 0);

  const seen = { probe: 0, state: 0 };
  const res = await quiz.saveDraftResult(evOfProbe(dom.r, seen), WAIT);
  assert.equal(res.status, QS.SAVE.REJECTED);
  assert.equal(res.confirmed, false);
  assert.equal(res.reason, 'direct_call_refused');
  assert.match(res.msg, /提交行为|待人工保存/);
  assert.equal(seen.state, 0, '被拒绝时不该进入轮询');
});

test('真跑 saveProbe（对照）：正常的「暂时保存」认得出来、提交按钮照旧被挡，而且只点保存那一个', () => {
  /* 这条是"对照组"：证明上面两条的 0 次不是因为这个假 DOM 根本动不了，
     而是闸门真的把它们挡下来了 —— 同一个假 DOM 里，保存按钮是会走到"点下去"的。 */
  const dom = runSaveProbe({
    pageText: '作答区 暂时保存 提交',
    elements: [
      { text: '暂时保存', cls: 'btnSave workBtnIndex', onclick: 'noSubmit();' },
      { text: '提交', cls: 'btnSave btnSubmit workBtnIndex', onclick: 'noSubmit();' }
    ],
    pageFns: { noSubmit: (ctx) => function noSubmit() { ctx.noSubmit++; return 'ok'; } }
  });
  assert.equal(dom.r.ok, true);
  assert.equal(dom.r.text, '暂时保存');
  assert.equal(dom.r.onclick, 'noSubmit();');
  assert.deepEqual(Array.from(dom.r.rejected), ['提交'], '同一个页面里的提交按钮照样要被拒');
  assert.equal(dom.r.cands, 1, '候选里只剩真正那个保存按钮');
  assert.equal(dom.ctx.dispatched, 4, '走到"点保存"这条路时确实会派发 mouseover/mousedown/mouseup/click 四下');
  assert.equal(dom.ctx.noSubmit, 0, '按钮那条路不该去直调页面函数');
  assert.equal(dom.r.btnBefore.length, 1, '要把点之前的按钮状态作为基线带回去');
});
