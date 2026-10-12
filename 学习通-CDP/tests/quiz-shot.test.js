/* quiz-shot.test.js —— 离线验证"截图读题"这条路 + API 超时/重试 + 指纹去重
 *
 * 全部是假的：不连浏览器、不发真实请求、不读任何真实配置/题库/记录。
 * 网络那一层是把 globalThis.fetch 换成假的，只用来数"发了几次、带了什么"。
 *
 * 覆盖：
 *   1. shot 的 setViewport / clearViewport 契约：小视口要撑大、拍完要还原，
 *      撑不起来/还原不了都要留下痕迹（原来那句 `await shot.setViewport && ...`
 *      在属性不存在时恒为假，什么都不报）。
 *   2. reopenQuiz 不可用 + 抄录里没有题 → **不自动填**，并说明原因。
 *   3. reopenQuiz 试了也救不回来 → 同样不自动填。
 *   4. 题干前 80 字相同的两道题都要被问到（不能再被静默去重丢掉）。
 *   5. 超时最多重试 1 次（和连接故障重试 2 次分开），日志/账目里有痕迹。
 *
 * 跑法：
 *   C:\Users\TestUser\DeepSeekHarness\node\node.exe --test --test-isolation=none tests\quiz-shot.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
/* 【每个测试文件一个专属的临时目录装 BANK_FILE】—— 库管理之后，子库是放在 '<BANK_FILE 所在目录>\题库\' 里的，
   如果大家共用 os.tmpdir()，别的运行留下的子库会被一起查到 ⇒ 两个库答案不一致 ⇒ 命中被拒（实测踩过）。
   注意：这一行必须在 path 声明**之后**（写在前面会撞上 const 的暂时性死区，整个文件加载失败）。 */
const BANKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-shot-banks-'));

const quiz = require(path.join(__dirname, '..', '答题助手.js'));

const REAL_CACHE = quiz.ANSWER_CACHE_FILE;
const REAL_BANK = quiz.BANK_FILE;      /* 本地题库：测试也必须隔离它，理由见下 */
const REAL_CFG = quiz.CFG_FILE;
const REAL_OUT = quiz.OUT_FILE;

/* 【跑测试之前，工作区那份答案缓存是什么样】
   它是运行期产物 —— 真跑过助手就会有（可能有真实答案），没有也正常。
   这里记下"测试开始那一刻的 mtime"当基线：跑完再比，
   **变了才算被测试污染**。只判"存不存在"会把"机器跑过助手"误判成测试失败
   （2026-10-11 实测踩到：驱动器 15:39:59 真答题写了缓存，测试立刻红）。 */
/* 记录文件的起点大小（判"测试期间新增的那段"用；驱动器也在写这个文件，所以不能比 mtime） */
const WORKSPACE_RECORD_SIZE_AT_TEST_START = (() => {
  const p = path.join(__dirname, '..', '章节测验记录.txt');
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
})();
const WORKSPACE_CACHE_MTIME_AT_TEST_START = (() => {
  try {
    const p = path.join(__dirname, '..', '答题答案缓存.json');
    return fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
  } catch (e) { return 0; }
})();

/* 【护栏】临时目录必须是临时目录。
   写错一次就会在工作区里留下一个 答题答案缓存.json —— 那是测试污染，
   不是产品文件。这里在换路径之前先挡一道。 */
function assertIsTempPath(p) {
  const t = path.resolve(p);
  const root = path.resolve(os.tmpdir());
  assert.ok(t.startsWith(root + path.sep), '测试只能写临时目录，拿到的是 ' + t);
}

/* 【必须 async 感知】
   第一版这里是同步的：
       function withTmpCache(fn) { 设路径; try { return fn(...) } finally { 还原路径 } }
   而测试体是 async 的 —— fn() 一返回 Promise，finally 立刻就把路径还原成
   工作区里那份了，真正的 await 还在后面跑。结果回答缓存被写进工作区
   （测试污染）。现在改成 await 之后再还原，并用下面那条工作区断言盯着。 */
async function withTmpCache(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-shot-test-'));
  const cache = path.join(dir, 'fake-答题答案缓存.json');
  /* 【本地题库也要隔离】它是用户数据：装了库的人，答题时命中库就不问模型了。
     不隔离的话，这几条"数一共问了模型几次"的用例会随**用户有没有建库**而红 ——
     实测撞到过（2026-10-11 加了题库查询之后，这里当场红了两条）。
     指到一个**不存在**的路径 = "没装库的世界"，产品行为与以前一致。 */
  const bank = path.join(dir, 'fake-题库.json');
  /* 【记录文件也必须隔离 —— 这一条是我用真数据撞出来的】
     handle() 收尾会 save()：把这一章写进 OUT_FILE。这几条用例会真的调 handle()，
     而第一版只隔离了缓存和题库 —— 于是假章节被追加进了**用户自己的** 章节测验记录.txt
     （实测：23:38~00:11 那一段塞了 21 个"测验 · 假章节"块，里面还带着 p.example 这种测试 URL）。
     现在 OUT_FILE / CFG_FILE 一起指到临时目录：测试写的东西只落在临时目录里。 */
  const out = path.join(dir, 'fake-章节测验记录.txt');
  const cfgFile = path.join(dir, 'fake-答题设置.json');
  assertIsTempPath(cache);
  assertIsTempPath(bank);
  assertIsTempPath(out);
  assertIsTempPath(cfgFile);
  quiz.ANSWER_CACHE_FILE = cache;
  quiz.BANK_FILE = bank;
  quiz.OUT_FILE = out;
  quiz.CFG_FILE = cfgFile;
  try {
    return await fn({ dir, cache, bank, out });
  } finally {
    quiz.ANSWER_CACHE_FILE = REAL_CACHE;
    quiz.BANK_FILE = REAL_BANK;
    quiz.OUT_FILE = REAL_OUT;
    quiz.CFG_FILE = REAL_CFG;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ============================================================================
 * 一、截图：视口契约
 * ==========================================================================*/

test('小视口：截图前撑到 1280x900，拍完还原（diag 里能看见全过程）', async () => {
  const calls = [];
  const ev = async (expr) => {
    const s = String(expr);
    if (/innerWidth/.test(s)) return JSON.stringify({ w: 781, h: 156 });
    if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 3241 });
    return null;
  };
  const shot = async () => 'ZmFrZQ==';
  shot.setViewport = async (w, h) => { calls.push(['set', w, h]); return true; };
  shot.clearViewport = async () => { calls.push(['clear']); return true; };

  const diag = {};
  /* questionShotPlan / countQuestions 都返回 null（页面脚本这里返回 null），
     所以会走到"退路"那一段；退路里 scrollToQuestion 也返回 null 会立即 break，
     一张都拍不到 —— 这正是"视口被压小"那个现场该有的结果，不影响我们 провер视口契约。 */
  const out = await quiz.grabShots(ev, shot, 3, diag);
  assert.deepEqual(out, []);
  assert.equal(diag.smallViewport, true, '要认出视口被压小了');
  assert.equal(diag.triedExpand, true, '要真的去撑');
  assert.equal(diag.expanded, true);
  assert.deepEqual(calls, [['set', 1280, 900], ['clear']], '撑大之后**必须**还原，顺序也不能反');
  assert.ok(diag.note.some((l) => /视口被压小/.test(l)), '日志里要能看到');
  assert.equal(diag.emptyShots, true, '一张都没拍到要如实标记');
});

test('截图函数没挂 setViewport：不装作没事，diag 里明确报出来', async () => {
  const ev = async (expr) => {
    const s = String(expr);
    if (/innerWidth/.test(s)) return JSON.stringify({ w: 700, h: 200 });
    if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
    return null;
  };
  const shot = async () => '';        /* 既没挂 setViewport 也没挂 clearViewport */
  const diag = {};
  await quiz.grabShots(ev, shot, 3, diag);
  assert.equal(diag.smallViewport, true);
  assert.equal(diag.expanded, false);
  assert.match(String(diag.expandError), /没有 setViewport/);
  assert.ok(diag.note.some((l) => /没有 setViewport/.test(l)),
    '这正是原来那个"恒为假、什么都不报"的 bug，现在必须有话说');
});

test('还原视口失败要留痕（否则后面驱动的点击坐标会全偏）', async () => {
  const ev = async (expr) => {
    const s = String(expr);
    if (/innerWidth/.test(s)) return JSON.stringify({ w: 500, h: 300 });
    if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
    return null;
  };
  const shot = async () => '';
  shot.setViewport = async () => true;
  shot.clearViewport = async () => false;
  const diag = {};
  await quiz.grabShots(ev, shot, 3, diag);
  assert.ok(diag.note.some((l) => /clearViewport 返回 false/.test(l)));
});

test('视口正常时不乱动 Emulation（别给页面添不必要的重排）', async () => {
  let touched = 0;
  const ev = async (expr) => {
    const s = String(expr);
    if (/innerWidth/.test(s)) return JSON.stringify({ w: 1500, h: 900 });
    if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
    return null;
  };
  const shot = async () => '';
  shot.setViewport = async () => { touched++; return true; };
  shot.clearViewport = async () => { touched++; return true; };
  const diag = {};
  await quiz.grabShots(ev, shot, 3, diag);
  assert.equal(touched, 0, '视口本来就正常，不该去设 Emulation');
  assert.equal(diag.smallViewport, false);
});

test('shot 抛错/返回空图都要被记下来（不能只当成"没截到"）', async () => {
  let scrolled = false;
  const ev = async (expr) => {
    const s = String(expr);
    if (/innerWidth/.test(s)) return JSON.stringify({ w: 1500, h: 900 });
    if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
    /* 让"退路"那一段真的跑起来：报 1 道题、滚动成功 */
    if (/^\(function \(\) \{\s*\n\s*function allDocs/.test(s) && /return roots\.length/.test(s)) return 1;
    if (/scrollIntoView/.test(s)) { scrolled = true; return { ok: true, n: 1, w: 100, h: 100 }; }
    return null;
  };
  const shot = async () => { throw new Error('CDP target closed'); };
  const diag = { note: [], captureErrors: [] };
  const out = await quiz.grabShots(ev, shot, 3, diag);
  assert.equal(scrolled, true, '应该走到"滚到题再整屏拍"那条退路');
  assert.deepEqual(out, []);
  assert.ok((diag.captureErrors || []).some((m) => /CDP target closed/.test(m)),
    '截图抛错的原因必须留下来，不能变成一个空数组了事');
  assert.equal(diag.emptyShots, true);
});

/* ============================================================================
 * 二、抄录不可信时不许自动填
 * ==========================================================================*/

/* 造一个"字体和本地解码表对不上 → 走截图读题"的探针结果。
   （本地确实装了对照表，但页面给的 fontB64 是空的，fontTableMatches 会返回 false） */
function shotProbe(found) {
  return { found: found || 2, obfCount: 2, fontB64: '', graded: false, docCount: 1, questions: [] };
}

function assertNoFill(lines) {
  const text = lines.join('\n');
  assert.doesNotMatch(text, /已点 「暂时保存」/, '不可信的时候绝不能去点保存');
  assert.doesNotMatch(text, /safer|已按顺序填进页面/, '不可信的时候绝不能填');
  return text;
}

test('没有 reopenQuiz + 抄录里一道题都没有 → 报告原因，且**不自动填**', async () => {
  await withTmpCache(async () => {
    const calls = [];
    const ev = async (expr) => {
      const s = String(expr);
      /* 预检那条要排在视口那条前面（见下面那个用例的说明） */
      if (/BY = .probe./.test(s)) { calls.push('probe'); return { ok: true, n: 2, vis: 2, probe: true, docs: 1 }; }
      if (/innerWidth/.test(s)) return JSON.stringify({ w: 1500, h: 900 });
      if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
      if (/countQuestions/.test(s)) return 2;
      if (/scrollIntoView/.test(s)) return { ok: true, n: 2, w: 100, h: 100 };
      return null;
    };
    const shot = async () => 'ZmFrZQ==';
    /* 抄录：明确说"截图里没有题目"（实测里模型就是这么回的，不是空字符串） */
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '当前截图里没有题目或选项，只有课程页面信息，无法抄录。' } }], usage: { total_tokens: 10 } }),
      text: async () => ''
    });
    try {
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'shot', maxShots: 3, autoFill: true, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot, reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', shotProbe(2), () => {});
      const text = assertNoFill(lines);
      assert.ok(calls.includes('probe'), '只读预检必须真的跑过（哪怕没有 reopenQuiz）');
      assert.match(text, /没法重开作业卡|不自动填、不自动保存/, '要明确说明"因为不能重开，所以不自动填"');
      assert.match(text, /不可信/, '要把"结果不可信"写出来');
      const p = helper.pendingSave();
      assert.equal(p.needConfirm, false, '压根没点保存，不该冒出"待确认保存"');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('reopenQuiz 试了但救不回来（抄录仍无题）→ 同样不自动填', async () => {
  await withTmpCache(async () => {
    let reopenCalls = 0;
    const ev = async (expr) => {
      const s = String(expr);
      if (/BY = .probe./.test(s)) return { ok: true, n: 2, vis: 2, probe: true, docs: 1 };
      if (/innerWidth/.test(s)) return JSON.stringify({ w: 1500, h: 900 });
      if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
      if (/countQuestions/.test(s)) return 2;
      if (/scrollIntoView/.test(s)) return { ok: true, n: 2, w: 100, h: 100 };
      return null;
    };
    const shot = async () => 'ZmFrZQ==';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '图片为空白，没有可抄录的题目。' } }] }),
      text: async () => ''
    });
    try {
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'shot', maxShots: 3, autoFill: true, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot, reopenQuiz: async () => { reopenCalls++; return '点了「作业作答」但页面上还是 0 道题（重开没能证实）'; }, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', shotProbe(2), () => {});
      const text = assertNoFill(lines);
      assert.ok(reopenCalls >= 1, '应该真的试过重开');
      assert.match(text, /重开/, '重开的过程要写进日志');
      assert.match(text, /不可信/, '救不回来就要标成不可信');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('题目在 DOM 里但看不见 + 没有 reopenQuiz → 预检要跑，而且不自动填', async () => {
  await withTmpCache(async () => {
    let sawProbe = false;
    const ev = async (expr) => {
      const s = String(expr);
      /* 顺序有讲究：先判"只读预检"那条页面脚本（它里面也带 innerWidth 之类的词），
         再判视口大小 —— 反过来的话预检会被视口那条先截走。 */
      if (/BY = .probe./.test(s)) { sawProbe = true; return { ok: true, n: 2, vis: 0, probe: true, docs: 1 }; }
      if (/innerWidth/.test(s)) return JSON.stringify({ w: 1500, h: 900 });
      if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
      return null;
    };
    const shot = async () => 'ZmFrZQ==';
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (u) => {
      /* 【只数"模型调用"】答题助手现在还会用 fetch 去取题干里的图（算图片指纹），
         把它也算进来会得出"多问了一次模型"的假结论（实测踩过）。 */
      if (/deepseek/.test(String(u))) fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '【单选题】甲\nA. 一\nB. 二' } }] }), text: async () => '' };
    };
    try {
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'shot', maxShots: 3, autoFill: true, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot, reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', shotProbe(2), () => {});
      const text = lines.join('\n');
      assert.equal(sawProbe, true, '预检必须跑 —— 原来它被包在 if (reopenQuiz) 里，没有 reopenQuiz 就整块跳过');
      assert.match(text, /没显示出来/, '要把"题目在 DOM 里但没显示"写出来');
      assert.match(text, /不自动填、不自动保存/);
      /* 连"问模型"都不该发生：题面可能是错的，问了也只会得到对不上号的答案 */
      assert.equal(fetchCalls, 0, '抄录不可信时连答案都不该去问');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('视口压小又撑不回来：即使抄录里有题，也判"不可信"、不自动填', async () => {
  await withTmpCache(async () => {
    const ev = async (expr) => {
      const s = String(expr);
      if (/BY = .probe./.test(s)) return { ok: true, n: 2, vis: 2, probe: true, docs: 1 };
      if (/innerWidth/.test(s)) return JSON.stringify({ w: 700, h: 200 });   /* 窗口被压成一条缝 */
      if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
      if (/countQuestions/.test(s)) return 2;
      if (/scrollIntoView/.test(s)) return { ok: true, n: 2, w: 100, h: 100 };
      return null;
    };
    /* 这个 shot 没挂 setViewport —— 正是"撑不回来"的现场 */
    const shot = async () => 'ZmFrZQ==';
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (u) => {
      if (/deepseek/.test(String(u))) fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '【单选题】甲\nA. 一\nB. 二' } }] }) };
    };
    try {
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'shot', maxShots: 3, autoFill: true, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot, reopenQuiz: async () => '点了「作业作答」，页面上有 2 道题（重开成功）', clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', shotProbe(2), () => {});
      const text = assertNoFill(lines);
      assert.match(text, /没能撑回来/, '视口撑不回来这件事必须写进日志（原来它一声不吭）');
      assert.match(text, /不可信/);
      assert.equal(fetchCalls, 1, '只抄录那一次请求；因为不可信，之后不该再去问答案');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/* ============================================================================
 * 三之二、本地题库命中：**不问模型**
 * ==========================================================================*/

test('装了题库且命中：这一题不问模型，答案、可信度、"省了几次调用"都要看得见', async () => {
  await withTmpCache(async () => {
    const QS = require(path.join(__dirname, '..', 'quiz-state.js'));
    const fpr = QS.makeFingerprinter({});
    const q = { type: '单选', stem: '下列说法正确的是', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }] };
    const fp = fpr.fpOf(q);
    const bankPath = path.join(BANKDIR, 'quiz-shot-bank-' + process.pid + '.json');
    /* 库的形态按导出格式写：fp + 题干 + 选项 + 答案 + 可信度证据 */
    fs.writeFileSync(bankPath, JSON.stringify({
      version: 1, kind: '题库-导出', stats: {}, entries: {
        [fp]: {
          fp: fp, type: '单选', stem: q.stem, options: q.options, answer: 'B', answerText: '乙',
          why: '库里的理由', picked: false, n: 2,
          answers: [{ answer: 'B', answerText: '乙', why: '库里的理由', picked: false, srcs: ['import:x'], n: 2 }]
        }
      }
    }), 'utf8');
    const probe = {
      found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1, questions: [q]
    };
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) fetchCalls++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 1, vis: 1, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.equal(fetchCalls, 0, '库里有这道题 → 一次模型都不该问（这就是省下的调用）');
      /* 档位现在看**来源数**（这个样本只有一个来源 self:x）—— 所以是"单来源未确认"。
         另外命中日志现在会带**库名**（"题库·主库·单来源未确认"）—— 库管理上线后要能看出答案来自哪个库。 */
      assert.match(text, /答案（题库·主库·单来源未确认）：B/, '要打出来源是题库（含哪个库），并如实标明可信度');
      assert.match(text, /【乙】/, '带上答案对应的选项正文，方便人核对');
      assert.match(text, /本地题库命中 1 题/, '章末要报"省了几次模型调用"');
      assert.match(text, /本章没有调用模型。/, '这一章确实一次模型都没调 —— 用量那行要如实这么写');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

test('去重复之后图片指纹是**并集**，页面只算出其中一个也照样命中（这是合并埋过的坑）', async () => {
  await withTmpCache(async () => {
    const QS = require(path.join(__dirname, '..', 'quiz-state.js'));
    const fpr = QS.makeFingerprinter({});
    const q = { type: '单选', stem: '并集命中题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }] };
    const fp = fpr.fpOf(q);
    const bankPath = path.join(BANKDIR, 'quiz-shot-bank-union-' + process.pid + '.json');
    /* 库里这条带着**两个**图片指纹（去重复把两道"同题不同访问"的条目并起来了） */
    fs.writeFileSync(bankPath, JSON.stringify({
      version: 1, stats: {}, entries: {
        [fp]: {
          fp: fp, type: '单选', stem: q.stem, options: q.options, answer: 'B', answerText: '乙',
          why: '', picked: false, n: 1, imgIds: ['aaaaaaaa', 'bbbbbbbb'],
          answers: [{ answer: 'B', answerText: '乙', picked: false, srcs: ['self:x'], n: 1 }]
        }
      }
    }), 'utf8');
    /* 页面这边只算出一个（重编码过、但表里认回同一个 id） */
    const probe = { found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1, questions: [q] };
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) asked++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answers":[{"no":1,"answer":"A"}]}' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 1, vis: 1, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxPerChapter: 5,
          maxShots: 1, autoFill: false, stopAtQuiz: false, useAnswerCache: false, useBank: true, useAI: true },
        { ev: ev, shot: async () => ({ data: 'x', w: 10, h: 10 }), clickAt: async () => ({ ok: true }) }
      );
      const out = await helper.handle('并集章', probe, () => {});
      const text = (out || []).join('\n');
      assert.match(text, /答案（题库·主库·单来源未确认）：B/, '库里是两个指纹、页面只算出一个 —— 也要命中');
      assert.equal(asked, 0, '命中了就不许问模型');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

test('库里有题但**图片对不上**：不用库里的答案（怕填错题），并如实说明', async () => {
  await withTmpCache(async () => {
    const QS = require(path.join(__dirname, '..', 'quiz-state.js'));
    const fpr = QS.makeFingerprinter({});
    const q = { type: '单选', stem: '下列说法正确的是', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], imgs: ['https://p.example/now.png'] };
    const fp = fpr.fpOf(q);
    const bankPath = path.join(BANKDIR, 'quiz-shot-bank-img-' + process.pid + '.json');
    fs.writeFileSync(bankPath, JSON.stringify({
      version: 1, stats: {}, entries: {
        [fp]: {
          fp: fp, type: '单选', stem: q.stem, options: q.options, answer: 'B', answerText: '乙',
          why: '', picked: false, n: 1, images: ['https://p.example/other.png'],
          answers: [{ answer: 'B', answerText: '乙', picked: false, srcs: ['self:x'], n: 1 }]
        }
      }
    }), 'utf8');
    const probe = { found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1, questions: [q] };
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) asked++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 1, vis: 1, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.equal(asked, 1, '图片对不上 → 不用库里的答案，老老实实走原路（这条路径本来就要问模型）');
      assert.match(text, /库里有这道题，但图片对不上/, '要明说"库里有，但图不一样"，别让人以为库里没有');
      assert.doesNotMatch(text, /答案（题库/, '没有真的用库里的答案');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

/* ============================================================================
 * 二之二、截图路：**拍照之前先查库**（全命中就整章不碰 AI）
 * ==========================================================================*/

function bankFileFor(questions, answers) {
  const QS = require(path.join(__dirname, '..', 'quiz-state.js'));
  const QB = require(path.join(__dirname, '..', '题库.js'));
  const fpr = QS.makeFingerprinter({});
  const entries = {};
  questions.forEach((q, i) => {
    const fp = fpr.fpOf(q);
    const alt = QB.aliasStem(String(q.stem || ''));
    entries[fp] = {
      fp: fp, type: q.type, stem: q.stem, options: q.options, answer: answers[i],
      answerText: (q.options.filter((o) => o.letter === answers[i])[0] || {}).text || '',
      why: '', picked: false, n: 1,
      answers: [{ answer: answers[i], picked: false, srcs: ['self:x'], n: 1 }]
    };
    if (alt && alt !== String(q.stem)) entries[fp].fpAlt = fpr.fpOf({ type: q.type, stem: alt, options: q.options });
    entries[fp].fpOrder = QB.orderFreeFp(fpr, q.type, alt || String(q.stem), q.options);
  });
  const p = path.join(BANKDIR, 'quiz-shot-bank-skip-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, stats: {}, entries: entries }), 'utf8');
  return p;
}

test('选项顺序/字母变了也认得：按**正文**重新对上该点哪个选项（不按库里的字母硬填）', async () => {
  await withTmpCache(async () => {
    /* 库里：第 3 题，A=甲、B=乙，答案是 B（也就是"乙"） */
    const bankQ = { type: '单选', stem: '3\n【单选题】同一道题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: false };
    const bankPath = bankFileFor([bankQ], ['B']);
    /* 页面上：同一道题跑到第 7 题，而且选项顺序/字母换了对象 —— A=乙、B=甲。
       这时候要"按字母填"就会把甲填上去（错题）；正确做法是按正文找到"乙"那个选项，点它（这里它是 A）。 */
    const pageQ = { type: '单选', stem: '7\n【单选题】同一道题', options: [{ letter: 'A', text: '乙' }, { letter: 'B', text: '甲' }], obf: false };
    const probe = { found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1, questions: [pageQ] };
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) asked++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 1, vis: 1, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.equal(asked, 0, '顺序变了也要能靠库答，不该问模型');
      assert.match(text, /答案（题库·[^）]*）：A/, '要填**页面上**"乙"那个选项的字母（这里是 A），不是库里的 B');
      assert.match(text, /按\*\*正文\*\*重新对上/, '而且要说清这是"按正文重新对上的"，方便事后核对');
      assert.doesNotMatch(text, /：B/, '绝不能按库里那个字母 B 去填（那是错的选项）');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

test('顺序命中了、但按正文定位不到那个选项 → 不填（宁可漏，不填错）', async () => {
  await withTmpCache(async () => {
    /* 库里这条数据本身是脏的：答案是 C，可它自己的选项只有 A/B。
       "顺序无关键"仍然会命中（选项集合一致），但按正文根本换算不出 C 是哪个 —— 这种时候**不许硬填**。 */
    const bankQ = { type: '单选', stem: '3\n【单选题】同一道题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: false };
    const bankPath = bankFileFor([bankQ], ['C']);
    const pageQ = { type: '单选', stem: '7\n【单选题】同一道题', options: [{ letter: 'A', text: '乙' }, { letter: 'B', text: '甲' }], obf: false };
    const probe = { found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1, questions: [pageQ] };
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) asked++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 1, vis: 1, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.match(text, /按正文也没定位到/, '要说清"库里有、但按正文对不上"，而不是装作库里没有');
      assert.doesNotMatch(text, /答案（题库/, '没有真的用库里的答案');
      assert.equal(asked, 1, '这种情况老老实实走原路（问模型）');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

test('页面上选项正文跟库里完全不同 → 连"顺序无关键"都不命中（更不会乱填）', async () => {
  await withTmpCache(async () => {
    const bankQ = { type: '单选', stem: '3\n【单选题】同一道题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: false };
    const bankPath = bankFileFor([bankQ], ['B']);
    const pageQ = { type: '单选', stem: '7\n【单选题】同一道题', options: [{ letter: 'A', text: '丙' }, { letter: 'B', text: '丁' }], obf: false };
    const probe = { found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1, questions: [pageQ] };
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) asked++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 1, vis: 1, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.doesNotMatch(text, /答案（题库/, '选项正文都不一样了，绝不能用库里的答案');
      assert.equal(asked, 1, '走原路问模型');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

test('题号不同也认得出：库里记的是"第 3 题"、页面上是"第 7 题" → 照样走题库，不问模型', async () => {
  await withTmpCache(async () => {
    const bankQ = { type: '单选', stem: '3\n【单选题】同一道题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: false };
    const bankPath = bankFileFor([bankQ], ['B']);
    /* 页面上同一道题换到了第 7 位 */
    const pageQ = { type: '单选', stem: '7\n【单选题】同一道题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: false };
    const probe = { found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1, questions: [pageQ] };
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) asked++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 1, vis: 1, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.equal(asked, 0, '题号不一样也认得出 → 一次模型都不该问（这是"库带过去能用"的关键）');
      assert.match(text, /答案（题库·/);
      assert.match(text, /本地题库命中 1 题/);
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

/* 【为什么这两条要造"字体反爬 + 表对得上"的现场】
   截图路不是想进就能进：没有反爬的页面一律走 DOM 路（那条路本来就会查库）。
   截图路只在这三种情况出现：readMode=shot（用户选"只用截图读题"）、
   或者有反爬但表对不上。这里造的是**第一种**：用户选了截图，
   而页面上的字体跟解码表一致（fontTableMatches 用真字体的 base64 算得出 true）——
   这正是"明明能免费读、却还去截图问 AI"的那种浪费，也是这一版要省掉的目标。 */
function shotSceneQuestions() {
  return [
    { type: '单选', stem: '库里有第一题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: true },
    { type: '判断', stem: '库里有第二题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], obf: true }
  ];
}
const FONT_B64 = fs.readFileSync(path.join(__dirname, '..', '_字体', 'font-01-font-cxsecret.ttf')).toString('base64');

test('截图路 + 库里全有：不截图、不抄录、不问模型，直接把库里的答案用掉', async () => {
  await withTmpCache(async ({ out }) => {
    const qs = shotSceneQuestions();
    const bankPath = bankFileFor(qs, ['B', '错']);
    const probe = { found: 2, obfCount: 2, fontB64: FONT_B64, graded: false, docCount: 1, questions: qs };
    const realFetch = globalThis.fetch;
    let shots = 0, asked = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) asked++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 2, vis: 2, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'shot', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => { shots++; return 'ZmFrZQ=='; }, reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.equal(shots, 0, '库里全有 → 一张截图都不该拍');
      assert.equal(asked, 0, '一次模型都不该问');
      assert.match(text, /库里全有/, '日志要说清为什么没截图');
      assert.match(text, /答案（题库·/, '答案来自题库');
      assert.match(text, /本地题库命中 2 题（整章没进截图、没问模型）/, '章末要报出来');
      assert.match(text, /本章没有调用模型。/, '用量那行如实写 0 次');

      /* 写进记录的那一块要照 DOM 路的格式写：以后重建库时能读回来，指纹才接得上 */
      const rec = fs.readFileSync(out, 'utf8');
      assert.match(rec, /答案（题库·/, '记录里要留下"这题是库答的"');
      assert.match(rec, /库里有第一题/, '题干要留下来（重建库要用）');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

test('截图路 + 只命中一部分：库里有几道就先填掉，只把缺的那几道送进截图', async () => {
  await withTmpCache(async () => {
    const qs = shotSceneQuestions();
    const bankPath = bankFileFor([qs[0]], ['B']);       /* 只有第 1 道在库里 */
    const probe = { found: 2, obfCount: 2, fontB64: FONT_B64, graded: false, docCount: 1, questions: qs };
    const realFetch = globalThis.fetch;
    let shots = 0;
    globalThis.fetch = async () => { return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '1. A' } }] }), text: async () => '' }; };
    quiz.BANK_FILE = bankPath;
    try {
      const ev = async () => ({ ok: true, n: 2, vis: 2, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'shot', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => { shots++; return 'ZmFrZQ=='; }, reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.match(text, /库里已有 1 道/, '要先说清"库里那几道已经填了、不问模型"');
      assert.match(text, /剩 1 道进截图/, '只把缺的送进截图');
      assert.match(text, /题库，不问模型/, '库里那道要单独标出来');
      assert.ok(shots >= 1, '缺的那道还是要拍图问 AI（这一版只省了库里那一道）');
      assert.ok(shots <= 2, '不该把两道都拍一遍（maxShots 允许 3，但这次只需要 1 道）');
    } finally {
      globalThis.fetch = realFetch;
      try { fs.rmSync(bankPath, { force: true }); } catch (e) {}
    }
  });
});

test('只拍指定的题：grabShots 的 only 选项真的只拍那几道', async () => {
  const rects = [0, 1, 2].map((i) => ({ i: i, x: 10, y: 100 + i * 200, w: 600, h: 120, docDepth: 0 }));
  const scrolled = [];
  const clips = [];
  const ev = async (expr) => {
    const s = String(expr);
    /* 【认表达式要认"特征"，别认函数名】
       · scrollToQuestion 的表达式里**没有**这个函数名 —— 它把序号写进 `flat[1]`；
       · questionShotPlan 的表达式里有 `out.push`，而且它**也含 innerWidth**
         （第一版按 innerWidth 先判，结果把"列题目矩形"当成了"读视口"，
           返回一个字符串 → plan 变成字符串 → 计划路整段跳过、一张都拍不到）。
       所以这里的判断顺序是：先 flat[（滚题）→ 再 out.push（列矩形）→ 再视口 → 再滚动量。 */
    if (/flat\[/.test(s)) {
      const m = s.match(/flat\[(\d+)\]/);
      if (m) scrolled.push(Number(m[1]));
      return JSON.stringify({ ok: true, n: 3 });
    }
    if (/out\.push/.test(s)) return { ok: true, n: 3, rects: rects };
    if (/innerWidth/.test(s)) return JSON.stringify({ w: 1200, h: 900 });
    if (/scrollX/.test(s)) return JSON.stringify({ x: 0, y: 0 });
    if (/TiMu/.test(s)) return { ok: true, n: 3, rects: rects };
    return null;
  };
  const shot = async (o) => { clips.push(o.clip); return 'ZmFrZQ=='; };
  const out = await quiz.grabShots(ev, shot, 3, {}, { only: [1] });
  assert.equal(out.length, 1, '只拍 1 张');
  assert.deepEqual(scrolled, [1], '而且要滚到第 2 道题（index=1）那去拍');
  assert.ok(clips[0].y >= 300 - 8 && clips[0].y <= 300 + 8, 'clip 用那道题的坐标（y≈300）');
});

test('部分命中填答案：indexMap 把"第 1 条答案"换算成页面上第 3 题', async () => {
  const calls = [];
  const ev = async (expr) => {
    const s = String(expr);
    if (/probe/.test(s)) return { n: 3, vis: 3 };
    calls.push(s);
    return { ok: true, picks: [{ selected: true }] };
  };
  const msg = await quiz.fillFromText(ev, '1. A', 1, { indexMap: [2], clickAt: null });
  assert.match(msg, /第3题=A/, '答案要落到页面上第 3 题（不是第 1 题）—— 映射错了就是填错题');
});

test('部分命中填答案：模型多给的答案不填，并如实记进"跳过"', async () => {
  const ev = async () => ({ n: 3, vis: 3, ok: true, picks: [{ selected: true }] });
  const msg = await quiz.fillFromText(ev, '1. A\n2. B', 1, { indexMap: [2], clickAt: null });
  assert.match(msg, /第3题=A/);
  assert.match(msg, /多出来的答案没填/, '映射不到的答案必须记下来，不能悄悄丢');
});

/* ============================================================================
 * 三、指纹去重：前 80 字相同的两道题都要被处理
 * ==========================================================================*/

test('前 80 字相同、选项数相同的两道题：两道都要被问到（不再静默丢掉一道）', async () => {
  await withTmpCache(async () => {
    const head = '下列说法正确的是';
    const probe = {
      found: 2, obfCount: 0, fontB64: '', graded: false, docCount: 1,
      questions: [
        { type: '单选', stem: head, options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: false },
        { type: '单选', stem: head, options: [{ letter: 'A', text: '丙' }, { letter: 'B', text: '丁' }], obf: false }
      ]
    };
    const asked = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      asked.push(body.messages[body.messages.length - 1].content);
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: 'A\n理由略' } }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
        }),
        text: async () => ''
      };
    };
    try {
      const ev = async () => ({ ok: true, n: 2, vis: 2, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      assert.equal(asked.length, 2, '两道题都要问，绝不能因为指纹相同丢掉第二道');
      assert.match(asked[0], /甲/);
      assert.match(asked[1], /丙/);
      const text = lines.join('\n');
      assert.match(text, /\[1\] 单选/);
      assert.match(text, /\[2\] 单选/);
      /* 章末要有用量那一行（含模型那一步） */
      assert.match(text, /本章模型用量/);
      assert.match(text, /合计 22 token/, '两次调用的 token 要累加出来');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('真正重复的题（同一道被父子容器各抓一次）才跳过，而且跳过必须有原因', async () => {
  await withTmpCache(async () => {
    const dup = { type: '单选', stem: '同一道题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], obf: false };
    const probe = {
      found: 2, obfCount: 0, fontB64: '', graded: false, docCount: 1,
      questions: [dup, Object.assign({}, dup)]
    };
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (u) => { if (/deepseek/.test(String(u))) fetchCalls++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }), text: async () => '' }; };
    try {
      const ev = async () => ({ ok: true, n: 2, vis: 2, probe: true, docs: 1 });
      const helper = quiz.makeHelper(
        { mode: 2, apiKey: 'fake-not-a-real-key', model: 'fm', visionModel: 'fvm', readMode: 'table', maxShots: 3, autoFill: false, useAnswerCache: false, maxPerChapter: 30 },
        { ev, shot: async () => '', reopenQuiz: null, clickAt: async () => true }
      );
      const missed = [];
      const cfg = helper.mode;   /* 只是为了确保 helper 建好了 */
      const lines = await helper.handle('测验 · 假章节', probe, () => {});
      const text = lines.join('\n');
      assert.equal(fetchCalls, 1, '重复的那道不该再问一次');
      assert.match(text, /\[跳过\]/, '被跳过必须在日志里看得见');
      assert.match(text, /已经处理过这道题/, '而且要说明原因：同一章里前面已经处理过这道题');
      assert.match(text, /指纹 [0-9a-f]{8}/, '带上短指纹，方便事后核对');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/* ============================================================================
 * 四、API 超时与重试
 * ==========================================================================*/

test('超时和连接故障是两类，判据分开', () => {
  const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.equal(quiz.classifyApiFailure(abortErr), 'timeout');
  assert.equal(quiz.classifyApiFailure(new Error('API 请求超时（90 秒没响应）')), 'timeout');
  assert.equal(quiz.classifyApiFailure(new Error('socket hang up')), 'conn');
  assert.equal(quiz.classifyApiFailure(new Error('read ECONNRESET')), 'conn');
  assert.equal(quiz.classifyApiFailure(new Error('getaddrinfo EAI_AGAIN api.deepseek.com')), 'conn');
  assert.equal(quiz.classifyApiFailure(new Error('HTTP 401 鉴权失败')), 'other');
  /* 上限：超时最多再试 1 次，连接故障最多再试 2 次，而且超时那次用更大的大限 */
  assert.equal(quiz.API_RETRIES_TIMEOUT, 1);
  assert.equal(quiz.API_RETRIES_CONN, 2);
  assert.ok(quiz.API_TIMEOUT_MS_LONG > quiz.API_TIMEOUT_MS);
  assert.ok(quiz.VISION_TIMEOUT_MS >= quiz.API_TIMEOUT_MS, '抄录那条路的大限不能比普通请求还紧');
});

test('响应超时：最多发 2 次（不是无脑三遍），两次都超时就抛错', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  try {
    await assert.rejects(
      quiz.fetchWithTimeout('http://127.0.0.1:1/never', { method: 'POST' }, { timeoutMs: 5 }),
      /超时/
    );
    assert.equal(calls, 2, '超时只允许再试 1 次（最坏 2 次），绝不能重复三遍');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('连接故障：允许再试 2 次（一共 3 次），因为请求根本没送达', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('socket hang up'); };
  try {
    await assert.rejects(quiz.fetchWithTimeout('http://127.0.0.1:1/never', { method: 'POST' }), /socket hang up/);
    assert.equal(calls, 3, '连不上的情况重试 2 次是安全的（没有送达、不会被计费）');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('400/401 这类明确错误不重试（重试多少次都一样，只会白等）', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('HTTP 400 参数不合法'); };
  try {
    await assert.rejects(quiz.fetchWithTimeout('http://127.0.0.1:1/never', { method: 'POST' }), /400/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('成功时把"发了几次"带回去（重试过要能看见）', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('read ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A' } }] }) };
  };
  try {
    const r = await quiz.fetchWithTimeout('http://127.0.0.1:1/never', { method: 'POST' });
    assert.equal(r.ok, true);
    assert.equal(calls, 2, '第一次连接失败、第二次成功');
    assert.equal(r.__apiAttempts || 1, 2, '要如实带上尝试次数');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('回归：真实的配置/缓存/记录文件都没被这些测试碰过', () => {
  assert.equal(quiz.CFG_FILE, REAL_CFG);
  assert.equal(quiz.OUT_FILE, REAL_OUT);
  assert.equal(quiz.ANSWER_CACHE_FILE, REAL_CACHE);
  /* 【判据不能是"文件存在"（2026-10-11 修）】
     工作区里那份缓存是**运行期产物**：驱动器真做题时会自己创建它
     （实测 15:39:59 那次真答题就写了 答题答案缓存.json，里面有真题的答案）。
     原来的断言是"文件存在 = 测试污染"，于是**只要真跑过一轮，测试就必红**——
     测的变成"这台机器有没有跑过助手"，而不是"测试有没有污染工作区"。
     现在按 mtime 比基线：测试**碰过它**才算污染；本来就在、且没被改动的，放行。 */
  const workspaceCache = path.join(__dirname, '..', '答题答案缓存.json');
  const mtimeNow = fs.existsSync(workspaceCache) ? fs.statSync(workspaceCache).mtimeMs : 0;
  assert.equal(mtimeNow, WORKSPACE_CACHE_MTIME_AT_TEST_START,
    '这些测试把工作区的答案缓存改动了（mtime 变了）：' + workspaceCache +
    ' —— 说明有条路径绕过了 withTmpCache，那是测试污染');

  /* 【记录文件的判据】只查"**这次测试期间新增的那一段**"里有没有测试专属字符串。
     走过的两条弯路：
       ① 查全文件内容（找 `p.example`）—— 记录是运行期产物且历史上有脏块 ⇒ **必红**，红的原因还不是这次污染；
       ② 比 mtime —— **驱动器正开着的时候本来就会往这个文件里写** ✗ ⇒ 会随机红。
     现在的规矩：测试开始记下文件大小，跑完只看 `[起点, 末尾]` 这一段有没有测试专属字符串
     （`测验 · 假章节` / `p.example` / `库里的理由`）—— 驱动器写的是真题真答案，不会撞上这些词。 */
  const rec = path.join(__dirname, '..', '章节测验记录.txt');
  if (fs.existsSync(rec)) {
    const size = fs.statSync(rec).size;
    if (size > WORKSPACE_RECORD_SIZE_AT_TEST_START) {
      let fresh = '';
      try {
        const fd = fs.openSync(rec, 'r');
        const len = size - WORKSPACE_RECORD_SIZE_AT_TEST_START;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, WORKSPACE_RECORD_SIZE_AT_TEST_START);
        fs.closeSync(fd);
        fresh = buf.toString('utf8');
      } catch (e) { fresh = ''; }
      assert.doesNotMatch(fresh, /测验 · 假章节|p\.example|库里的理由/,
        '工作区的 章节测验记录.txt 在这次测试期间新增的那一段里出现了测试专属字符串 —— ' +
        '说明有条路径绕过了 withTmpCache 的 OUT_FILE 隔离（那是测试污染）：' + rec);
    }
  }
});
