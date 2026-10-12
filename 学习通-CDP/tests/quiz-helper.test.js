/* quiz-helper.test.js —— 把 makeHelper 当**接口**用一遍（集成级，不是单元级）
 *
 * 【为什么非要有这个文件】
 *   quiz-save.test.js 只测了 saveDraftResult 这一个函数，验证不到
 *   "makeHelper 交出去的公开方法到底能不能用"。真实踩到的坑正是这种：
 *       lastSaveResult() { return saveResult; }
 *   而 saveResult 只声明在 handle() 内部 —— 方法一调用就 ReferenceError，
 *   调用方（填作业.js）的 try/catch 把它吞掉，看起来只是"没有结果"。
 *   所以这里**不许** try/catch 包着公开方法：调不通就是要红。
 *
 * 【铁规矩：只碰临时目录、只发假请求】
 *   · ANSWER_CACHE_FILE / OUT_FILE / CFG_FILE 三个路径全部指到 os.tmpdir()；
 *   · globalThis.fetch 换成假的（只数调用、只回假 JSON），一个真实请求都不发；
 *   · 不连浏览器、不连学习通、不读真配置/真题库/真凭据。
 *   每个用例都走 withRun()：它在 finally 里把三个路径和 fetch 全还回去。
 *
 * 【绝不读用户的 章节测验记录.txt，也绝不要求 答题答案缓存.json 不存在】
 *   （2026-10-11 改）原来的收尾用例会去 stat/读**真**记录文件的尾部找 MARK，
 *   还断言"工作区里没有 答题答案缓存.json"。两条都是错的：
 *     · 用户正常跑过助手之后，答题答案缓存.json 本来就该存在 —— 拿它的存在当失败，
 *       等于让测试替用户规定"你没跑过"，用户一跑测试就红；
 *     · 真记录文件是用户自己的数据，测试没有理由去读它（哪怕只读一小段）。
 *   现在改成：写入目标必须是**本次的临时文件**，并在那个假文件里检查 MARK 真写进去了；
 *   再用"把真路径临时替换成假路径"的方式验"谁写了哪个文件"，而不是去看真文件。
 *
 * 【跑法】
 *   C:\Users\TestUser\DeepSeekHarness\node\node.exe --test --test-isolation=none tests\quiz-helper.test.js
 *   （dsh 沙箱里必须带 --test-isolation=none：默认的子进程 spawn 会 EPERM）
 *
 * 【注意：这个文件里的 handle() 走的是生产轮询节奏】
 *   handle 调 saveDraftResult(evFn) 时**不传** waitOpt（生产路径就是这么调的），
 *   所以"只看到保存中"那条用例会真的等满 4×700ms + 6×1200ms ≈ 10 秒。
 *   这是故意的：那个约 10 秒的等待正是"慢网络下别急着下结论"的修复本身。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const quiz = require(path.join(__dirname, '..', '答题助手.js'));
const QS = require(path.join(__dirname, '..', 'quiz-state.js'));

const REAL_CACHE = quiz.ANSWER_CACHE_FILE;
const REAL_OUT = quiz.OUT_FILE;
const REAL_CFG = quiz.CFG_FILE;
const REAL_FETCH = globalThis.fetch;

/* 这个章节名只出现在测试里 —— 它出现在**真**记录文件里就说明测试写错了地方。
   注意：只在"临时文件"里找它，绝不读用户的真记录（那是用户的数据）。 */
const MARK = '测验 · 假章节·接口测试';

/* 【护栏】临时目录必须真的是临时目录。
   写错一次就会往工作区里塞一个 答题答案缓存.json，或者往真记录里追加内容。 */
function assertIsTempPath(p) {
  const t = path.resolve(p);
  const root = path.resolve(os.tmpdir());
  assert.ok(t.startsWith(root + path.sep), '测试只能写临时目录，拿到的是 ' + t);
}

/* 【必须 async 感知】理由跟 quiz-shot.test.js 里那条一样：
   同步的 withXxx 会在 await 还没跑完时就把路径还原了，等于没换。 */
async function withTmpPaths(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-helper-test-'));
  const cache = path.join(dir, 'fake-答题答案缓存.json');
  const out = path.join(dir, 'fake-章节测验记录.txt');
  const cfgFile = path.join(dir, 'fake-答题设置.json');
  assertIsTempPath(cache);
  assertIsTempPath(out);
  assertIsTempPath(cfgFile);
  quiz.ANSWER_CACHE_FILE = cache;
  quiz.OUT_FILE = out;
  quiz.CFG_FILE = cfgFile;
  try {
    return await fn({ dir, cache, out, cfgFile });
  } finally {
    quiz.ANSWER_CACHE_FILE = REAL_CACHE;
    quiz.OUT_FILE = REAL_OUT;
    quiz.CFG_FILE = REAL_CFG;
    globalThis.fetch = REAL_FETCH;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ============================================================================
 * 假页面：一个能应付 handle() 全程的 ev
 *
 * 走的是"截图读题"这条路（readMode: 'shot'），因为它在离线环境里完全可假：
 *   questionShotPlan 拿不到坐标 → 退路：数题数 → 滚到第 i 题 → 截图
 *   截图交给假模型抄录 → 拿答案 → 按题号填（CDP 假点击）→ 保存
 * 保存那一步用真 saveProbe 的返回形状（probe 本身的行为在 quiz-save.test.js
 * 里是用 vm 真跑过的，这里只需要它喂出来的事实）。
 *
 * 点击是"两段式"的假实现：第一次 fillAct 说没选中 → clickAt 记下坐标 →
 * 复查那次才说选中了。这样 fillFromText 的"点击→复查"链路是真走了一遍。
 * ==========================================================================*/
const SAVE_BTN = [{ text: '暂时保存', state: 'null|btnSave workBtnIndex' }];
const SAVING_BTN = [{ text: '保存中…', state: 'null|btnSave workBtnIndex' }];

function saveProbeOk() {
  return {
    ok: true, text: '暂时保存', cls: 'btnSave workBtnIndex', onclick: 'noSubmit();',
    clickError: '', cands: 1, rejected: [], notes: [], baseToasts: [], btnBefore: SAVE_BTN
  };
}
function saveProbeRejected() {
  return {
    ok: false, kind: 'none', why: '只找到提交类按钮，已拒绝：提交',
    rejected: ['提交'], notes: [], baseToasts: [], btnBefore: [], direct: null
  };
}

function makeFakePage(opt) {
  const o = opt || {};
  const found = Number(o.found) || 1;
  const states = Array.isArray(o.states) ? o.states.slice() : [];
  const lastState = states.length ? states[states.length - 1] : { toasts: [], btns: SAVE_BTN, busy: 0 };
  let si = 0;
  const clicked = new Set();       /* "题号:选项序号" —— 点过的才算选中 */
  const counters = {
    probe: 0, fill: 0, saveProbe: 0, state: 0, plan: 0, count: 0, scroll: 0, shots: 0, clicks: 0, other: 0, course: 0
  };
  const unknown = [];

  const ev = async (expr) => {
    const s = String(expr);
    /* --- 填题那两条要排最前：fillAct 的脚本里也带别的关键词 --- */
    if (/var BY = "probe"/.test(s)) {
      counters.probe++;
      return { ok: true, n: found, vis: found, probe: true, docs: 1, detail: [] };
    }
    if (/var BY = /.test(s)) {
      counters.fill++;
      const h = s.match(/var HINT = (-?\d+);/);
      const idx = h ? Number(h[1]) : 0;
      const v = s.match(/var V = (\[[^\]]*\]);/);
      const letters = v ? JSON.parse(v[1]) : [];
      return {
        ok: true, n: found,
        picks: letters.map((L, i) => ({
          letter: L, already: false, inView: true,
          selected: clicked.has(idx + ':' + i),
          x: 100 + i * 7, y: 200 + idx * 13
        }))
      };
    }
    /* --- 保存那两步 --- */
    if (/isSubmit/.test(s)) {
      counters.saveProbe++;
      if (o.saveProbeThrows) throw new Error(o.saveProbeThrows);
      return typeof o.saveProbe === 'function' ? o.saveProbe() : (o.saveProbe || saveProbeOk());
    }
    if (/toasts = \[\]/.test(s)) {
      counters.state++;
      return si < states.length ? states[si++] : lastState;
    }
    /* --- 截图这一路 --- */
    if (/docsSeen/.test(s)) { counters.plan++; return null; }        /* 定向截图没坐标 → 走退路 */
    if (/return roots\.length/.test(s)) { counters.count++; return found; }
    if (/scrollIntoView/.test(s)) { counters.scroll++; return { ok: true, n: found, w: 200, h: 80 }; }
    if (/innerWidth/.test(s)) return JSON.stringify({ w: 1500, h: 900 });   /* 视口正常，不动 Emulation */
    if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
    /* 课程名探针（2026-10-12 加：记录里要写"课程：X"，用来按课程分库）—— 认得它，不算"没预料到" */
    if (/courseName/.test(s)) { counters.course++; return '军事理论'; }
    counters.other++;
    unknown.push(s.slice(0, 70));
    return null;
  };

  const clickAt = async (x, y) => {
    counters.clicks++;
    const idx = Math.round((y - 200) / 13);
    const i = Math.round((x - 100) / 7);
    clicked.add(idx + ':' + i);
    return true;
  };
  const shot = async () => { counters.shots++; return 'ZmFrZQ=='; };
  return { ev, clickAt, shot, counters, unknown, clicked };
}

/* 假网络：只认模型名，只回假 JSON。**一个真实请求都不发。** */
function fakeNet(log) {
  return async (url, opts) => {
    let body = {};
    try { body = JSON.parse(String((opts && opts.body) || '{}')); } catch (e) {}
    const kind = body.model === 'fvm' ? 'transcribe' : (body.model === 'fm' ? 'answer' : 'other');
    log.push({ kind: kind, url: String(url), model: body.model });
    if (kind === 'other') throw new Error('测试里不该出现没预料到的请求：' + JSON.stringify(body).slice(0, 120));
    const content = kind === 'transcribe'
      ? '【单选题】下列说法正确的是\nA. 甲\nB. 乙\n【单选题】下面哪个对\nA. 丙\nB. 丁'
      : '1. A —— 理由略\n2. B —— 理由略';
    return {
      ok: true, status: 200, __apiAttempts: 1,
      json: async () => ({
        choices: [{ message: { content: content } }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
      }),
      text: async () => ''
    };
  };
}

function makeCfg(extra) {
  const stats = {
    chapters: 0, found: 0, filled: 0, missed: 0,
    /* 名字跟 答题助手.js 的 noteSave 写的那三个**必须一致** */
    saveConfirmed: 0, saveUnconfirmed: 0, saveFailed: 0
  };
  const missed = [];
  const cfg = Object.assign({
    mode: 2,
    apiKey: '假key-不准是真key',
    model: 'fm',
    visionModel: 'fvm',
    readMode: 'shot',
    maxShots: 2,
    autoFill: true,
    useAnswerCache: false,
    maxPerChapter: 30,
    stats: stats,
    onUnanswered: (rec) => missed.push(rec)
  }, extra || {});
  return { cfg: cfg, stats: stats, missed: missed };
}

/* 一遍完整的 handle：截图 → 抄录 → 问答案 → 填 → 保存 */
async function runHandle(o) {
  const page = makeFakePage(o);
  const netLog = [];
  const built = makeCfg(o.cfg);
  globalThis.fetch = fakeNet(netLog);
  const helper = quiz.makeHelper(built.cfg, {
    ev: page.ev, shot: page.shot, clickAt: page.clickAt, reopenQuiz: null
  });
  const lines = await helper.handle(MARK, o.probe, () => {});
  return { helper: helper, lines: lines, page: page, netLog: netLog, stats: built.stats, missed: built.missed };
}

/* 【每个会写文件的用例都必须走这里】
   临时三个路径 + 假 fetch，跑完在 finally 里全还回去。 */
async function withRun(o, fn) {
  return withTmpPaths(async (tmp) => {
    const built = await runHandle(o);
    return fn(built, tmp);
  });
}

/* ============================================================================
 * 一、刚建好、还没做任何事
 * ==========================================================================*/

test('刚建好的 helper：lastSaveResult() 返回 null（不是抛错），pendingSave() 说"没事"', async () => {
  await withTmpPaths(async () => {
    const helper = quiz.makeHelper(makeCfg().cfg, { ev: async () => null, shot: async () => '' });
    /* 【这一行就是那个作用域 bug 的探针】
       修之前 lastSaveResult() 里的 saveResult 只活在 handle() 的作用域里，
       调用它直接 ReferenceError —— 而 填作业.js 用 try/catch 吞掉了。
       这里**不许**包 try/catch：调不通就该红。 */
    const r = helper.lastSaveResult();
    assert.equal(r, null, '还没跑过 handle，结构化结果必须是 null');

    assert.deepEqual(helper.pendingSave(),
      { needConfirm: false, blocksContinue: false, status: '', origin: '', message: '' },
      '还没有任何保存动作，pendingSave() 必须是这套默认值');
    assert.equal(helper.mode, 2);
    assert.match(QS.formatUsage(helper.lastUsage()), /没有调用模型|0 token/);
  });
});

/* ============================================================================
 * 二、handle 之后：四种保存结局，公开接口给的必须是同一次真实结果
 * ==========================================================================*/

test('handle 后 · 平台确认了保存（先看到"保存中"、再看到成功提示）→ saved，且 pendingSave() 与之一致', async () => {
  await withRun({
    found: 2,
    probe: { found: 2, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] },
    saveProbe: saveProbeOk,
    states: [
      { toasts: [], btns: SAVING_BTN, busy: 0 },              /* 先"保存中" —— 只算正在写，不能结案 */
      { toasts: ['保存成功'], btns: SAVE_BTN, busy: 0 }        /* 新出现的成功提示才算证据 */
    ]
  }, async ({ helper, lines, page, netLog, stats }) => {
    const r = helper.lastSaveResult();
    assert.ok(r, 'lastSaveResult() 不能是 null —— 这一章明明走到保存那一步了');
    assert.equal(r.status, QS.SAVE.SAVED);
    assert.equal(r.confirmed, true);
    assert.equal(r.ok, true);
    assert.equal(r.needConfirm, false);
    assert.equal(r.blocksContinue, false);
    assert.equal(r.reason, 'toast_saved');
    assert.match(r.msg, /保存成功/);
    /* 【"保存中"绝不能当场结案】第 1 轮页面上只有"保存中…"，
       所以必须再轮一次、等到**新出现**的成功提示才敢下结论。
       这条用例里成功提示来得早（第 2 轮就到了），所以慢轮询那一段不会触发 ——
       "一直等满 10 轮"由下面那条"从头到尾只看到保存中"的用例盯着。 */
    assert.ok(page.counters.state >= 2,
      '第一轮只看到"保存中"，必须再轮一次才能结案：' + page.counters.state);
    assert.equal(r.evidence && r.evidence.rounds, page.counters.state,
      '"轮询了几次"要如实记在证据里');
    assert.equal(page.counters.saveProbe, 1, '保存只探测一次');
    assert.equal(page.counters.clicks, 2, '两道题各点一次（两段式：点了再复查）');
    assert.equal(page.counters.other, 0, '没有没预料到的页面脚本：' + page.unknown.join(' | '));
  assert.ok(page.counters.course >= 1, '一章要问一次课程名（记录里要写"课程：X"，用来按课程分库）');
    assert.equal(netLog.length, 2, '只该有两次假请求：抄录一次、问答案一次');
    assert.ok(netLog.every((x) => x.kind !== 'other'), '不该有没预料到的请求');

    const p = helper.pendingSave();
    assert.equal(p.status, r.status, 'pendingSave() 必须跟 lastSaveResult() 说的是同一次保存');
    assert.equal(p.needConfirm, false);
    assert.equal(p.blocksContinue, false);
    assert.equal(p.message, r.msg, 'pendingSave().message 就是那句话，不该两处各说一套');
    assert.equal(helper.lastSaveResult(), r, '反复调用给的是同一个结果对象（不是每次新建一个）');

    /* 【保存次数 ≠ 题数】这一章填了 2 道题、保存被证实 1 次。
       注意："遇到几道题"（found）在这条截图路里不由 handle 记账 ——
       driver.js 是拿探针数自己加到 quizStats.found 上的，
       这里只断言"真填进页面"和"保存被证实"是两件独立的事。 */
    assert.equal(stats.filled, 2, '真填进页面的是 2 道');
    assert.equal(stats.saveConfirmed, 1, '保存被证实 1 **次**（不是 2 道题）');
    assert.equal(Number(stats.saveUnconfirmed) || 0, 0);
    assert.equal(Number(stats.saveFailed) || 0, 0);

    const text = lines.join('\n');
    assert.match(text, /已确认保存/, '账目行要如实说"已确认保存"');
    assert.match(text, /填进页面 2 道/, '账目行里的"填进页面"按题数算');
  });
});

test('handle 后 · 从头到尾只看到"保存中"、始终没有成功提示 → unconfirmed，而且明确不许接着做会丢草稿的事', async () => {
  /* 【这条是"慢网络"那个现场】按钮停在"保存中…"，草稿到底存没存上没人知道。
     必须报"未确认"，绝不能因为"点了、按钮有反应"就报成功。
     生产节奏：4×700ms 快轮询 + 6×1200ms 慢轮询，所以这条用例要跑约 10 秒。 */
  await withRun({
    found: 1,
    probe: { found: 1, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] },
    saveProbe: saveProbeOk,
    states: Array.from({ length: 12 }, () => ({ toasts: [], btns: SAVING_BTN, busy: 0 }))
  }, async ({ helper, lines, page, stats }) => {
    const r = helper.lastSaveResult();
    assert.equal(r.status, QS.SAVE.UNCONFIRMED);
    assert.equal(r.confirmed, false, '"保存中"永远不等于"存好了"');
    assert.equal(r.needConfirm, true);
    assert.equal(r.blocksContinue, true, '未确认时**不允许**继续做会丢草稿的动作（翻页/下一章/关页面）');
    assert.equal(r.reason, 'no_proof');
    assert.match(r.msg, /没能确认已保存|没看到平台的保存成功提示/);
    assert.match(r.msg, /正在保存/, '要说清"看到的只是正在保存"');
    /* 【判"有没有出现肯定说法"要排除那句如实的否定】
       "没看到平台的保存成功提示"是允许的（那是如实报告）；
       不许出现的是"保存成功"这种把没证据的事说成成功的话。 */
    assert.doesNotMatch(r.msg, /保存成功(?!提示)/, '日志里绝不能出现"保存成功"这种没证据的说法');
    assert.doesNotMatch(r.msg, /已确认保存|已保存[。，]/);
    assert.ok(page.counters.state >= 10, '应该把快慢两段轮询都跑满：' + page.counters.state);

    const p = helper.pendingSave();
    assert.equal(p.status, 'unconfirmed');
    assert.equal(p.needConfirm, true);
    assert.equal(p.blocksContinue, true);
    assert.equal(p.message, r.msg);

    assert.equal(Number(stats.saveConfirmed) || 0, 0, '一次都不许记成"已确认保存"');
    assert.equal(stats.saveUnconfirmed, 1, '记成"未确认保存 1 次"');
    assert.equal(Number(stats.saveFailed) || 0, 0);
    assert.match(lines.join('\n'), /未确认保存/);
  });
});

test('handle 后 · 连"保存中"都没有、页面上一个提示都没冒出来 → unconfirmed（绝不因为"点过了"就说存好了）', async () => {
  await withRun({
    found: 1,
    probe: { found: 1, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] },
    saveProbe: saveProbeOk,
    states: [{ toasts: [], btns: SAVE_BTN, busy: 0 }]      /* 一直是这样 */
  }, async ({ helper, page, stats }) => {
    const r = helper.lastSaveResult();
    assert.equal(r.status, QS.SAVE.UNCONFIRMED);
    assert.equal(r.confirmed, false);
    assert.equal(r.needConfirm, true);
    assert.equal(r.blocksContinue, true);
    assert.equal(page.counters.state, 4, '没有任何"保存中"迹象时只跑 4 次快轮询，不该白白多等');
    assert.equal(stats.saveUnconfirmed, 1);
    assert.equal(Number(stats.saveConfirmed) || 0, 0);
    assert.equal(helper.pendingSave().status, 'unconfirmed');
  });
});

test('handle 后 · 安全闸门拒绝（页面上只有提交按钮）→ rejected，既不算保存也不算"待确认"', async () => {
  await withRun({
    found: 1,
    probe: { found: 1, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] },
    saveProbe: saveProbeRejected,
    states: [{ toasts: [], btns: SAVE_BTN, busy: 0 }]
  }, async ({ helper, lines, page, stats }) => {
    const r = helper.lastSaveResult();
    assert.equal(r.status, QS.SAVE.REJECTED, '只找到提交类按钮 → 必须是"已拒绝"');
    assert.equal(r.confirmed, false);
    assert.equal(r.needConfirm, false, 'needConfirm 只表示"saving/unconfirmed"；拒绝归"没做成"，但不许说成保存成功');
    assert.equal(r.blocksContinue, true, '【口径】被拒绝≠页面没填过：答案可能已经在页面上，不许自动离开');
    assert.equal(r.reason, 'submit_button_only');
    assert.match(r.msg, /已拒绝/);
    assert.match(r.msg, /提交/);
    assert.equal(page.counters.state, 0, '被拒绝时不该进入轮询（轮询是"点下去了"才做的事）');

    const p = helper.pendingSave();
    assert.equal(p.status, 'rejected');
    assert.equal(p.blocksContinue, true, '同上：pendingSave() 也要如实反映"不许自动继续"');

    assert.equal(stats.saveFailed, 1, '拒绝要记进"保存没做成"的次数里');
    assert.equal(Number(stats.saveConfirmed) || 0, 0);
    assert.equal(Number(stats.saveUnconfirmed) || 0, 0);
    assert.match(lines.join('\n'), /已拒绝/);
  });
});

test('handle 后 · 探测保存按钮时页面抛错 → failed（说清死因，不假装成功）', async () => {
  await withRun({
    found: 1,
    probe: { found: 1, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] },
    saveProbeThrows: '页面里执行出错: 连接断了',
    states: [{ toasts: [], btns: SAVE_BTN, busy: 0 }]
  }, async ({ helper, stats }) => {
    const r = helper.lastSaveResult();
    assert.equal(r.status, QS.SAVE.FAILED);
    assert.equal(r.confirmed, false);
    assert.equal(r.reason, 'probe_error');
    assert.match(r.msg, /连接断了/, '失败原因必须出现在结论里');
    assert.doesNotMatch(r.msg, /保存成功/);
    assert.equal(stats.saveFailed, 1);
    assert.equal(helper.pendingSave().status, 'failed');
  });
});

/* ============================================================================
 * 三、这些用例碰过的文件，一个都不许是真文件
 * ==========================================================================*/

/* 【字段名契约】上面几条验的是"助手写进去的字段名对不对"（行为级），
   这一条补上"读的那一头读的是不是同一套名字"：
   helper 写 saveConfirmed，而 填作业.js 原来读 saved ——
   两边各写各的，于是"保存被平台证实了"也可能显示 0 次。
   读侧是个顶层 IIFE（一跑就连 CDP），没法直接 import 进来测，
   所以这里只核对"它读的名字"和"助手写的名字"是同一套。
   改名字必须两边一起改，这条测试就是那道提醒。 */
test('字段名契约：答题助手写的三个计数字段，填作业.js 读的是同一套', () => {
  const srcQuiz = fs.readFileSync(path.join(__dirname, '..', '答题助手.js'), 'utf8');
  const srcFill = fs.readFileSync(path.join(__dirname, '..', '填作业.js'), 'utf8');
  for (const f of ['saveConfirmed', 'saveUnconfirmed', 'saveFailed']) {
    /* 写侧：这个名字在助手里要有（"handle 真的把它加上去了"由上面几条行为级用例验过） */
    assert.ok(srcQuiz.indexOf(f) >= 0, '答题助手.js 里应该有 ' + f + ' 这个记账字段');
    /* 读侧：填作业.js 通过 saveTally 读同一个名字 */
    assert.match(srcFill, new RegExp("saveTally\\('" + f + "'"),
      '填作业.js 必须读 ' + f + '（名字跟写侧保持一致）');
  }
  /* 旧名字只能出现在"兼容映射"的位置，不能当成主字段再建一份 */
  assert.doesNotMatch(srcFill, /\bsaved:\s*0/, '填作业.js 不该再建 saved:0 这种旧字段');
  assert.doesNotMatch(srcFill, /\bsavedUnconfirmed:\s*0/, '同上，别再建 savedUnconfirmed:0');
});

test('隔离：路径用完必须还原（记录 / 配置 / 缓存 / 假 fetch 四样）', () => {
  assert.equal(quiz.OUT_FILE, REAL_OUT, '用完必须把记录文件路径还回去');
  assert.equal(quiz.CFG_FILE, REAL_CFG);
  assert.equal(quiz.ANSWER_CACHE_FILE, REAL_CACHE);
  assert.equal(globalThis.fetch, REAL_FETCH, '假 fetch 必须还原');
  /* 【不读真记录、也不要求工作区里的缓存文件不存在】
     用户跑过助手之后 答题答案缓存.json 本来就该在。这里只核对"路径确实指回真的那个"，
     至于那个文件在不在、多大，不是测试该管的事。 */
  assert.ok(path.resolve(quiz.OUT_FILE) === path.resolve(REAL_OUT));
});

test('隔离：handle 的记录写进的是**本次临时文件**，MARK 在假文件里（不碰真记录）', async () => {
  await withRun({
    found: 2,
    probe: { found: 2, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] },
    saveProbe: saveProbeOk,
    states: [{ toasts: ['保存成功'], btns: SAVE_BTN, busy: 0 }]
  }, async ({ stats }, tmp) => {
    /* 1) 写入目标就是这次给的临时文件 */
    assert.equal(path.resolve(quiz.OUT_FILE), path.resolve(tmp.out), 'handle 期间 OUT_FILE 必须是临时文件');
    assert.ok(fs.existsSync(tmp.out), '这一章有题、有结论，记录必须真的落盘（写成空的就是撒谎）');
    const text = fs.readFileSync(tmp.out, 'utf8');
    assert.ok(text.indexOf(MARK) >= 0, '临时记录里必须有这一章的标记（MARK）：' + text.slice(0, 200));
    assert.match(text, /保存/, '记录里要有保存那一档的结论');

    /* 2) 此刻还在 withTmpPaths 里，所以路径**应当**还是临时那份；
        "还回去了没有"由上面那条独立用例在看（它跑在 withTmpPaths 之外）。 */
    assert.notEqual(path.resolve(quiz.OUT_FILE), path.resolve(REAL_OUT),
      '跑 handle 期间绝不能指向真记录文件');
    assert.ok(stats && typeof stats === 'object');
  });
});

test('隔离：缓存文件只写临时位置（用"换路径 + 看谁被写"验，不看用户那份）', async () => {
  /* 把"工作区里那份缓存该不该存在"换成："开缓存跑一遍之后，写出来的是**临时那份**"。
     这样无论用户有没有真缓存，测试结论都一样。 */
  await withRun({
    found: 1,
    probe: { found: 1, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] },
    saveProbe: saveProbeOk,
    cfg: { useAnswerCache: true },
    states: [{ toasts: ['保存成功'], btns: SAVE_BTN, busy: 0 }]
  }, async (built, tmp) => {
    assert.equal(path.resolve(quiz.ANSWER_CACHE_FILE), path.resolve(tmp.cache), '缓存路径必须是临时那份');
    /* 缓存写不写、写几条由业务决定；这里只要求"要写就写进临时那份" */
    if (fs.existsSync(tmp.cache)) {
      const raw = fs.readFileSync(tmp.cache, 'utf8');
      assert.ok(raw.length > 0, '缓存文件存在就必须有内容');
      assert.doesNotMatch(raw, /sk-/, '缓存里绝不能出现密钥');
    }
    assert.notEqual(path.resolve(quiz.ANSWER_CACHE_FILE), path.resolve(REAL_CACHE),
      '跑 handle 期间缓存绝不能指向用户那份（还原由上面那条独立用例看）');
  });
});
