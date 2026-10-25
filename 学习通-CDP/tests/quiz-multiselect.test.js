/* quiz-multiselect.test.js —— 多选题填不上的两条根因（离线，全假 DOM）
 *
 * 背景（2026-10-25 法师反馈「现在填不了多选」，真页面实测定位到两条）：
 *
 * ① 坐标塌成视口中心
 *    fillAct 里原来是"每个选项都 el.scrollIntoView({block:'center'}) 再取矩形中心"。
 *    每个选项都被轮流滚到视口正中，取到的坐标自然全是同一个点（真页面实测：4 个选项都是 519,480）。
 *    于是多选答案 ABCD 变成"同一个点 toggle 4 次"：偶数次等于一个都没点，奇数次只点上一个。
 *
 * ② isOn 串到兄弟选项
 *    isOn 原来往上找 4 层，而多选的结构是 LI > UL > DIV.clearfix > DIV.TiMu，
 *    第 4 层正好是 .TiMu —— 在它上面 querySelector('.check_answer_dx') 会捞到兄弟选项的标记。
 *    只要有一个选项选中，整题四个选项全判成"已选中"，账面写"已选中：ABC"其实只点上一个。
 *
 * 这个文件用一个带"假滚动"的最小 DOM 把 fillAct 真跑起来（vm 执行它生成的那段脚本），
 * 断言上面两条都不许回来。不连浏览器、不读任何用户文件。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const Q = require(path.join(__dirname, '..', '答题助手.js'));

/* ============================================================================
 * 一、最小假 DOM：只实现 fillAct 真用到的那几样
 *    tagName / className / getAttribute / querySelector(All) / parentElement /
 *    innerText / textContent / getBoundingClientRect / scrollIntoView
 * ==========================================================================*/

const VW = 1478;
const VH = 959;

/* 极简选择器：支持 `tag`、`.cls`、`tag.cls`、`[attr]`、`[attr*=v]`、`[attr=v]`、`a > b`。
   fillAct 的 OPT / NUM / SELS 全在这个范围内。 */
function matchOne(el, part) {
  const p = String(part).trim();
  if (!p) return false;
  const m = p.match(/^([a-zA-Z]*)((?:\[[^\]]+\]|\.[\w-]+)*)$/);
  if (!m) return false;
  const tag = m[1].toUpperCase();
  if (tag && el.tagName !== tag) return false;
  const tokens = (m[2] || '').match(/\[[^\]]+\]|\.[\w-]+/g) || [];
  for (const t of tokens) {
    if (t[0] === '.') {
      const cls = String(el.className || '').split(/\s+/);
      if (!cls.includes(t.slice(1))) return false;
      continue;
    }
    const inner = t.slice(1, -1);
    const mm = inner.match(/^([\w-]+)(?:([*^$]?=)([\s\S]*))?$/);
    if (!mm) return false;
    const got = el.getAttribute(mm[1]);
    if (got === null) return false;
    if (mm[2] === '*=') { if (String(got).indexOf(mm[3]) < 0) return false; }
    else if (mm[2] === '=') { if (String(got) !== mm[3]) return false; }
    else if (mm[2]) return false;
  }
  return true;
}

function matches(el, sel) {
  return String(sel).split(',').some((one) => {
    const chain = one.split('>').map((x) => x.trim()).filter(Boolean);
    if (!chain.length) return false;
    if (!matchOne(el, chain[chain.length - 1])) return false;
    let p = el.parentElement;
    for (let i = chain.length - 2; i >= 0; i--) {
      if (!p || !matchOne(p, chain[i])) return false;
      p = p.parentElement;
    }
    return true;
  });
}

function mkEl(tag, opt) {
  const o = opt || {};
  const el = {
    tagName: String(tag).toUpperCase(),
    className: o.cls || '',
    textContent: o.text || '',
    children: [],
    parentElement: null,
    ownerDocument: null,
    _attrs: Object.assign({}, o.attrs || {}),
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this._attrs, n) ? String(this._attrs[n]) : null;
    },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    get innerText() { return this.textContent; },
    appendChild(c) {
      c.parentElement = this;
      c.ownerDocument = this.ownerDocument;
      this.children.push(c);
      return c;
    },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) {
        for (const c of n.children) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      })(this);
      return out;
    },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    /* 假滚动：元素的"文档坐标"是 o.docTop，视口坐标 = docTop - scrollY */
    getBoundingClientRect() {
      const top = (o.docTop || 0) - (o.state ? o.state.y : 0);
      return { left: 41, top: top, width: 765, height: o.h || 51 };
    },
    /* 真 Chrome 的 scrollIntoView({block:'center'})：把这个元素滚到视口正中 */
    scrollIntoView() {
      if (!o.state || typeof o.docTop !== 'number') return;
      const h = o.h || 51;
      o.state.y = o.docTop + h / 2 - VH / 2;
    },
  };
  return el;
}

/* 造一页多选：TiMu > UL > 4×LI > span.num_option
   opt.emptyLetters = true → 选项字母读不出来（字体反爬的替身字），用来逼出"按位置兜底"
   opt.selected      = 已经选中的选项下标（模拟平台把标记打上） */
function buildPage(opt) {
  const o = opt || {};
  const state = { y: 0 };
  const doc = mkEl('html');
  doc.body = mkEl('body');
  doc.appendChild(doc.body);

  const tiMu = mkEl('div', { cls: 'TiMu newTiMu', state: state, docTop: 3000, h: 400, text: '【多选题】题干' });
  doc.body.appendChild(tiMu);
  const ul = mkEl('ul', { cls: 'Zy_ulTop w-top fl', state: state, docTop: 3040, h: 4 * 51 + 8 });
  tiMu.appendChild(ul);

  const LETTERS = ['A', 'B', 'C', 'D'];
  const lis = [], spans = [];
  for (let i = 0; i < 4; i++) {
    const li = mkEl('li', {
      cls: 'before-after-checkbox',
      state: state,
      docTop: 3040 + i * 51,
      h: 51,
      attrs: { qid: '215908088', role: 'checkbox', onclick: 'addMultipleChoice(this);' },
      text: LETTERS[i] + '. 选项正文',
    });
    ul.appendChild(li);
    const sp = mkEl('span', {
      cls: 'num_option_dx choice215908088',
      state: state,
      docTop: 3040 + i * 51,
      h: 51,
      attrs: { data: o.emptyLetters ? '' : LETTERS[i] },
      text: o.emptyLetters ? '\uE123' : LETTERS[i],
    });
    li.appendChild(sp);
    /* 作业页那种被包在内层的选项文本层：混进 cands 会把"第几个候选"算错 */
    if (o.withAnswerP) {
      const ap = mkEl('div', {
        cls: 'fl answer_p', state: state, docTop: 3040 + i * 51, h: 51,
        text: LETTERS[i] + '. 选项正文',
      });
      li.appendChild(ap);
    }
    if (o.selected === i) {
      li.setAttribute('aria-checked', 'true');
      sp.setAttribute('class', 'num_option_dx choice215908088 check_answer_dx');
      sp.className = 'num_option_dx choice215908088 check_answer_dx';
    }
    lis.push(li);
    spans.push(sp);
  }

  const win = {};
  win.window = win;
  win.innerWidth = VW;
  win.innerHeight = VH;
  win.document = doc;
  doc.defaultView = win;
  return { doc: doc, win: win, tiMu: tiMu, lis: lis, spans: spans, state: state };
}

/* 把 fillAct 生成的那段脚本真的跑一遍（题号 0 = 第一道题，避开题干匹配） */
function runFill(page, spec) {
  const sandbox = { document: page.doc, console: console };
  sandbox.window = sandbox;
  sandbox.innerWidth = VW;
  sandbox.innerHeight = VH;
  page.doc.defaultView = sandbox;
  vm.createContext(sandbox);
  const expr = Q.fillAct(0, spec || { by: 'letter', v: ['A', 'B', 'C', 'D'] });
  return vm.runInContext(expr, sandbox);
}

/* ============================================================================
 * 二、用例
 * ==========================================================================*/

test('多选：4 个选项的点击坐标必须各不相同（不许塌成视口中心）', () => {
  const page = buildPage();
  const r = runFill(page);
  assert.equal(r.ok, true);
  assert.equal(r.picks.length, 4, '四个字母都要命中选项');

  /* 跨 vm 上下文建出来的数组原型不同，deepStrictEqual 会因此判不等 —— 用宿主的 Array.from 转一下 */
  const ys = Array.from(r.picks, (p) => p.y);
  assert.equal(new Set(ys).size, 4,
    '四个选项必须给出四个不同的 y —— 全相同就是"每个选项都先滚到视口中心"那个 bug 回来了：' + JSON.stringify(ys));
  assert.deepEqual(ys, [ys[0], ys[0] + 51, ys[0] + 102, ys[0] + 153],
    '相邻选项的 y 差应当等于行高（51），这样点第一个才是第一个');
  for (const p of r.picks) assert.equal(p.inView, true, '选项都在视口里');
});

test('多选：只有一个选项选中时，别的选项不能被判成"已选中"（isOn 不许串兄弟）', () => {
  const page = buildPage({ selected: 2 });      /* 只有 C 是选中的 */
  const r = runFill(page);
  const sel = Array.from(r.picks, (p) => p.selected);
  assert.deepEqual(sel, [false, false, true, false],
    '只有 C 该是 true；A/B/D 变 true 说明 isOn 又往上查到 .TiMu 去了：' + JSON.stringify(sel));
});

test('多选：选项字母读不出来时，按位置兜底只能落在 <li> 上（不能落到内层 .answer_p）', () => {
  const page = buildPage({ emptyLetters: true, withAnswerP: true });
  const r = runFill(page);
  assert.equal(r.ok, true);
  assert.equal(r.picks.length, 4, '读不到字母时按位置兜底，4 个答案都要有落点');
  assert.equal(r.picks[1].cls, 'before-after-checkbox', 'B 必须落在第 2 个 li 上，不能落到第 1 个 li 里的 .answer_p');
  assert.equal(r.picks[3].cls, 'before-after-checkbox', 'D 必须落在第 4 个 li 上');
  assert.equal(r.picks[0].byPos, true, '这条兜底路径要标出 byPos，日志里能看出"是按位置点的"');
});

test('单选：只给一个字母时，坐标落在它自己身上（别把单选改坏）', () => {
  const page = buildPage();
  const r = runFill(page, { by: 'letter', v: ['C'] });
  assert.equal(r.picks.length, 1);
  const y = r.picks[0].y;
  /* 题目容器（docTop 3000）居中后，C 是第 3 个选项：容器顶部往下 2 行 + 半个行高 ≈ 167 */
  const boxTop = 3000 - page.state.y;
  const rel = y - boxTop;
  assert.equal(r.picks[0].inView, true);
  assert.ok(rel > 140 && rel < 200,
    'C 的 y 应该落在容器内第 3 行附近（实测相对容器顶部 ' + rel + 'px）');
});
