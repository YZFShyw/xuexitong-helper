/* driver-save-gate.test.js —— 离线验证「保存没被确认时不许翻页/切栏/自动重拉」
 *
 * 全部是假的：不连浏览器、不发请求、不读任何真实配置/题库/记录/密钥。
 * 需要写文件的地方一律写在系统临时目录，并在退出时删掉自己建的那一个。
 *
 * 覆盖四件事：
 *   A. 纯判定函数 decideAfterSave：已确认/未确认/保存中/拒绝/失败/未知 各是什么结论；
 *   B. 三条真实入口路径（driver.js 里那三段源码）在**未确认**时的实际动作：
 *      不许点「下一节」、不许切栏、不许BACK_CHAPTER，并写停止标记阻止外套 15 秒重拉；
 *   C. 已确认保存时，这三条路径照旧往下走（不能因为加了闸门就把正常流程卡死）；
 *   D. driver.js 的接线检查：三个 quizHelper.handle 入口 + 主循环开始前都真的过闸门。
 *
 * 跑法：
 *   node --test tests\driver-save-gate.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const gate = require(path.join(__dirname, '..', 'driver-save-gate.js'));

const ROOT = path.join(__dirname, '..');
const DRIVER_SRC = fs.readFileSync(path.join(ROOT, 'driver.js'), 'utf8');
/* 真实工作区里的那个停止标记：本文件**任何情况下**都不许碰它。 */
const REAL_STOP_FLAG = path.join(ROOT, '_内部', gate.STOP_FLAG_FILE);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-save-gate-test-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

let seq = 0;
function mkSandbox() {
  const dir = path.join(TMP, 'sb' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  const stopFlag = path.join(dir, '_内部', gate.STOP_FLAG_FILE);
  assert.ok(path.resolve(stopFlag).startsWith(path.resolve(os.tmpdir()) + path.sep),
    '测试只能写临时目录');
  assert.notEqual(path.resolve(stopFlag), path.resolve(REAL_STOP_FLAG));
  return { dir, stopFlag };
}

/* 假操作记录器：每调用一次 ev(...) 就记下"做了什么"。
   真实 driver.js 里翻页/切栏/关弹窗都要经过 ev，所以只要 ev 没被调用，
   就等于"页面上一个字都没动"。 */
function mkOps() {
  const ops = [];
  const ev = async (expr) => {
    const s = String(expr);
    ops.push(s.length > 60 ? (s.slice(0, 57) + '...') : s);
    return null;
  };
  return { ops, ev };
}

/* 把真车源码里的一段抠出来，放在一个"假世界"里跑。
 *
 * 【为什么参数用解构、而不是一个个具名参数】
 * 抠出来的是 driver.js 的原文，里面本来就有 `let didFill = false` 这类声明。
 * 如果按名字展开成 `function(didFill, lines, ...)`，参数和源码里的 let 就重名 ——
 * 直接 SyntaxError（"Identifier 'x' has already been declared"），
 * 看起来像"被测代码坏了"，其实只是测试的搭台方式撞了名字。
 * 用 `function({didFill, lines})` 之后，源码那段就能原样跑。
 */
function runSnippet(src, world) {
  const names = Object.keys(world);
  assert.ok(names.length > 0, '假世界不能是空的');
  for (const n of names) {
    assert.match(n, /^[A-Za-z_$][A-Za-z0-9_$]*$/, '假世界的键必须是合法标识符：' + n);
  }
  const fn = new vm.Script('(function({' + names.join(',') + '}){\n' + src + '\n})');
  return fn.runInThisContext()({ ...world });
}

const evOf = (o, key) => {
  const i = o.indexOf(key);
  if (i < 0) return -1;
  return o.slice(0, i).split('\n').length;   /* 1 起算的行号 */
};

/* driver.js 里闸门的真实动作（跟生产代码同构，只是把停止标记写进临时目录）：
   过闸门 → 未确认就写标记 + 返回 'stop-manual'。 */
function mkRealGate(stopFlag, chapter, helper) {
  return (where, saveAttempted) => {
    const d = gate.decideAfterSave({
      save: helper.pendingSave(),
      chapter: chapter,
      stopAtQuiz: false,
      saveAttempted: saveAttempted !== false,
    });
    if (d.action !== 'stop-manual') return 'continue';
    fs.mkdirSync(path.dirname(stopFlag), { recursive: true });
    fs.writeFileSync(stopFlag, gate.formatStopFlag(d.stop), 'utf8');
    return 'stop-manual';
  };
}

/* ---------------- 共用：假 helper ----------------
   pendingSave() 的形状跟 答题助手.js 里那个一模一样：
   {needConfirm, blocksContinue, status, origin, message}。 */
function fakeHelper(pending) {
  const handleCalls = [];
  return {
    mode: 2,
    handleCalls,
    pendingSave() { return pending; },
    async handle(chapter) {
      handleCalls.push(chapter);
      return ['  已按顺序填进页面：3 道', '  ── 本章账目：填进页面 3 道；保存：' + (pending && pending.status)];
    },
  };
}

const SAVE = {
  confirmed: { needConfirm: false, blocksContinue: false, status: 'saved', origin: 'toast', message: '已点「暂时保存」，页面出现「保存成功」。' },
  unconfirmed: { needConfirm: true, blocksContinue: true, status: 'unconfirmed', origin: 'no_proof', message: '已点「暂时保存」，但没看到平台的保存成功提示。' },
  saving: { needConfirm: true, blocksContinue: true, status: 'saving', origin: 'saving_text', message: '按钮变成「保存中」，还没看到成功提示。' },
  rejected: { needConfirm: true, blocksContinue: true, status: 'rejected', origin: 'submit_only', message: '只找到提交类按钮，已拒绝。' },
  failed: { needConfirm: true, blocksContinue: true, status: 'failed', origin: 'exception', message: '保存请求失败。' },
  unknown: { needConfirm: true, blocksContinue: true, status: '', origin: '', message: '' },
};

/* ============================================================================
 * A. 纯判定
 * ==========================================================================*/

test('纯判定：只有"已确认保存"才允许继续自动往下走', () => {
  for (const k of ['unconfirmed', 'saving', 'rejected', 'failed', 'unknown']) {
    const d = gate.decideAfterSave({ save: SAVE[k], chapter: '第一章', saveAttempted: true });
    assert.equal(d.action, 'stop-manual', k + ' 必须停下来等人确认，不能自动翻页');
    assert.ok(d.stop, k + ' 必须带上要写进停止标记的内容');
    assert.equal(d.stop.reason, '待人工确认保存');
    assert.match(d.reason, /没有证实|没有确认|保存/);
  }
  const ok = gate.decideAfterSave({ save: SAVE.confirmed, chapter: '第一章', saveAttempted: true });
  assert.equal(ok.action, 'continue');
  assert.equal(ok.stop, null, '已确认保存时不许写停止标记');
});

test('纯判定：从没走到保存那一步时，不许因为一个空状态把章节卡死', () => {
  const d = gate.decideAfterSave({ save: null, chapter: '第一章', saveAttempted: false });
  assert.equal(d.action, 'continue');
  const d2 = gate.decideAfterSave({ save: { status: '', needConfirm: false, blocksContinue: false }, chapter: '第一章', saveAttempted: false });
  assert.equal(d2.action, 'continue');
});

test('纯判定：老 helper 缺 blocksContinue 字段时按"没确认"保守推断，绝不自动放行', () => {
  const old = gate.normalizeSaveState({ status: 'unconfirmed', needConfirm: true });
  assert.equal(old.blocksContinue, true, '字段没了就得自己保守推断');
  assert.equal(gate.decideAfterSave({ save: { status: 'unconfirmed', needConfirm: true }, chapter: 'x' }).action, 'stop-manual');
  /* 真·没有保存这回事（status 空、也没有任何标志）→ 不拦 */
  assert.equal(gate.normalizeSaveState({}).blocksContinue, false);
  assert.equal(gate.normalizeSaveState(null).blocksContinue, false);
});

test('纯判定：「测验停」的原有语义不变：没有可疑保存时照样停', () => {
  const d = gate.decideAfterSave({ save: SAVE.confirmed, chapter: '第一章', stopAtQuiz: true });
  assert.equal(d.action, 'stop-quiz');
  assert.equal(d.stop, null);
  /* 两个都成立时，以"待人工确认"为先 —— 它更急，而且必须写停止标记 */
  const both = gate.decideAfterSave({ save: SAVE.unconfirmed, chapter: '第一章', stopAtQuiz: true });
  assert.equal(both.action, 'stop-manual');
});

test('停止标记：内容说清"停在当前题页/没翻页"，并给出人话指引', () => {
  const d = gate.decideAfterSave({ save: SAVE.unconfirmed, chapter: '函数的求导法则', saveAttempted: true });
  const text = gate.formatStopFlag(d.stop);
  assert.match(text, /人工确认/);
  assert.match(text, /函数的求导法则/);
  assert.match(text, /没有证实/);
  assert.match(text, /不要点提交/);
  assert.doesNotMatch(text, /平台已完成|任务完成/);
  assert.equal(gate.STOP_FLAG_FILE, '停止标记.txt', '外套认的就是这个名字，不许改');
});

/* ============================================================================
 * B/C. 三条真实入口路径
 * ==========================================================================*/

/* 把 driver.js 里某一段源码整段抠出来（从 startMarker 到 endMarker）。
   这样测的是**真源码那几行的顺序**（闸门到底在 BACK_CHAPTER 之前还是之后），
   而不是另写一遍"我以为的逻辑"。

   marker 传字符串时按原样找（起点取最后一次出现：带中文的标签在整份文件里
   只在该段出现，取最后一次即该段）；起点可以传正则，表示"容许缩进变化"。

   【主循环那段为什么必须用正则】
   实测（2026/10/11）：主循环那一整块被降了一级缩进（10 格 → 8 格），
   写死的 'const missBefore = quizStats.missed;\n          let lines = null;'
   整个对不上，sliceBetween 直接抛"找不到起点"，**整个文件一个用例都没跑**——
   失败长得像"闸门坏了"，其实只是锚点被排版变化晃掉了。
   被测对象是"这几行谁先谁后"，不是缩进，所以起点锚点写成 (\s*) 更贴合意图。 */
function sliceBetween(src, startMarker, endMarker) {
  const findStart = () => {
    if (!(startMarker instanceof RegExp)) {
      const i = src.lastIndexOf(startMarker);
      return i < 0 ? null : { i, text: startMarker };
    }
    const re = new RegExp(startMarker.source, startMarker.flags.replace('g', '') + 'g');
    let m, last = null;
    while ((m = re.exec(src)) !== null) {
      last = { i: m.index, text: m[0] };
      if (m.index === re.lastIndex) re.lastIndex++;   /* 空匹配防护 */
    }
    return last;
  };
  const s = findStart();
  assert.ok(s && s.i > 0, '找不到要测的那段源码起点：' + startMarker);
  /* 终点可以传正则：端点也常连带缩进，"闭合括号三连"这类标记用 \s* 才不会被排版晃掉 */
  let j, endLen;
  if (endMarker instanceof RegExp) {
    const re = new RegExp(endMarker.source, endMarker.flags.replace('g', '') + 'g');
    re.lastIndex = s.i;
    const m = re.exec(src);
    assert.ok(m, '找不到要测的那段源码终点：' + endMarker);
    j = m.index; endLen = m[0].length;
  } else {
    j = src.indexOf(endMarker, s.i);
    endLen = endMarker.length;
  }
  assert.ok(j > s.i, '找不到要测的那段源码终点：' + endMarker);
  return src.slice(s.i, j + endLen);
}

/* --- B1：没有测验标签那条路 ------------------------------------------------ */

/* 入口一：这一整段（含它自己的 let 声明）—— 闸门、记账、quizFilledKeys 都在里面 */
const SRC_NO_TAB = sliceBetween(DRIVER_SRC, /let lines0 = null;/, 'return res0;');

test('入口一（页面里直接就有题 work 卡）：未确认保存 → 不翻页、不切栏、写停止标记', async () => {
  const sb = mkSandbox();
  const o = mkOps();
  const helper = fakeHelper(SAVE.unconfirmed);
  const world = {
    ev: o.ev,
    sleep: async () => {},
    log: () => {},
    console: { log: () => {} },
    ts: () => '00:00:00',
    quizHelper: helper,
    chapter: '函数的求导法则',
    lastChapter: '函数的求导法则',
    quizCfg: { stopAtQuiz: false },
    quizSeen: '',
    quizStats: { chapters: 0, found: 0, filled: 0, missed: 0 },
    quizFilledKeys: new Set(),
    tallyChapter: () => { throw new Error('保存没确认时不该记账成"这一章填过了"'); },
    chkSave: () => { throw new Error('保存没确认时不该写检查点"这一章填过了"'); },
    gateCheck: mkRealGate(sb.stopFlag, '函数的求导法则', helper),
    qrNoTab: { found: 3 },
  };
  const ret = await runSnippet('return (async function(){\n' + SRC_NO_TAB + '\n})();', world);
  assert.equal(ret, 'stop');
  assert.equal(fs.existsSync(sb.stopFlag), true, '必须写停止标记，否则外套 15 秒后会自动重拉（页面被重新加载，草稿没了）');
  assert.equal(o.ops.length, 0, '未确认保存时**一个页面动作都不许有**，实际：' + o.ops.join(' | '));
});

test('入口一：已确认保存 → 照旧继续（不写停止标记、不改返回值）', async () => {
  const sb = mkSandbox();
  const o = mkOps();
  const helper = fakeHelper(SAVE.confirmed);
  let tallied = 0;
  const world = {
    ev: o.ev,
    sleep: async () => {},
    log: () => {},
    console: { log: () => {} },
    ts: () => '00:00:00',
    quizHelper: helper,
    chapter: '函数极限',
    lastChapter: '函数极限',
    quizCfg: { stopAtQuiz: false },
    quizSeen: '',
    quizStats: { chapters: 0, found: 0, filled: 0, missed: 0 },
    quizFilledKeys: new Set(),
    tallyChapter: () => { tallied++; },
    chkSave: () => {},
    gateCheck: () => 'continue',
    res0: 'handled',
    lines0: ['已按顺序填进页面：3 道'],
    qrNoTab: { found: 3 },
    missBefore0: 0,
  };
  const ret = await runSnippet('return (async function(){\n' + SRC_NO_TAB + '\n})();', world);
  assert.equal(ret, 'handled');
  assert.equal(fs.existsSync(sb.stopFlag), false);
  assert.equal(tallied, 1, '已确认保存时该记的账照记');
});

/* --- B2：有测验标签那条路（含 BACK_CHAPTER） ------------------------------- */

/* 入口二：从"拿到题了"一路到 BACK_CHAPTER + return result。
   抠的是一整段自洽的代码（if → for → else → 切栏），所以能直接 eval。
   【起点定在 let result 这行，不往前吃探针循环】
   探针循环只负责"把 qr 问出来"，跟保存闸门无关；把它切进来还会连带
   要 sleep/probe 这些域外依赖，片段越来越难自洽。qr 由调用方作为参数注入。 */
const SRC_TAB = sliceBetween(DRIVER_SRC, "let result = 'none';", '\n    return result;');

test('入口二（章节测验标签）：未确认保存 → 不切栏(BACK_CHAPTER)、不写检查点', async () => {
  const sb = mkSandbox();
  const o = mkOps();
  let chkSaved = 0, tallied = 0;
  const world = {
    ev: o.ev,
    sleep: async () => {},
    log: () => {},
    console: { log: () => {} },
    ts: () => '00:00:00',
    chapter: '军事理论',
    lastChapter: '军事理论',
    quizCfg: { stopAtQuiz: false },
    quizStats: { chapters: 1, found: 5, filled: 5, missed: 0 },
    quizFilledKeys: new Set(),
    qr: { found: 5 },
    tallyChapter: () => { tallied++; },
    chkSave: () => { chkSaved++; },
    gateCheck: mkRealGate(sb.stopFlag, '军事理论', fakeHelper(SAVE.unconfirmed)),
    /* 走不到那条 else 分支（qr 有 5 道题），但片段里有引用就得给个值 */
    tail: '',
    missBefore: 0,
    BACK_CHAPTER: 'BACK_CHAPTER_EXPR',
  };
  const ret = await runSnippet('return (async function(){\n' + SRC_TAB + '\n})();', world);
  assert.equal(ret, 'stop', '闸门拦下时必须返回 stop（调用方据此退出主驱动）');
  assert.equal(o.ops.filter((x) => x.indexOf('BACK_CHAPTER') >= 0).length, 0,
    '未确认保存时不许切栏目：' + o.ops.join(' | '));
  assert.equal(chkSaved, 0, '不许把"没确认的草稿"写进检查点当已完成');
  assert.equal(tallied, 0, '不许把没确认的草稿记成"这一章本轮做完了"');
  assert.equal(o.ops.length, 0);
});

test('入口二：闸门先于 BACK_CHAPTER —— 源码里顺序不许被改回去', () => {
  /* 只按**可执行代码**比先后：
       · 注释里也写着 BACK_CHAPTER 这几个字（解释为什么要放在它前面）；
       · 变量名 BACK_CHAPTER 本身会出现在别的地方，所以只认"真的拿它去求值"那一处 ev(BACK_CHAPTER)。
     两样都会把顺序比歪（实测踩过）。 */
  const code = SRC_TAB.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  const gateLine = evOf(code, 'gateCheck(');
  const backLine = evOf(code, 'ev(BACK_CHAPTER)');
  assert.ok(gateLine > 0, '这一段里必须有闸门');
  assert.ok(backLine > 0, '这一段里必须有"切回章节栏"那一步');
  assert.ok(gateLine < backLine,
    'gateCheck 必须在切回章节栏之前（第 ' + gateLine + ' 行 vs 第 ' + backLine + ' 行）');
});

test('入口二：已确认保存时照旧切回「章节」栏并返回原结果', async () => {
  const o = mkOps();
  const world = {
    ev: o.ev,
    sleep: async () => {},
    log: () => {},
    console: { log: () => {} },
    ts: () => '00:00:00',
    chapter: '军事理论',
    lastChapter: '军事理论',
    quizCfg: { stopAtQuiz: false },
    quizStats: { chapters: 1, found: 5, filled: 5, missed: 0 },
    quizHelper: fakeHelper(SAVE.confirmed),
    tallyChapter: () => {},
    chkSave: () => {},
    gateCheck: () => 'continue',
    qr: { found: 5 },
    quizFilledKeys: new Set(),
    tail: '',
    missBefore: 0,
    BACK_CHAPTER: 'BACK_CHAPTER_EXPR',
  };
  const ret = await runSnippet('return (async function(){\n' + SRC_TAB + '\n})();', world);
  assert.equal(ret, 'handled');
  assert.equal(o.ops.filter((x) => x.indexOf('BACK_CHAPTER') >= 0).length, 1,
    '正常情况下仍要切回章节栏（否则下一轮会原地打转）');
});

/* --- B3：主循环里认出题那条路 --------------------------------------------- */

/* 【为什么这一段不做"抠源码再 eval"】
   前两段（没有测验标签 / 有测验标签）抠的是一整块自洽的代码，直接 eval 没问题。
   主循环里这一段不行：它嵌在 `while (true) { … if (q) { … } … }` 里，
   抠出来要么少一层括号（Unexpected token return）、要么多一层（Unexpected token }），
   而 driver.js 这段时间一直在被人改（这一块挪过好几次缩进和括号），
   写死行数 / 数括号 / 数缩进三种办法都试过，全都会因为字符串和注释里的括号而摆。
   硬凑行数等于把测试绑在排版上 —— 那种测试改一次代码就红一次，最后一定会被人删掉。
   所以这一段改成**按源码顺序断言**：闸门必须排在"会动页面/会记账"的动作之前。
   判据只有行号先后，与缩进、括号、字符串无关。 */

/* 只看可执行行：注释里也写着 quizFilledKeys.add / BACK_CHAPTER 这些字（解释为什么要放前面），
   按纯文本找会把注释当成代码（前面就这么误报过）。 */
function codeLines(src) {
  return src.split(String.fromCharCode(10))
    .map((l, i) => ({ l, no: i + 1 }))
    .filter((x) => !/^\s*(\*|\/\/|\/\*)/.test(x.l));
}

test("driver.js：主循环那一段，闸门必须排在记账之前（顺序断言）", () => {
  const lines = codeLines(DRIVER_SRC);
  const probeAt = lines.findIndex((x) => /const q = await quizHelper\.probe\(ev\);/.test(x.l));
  assert.ok(probeAt >= 0, "主循环里那个探题调用必须还在");
  const after = lines.slice(probeAt);
  const gateAt = after.findIndex((x) => /gateCheck\(/.test(x.l));
  assert.ok(gateAt >= 0, "主循环里探到题之后必须过闸门");
  const addAt = after.findIndex((x) => /quizFilledKeys\.add\(/.test(x.l));
  assert.ok(addAt > gateAt,
    "quizFilledKeys.add 必须排在闸门之后（闸门在第 " + after[gateAt].no + " 行，add 在第 " +
    (addAt >= 0 ? after[addAt].no : "?") + " 行）—— 放在前面就等于：没确认保存也先把这一章记成\"本轮填过了\"");
  /* 闸门拦下时必须从主循环退出去（break），不能只是不记账还接着往下跑 */
  const stopAt = after.findIndex((x) => /gate === .stop-manual./.test(x.l));
  assert.ok(stopAt > gateAt, "闸门结论（gate）必须被真正用上：`if (gate === 'stop-manual') break;`");
});

test("driver.js：每个 handle 入口附近都有一道闸门", () => {
  const lines = codeLines(DRIVER_SRC);
  const handles = [];
  lines.forEach((x, i) => { if (/await quizHelper\.handle\(/.test(x.l)) handles.push(i); });
  assert.equal(handles.length, 3, "应当正好有三个 handle 入口，实际 " + handles.length);
  /* 闸门可以在这个入口之前（主循环那处就是先断结论、再 handle、再按结论记账 —— 更严），
     也可以在之后。这里只要求"前后 30 行内确实有一道闸门"，顺序由下一条用例盯着。 */
  const problems = [];
  for (const h of handles) {
    const from = Math.max(0, h - 30);
    const win = lines.slice(from, h + 30);
    if (!win.some((x) => /gateCheck\(/.test(x.l))) {
      problems.push("第 " + lines[h].no + " 行的 handle 前后 30 行内都没有闸门");
    }
  }
  assert.deepEqual(problems, [], problems.join(String.fromCharCode(10)));
  const probeAt = lines.findIndex((x) => /const q = await quizHelper\.probe\(ev\);/.test(x.l));
  assert.ok(probeAt >= 0, "主循环里那个探题调用必须还在");
  assert.ok(lines.slice(probeAt, probeAt + 30).some((x) => /gateCheck\(/.test(x.l)),
    "主循环里探到题之后 30 行内也必须有闸门");
});

/* ============================================================================
 * D. driver.js 接线（静态检查）
 * ==========================================================================*/

test("driver.js：主循环开始前也过闸门（兜底，防止上一章的可疑保存被带进来）", () => {
  const i = DRIVER_SRC.indexOf("async function runQuiz(");
  assert.ok(i > 0, "runQuiz 必须还在");
  const body = DRIVER_SRC.slice(i, i + 4000);   /* runQuiz 的函数体：探题那句在下面一点 */
  const gateAt = body.indexOf("gateCheck(");
  const probeAt = body.indexOf("quizHelper.probe(");
  assert.match(body, /gateCheck\(.重开测验之前./, "runQuiz 开头必须有兜底闸门");
  assert.ok(probeAt > 0, "没找到探题调用，判据失效了");
  assert.ok(gateAt < probeAt,
    "兜底闸门必须在先探一遍题之前（闸门 @" + gateAt + "，探题 @" + probeAt + "）—— 否则页面已经被读了才想起来要停");
});

test("driver.js：闸门停下时必须写停止标记（外套只认这个文件才不会 15 秒重拉）", () => {
  const i = DRIVER_SRC.indexOf("function writeSaveGateFlag(");
  assert.ok(i > 0, "writer 必须还在");
  const body = DRIVER_SRC.slice(i, i + 900);
  assert.match(body, /STOP_FLAG_FILE/);
  assert.match(body, /fs\.writeFileSync\(STOP_FLAG_FILE/);
  assert.match(DRIVER_SRC, /const STOP_FLAG_FILE = path\.join\(__dirname, ._内部./,
    "停止标记必须落在 _内部\\停止标记.txt —— 外套看的是那个路径");
});
