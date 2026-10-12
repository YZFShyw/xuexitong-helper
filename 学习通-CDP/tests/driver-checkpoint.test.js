'use strict';

/* driver-checkpoint.js 的离线测试 + driver.js 弹窗那段的**静态**断言。
 *
 * 两部分：
 *   A. 检查点的存取与"能不能复用"的判定（纯逻辑 + 系统临时目录，不连浏览器）；
 *   B. driver.js 里 handlePopup 的"说记了就必须真的记 / 不许留不可达代码"的静态检查 ——
 *      这一条对应的是一个真实缺陷：日志声称"这一章记进待办"，但那段代码在一个
 *      无条件 return 之后，一行都执行不到，待办文件里从来没有那一行。
 *
 *     node tests/driver-checkpoint.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const chk = require('../driver-checkpoint.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chk-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

let n = 0;
function mkdir() {
  const d = path.join(TMP, 'd' + (++n));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ---------------- A. 身份与复用判定 ---------------- */

test('批次标识：只接受安全字符（它会出现在文件名里）', () => {
  assert.equal(chk.isBatchId('20261011-120000-1234-abcd'), true);
  assert.equal(chk.isBatchId('a'.repeat(64)), true);
  assert.equal(chk.isBatchId('a'.repeat(65)), false);
  assert.equal(chk.isBatchId('../../etc/passwd'), false);
  assert.equal(chk.isBatchId(''), false);
  assert.equal(chk.batchFromEnv({ DSH_BATCH: '../坏' }), '', '非法的环境变量要被忽略，由调用方重新生成');
  assert.equal(chk.batchFromEnv({ DSH_BATCH: 'ok-batch' }), 'ok-batch');
  assert.ok(chk.isBatchId(chk.newBatchId()), '新生成的批次标识必须合法');
});

test('章节身份：缺课程号/章节名/题面 → 明确报"身份不足"，不硬凑', () => {
  assert.equal(chk.chapterIdentity({ chapter: '第一章', quizFound: 3 }).ok, false);
  assert.equal(chk.chapterIdentity({ courseId: '1', quizFound: 3 }).ok, false);
  const noQuiz = chk.chapterIdentity({ courseId: '1', chapter: '第一章' });
  assert.equal(noQuiz.ok, false, '读不到题就没有题面身份，只能记待确认');
  const ok = chk.chapterIdentity({ courseId: '1', chapter: '第一章', quizFound: 3 });
  assert.equal(ok.ok, true);
  assert.match(ok.id, /^1\|/);
});

test('章节身份：题数或章节名一变，指纹就变（换题了不能被当成同一件事）', () => {
  const a = chk.chapterIdentity({ courseId: '1', chapter: '第一章', quizFound: 3 });
  const b = chk.chapterIdentity({ courseId: '1', chapter: '第一章', quizFound: 4 });
  const c = chk.chapterIdentity({ courseId: '1', chapter: '第二章', quizFound: 3 });
  const d = chk.chapterIdentity({ courseId: '2', chapter: '第一章', quizFound: 3 });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.id, d.id);
  assert.equal(chk.chapterIdentity({ courseId: '1', chapter: '第一章', quizFound: 3 }).id, a.id, '同输入必须同指纹');
});

test('复用判定：身份一致 + 页面确认平台已完成 → reuse', () => {
  const rec = { identityOk: true, identity: '1|x|n3', chapter: '第一章', quizFound: 3, verifiedResult: true };
  const d = chk.decideReuse(rec, { chapter: '第一章', quizFound: 3, platformDone: true });
  assert.equal(d.decision, 'reuse');
});

test('复用判定：只有草稿、页面没有"平台已完成" → 不许复用（草稿不是完成）', () => {
  const rec = { identityOk: true, identity: '1|x|n3', chapter: '第一章', quizFound: 3, verifiedResult: true };
  const d = chk.decideReuse(rec, { chapter: '第一章', quizFound: 3, platformDone: false });
  assert.equal(d.decision, 'uncertain');
  assert.match(d.reason, /草稿|平台已完成/);
});

test('复用判定：记录里存的是草稿结果 → 就算页面说完成也不复用这一条', () => {
  const rec = { identityOk: true, identity: '1|x|n3', chapter: '第一章', quizFound: 3, verifiedResult: false };
  assert.equal(chk.decideReuse(rec, { chapter: '第一章', quizFound: 3, platformDone: true }).decision, 'uncertain');
});

test('复用判定：题数变了 → discard（题面是新的，绝不能跳过）', () => {
  const rec = { identityOk: true, identity: '1|x|n3', chapter: '第一章', quizFound: 3, verifiedResult: true };
  assert.equal(chk.decideReuse(rec, { chapter: '第一章', quizFound: 5, platformDone: true }).decision, 'discard');
});

test('复用判定：章节名对不上 → discard；没有身份 → uncertain（不跳过）', () => {
  const rec = { identityOk: true, identity: '1|x|n3', chapter: '第一章', quizFound: 3, verifiedResult: true };
  assert.equal(chk.decideReuse(rec, { chapter: '第二章', quizFound: 3, platformDone: true }).decision, 'discard');
  assert.equal(chk.decideReuse({ chapter: '第一章', quizFilled: true }, { chapter: '第一章', quizFound: 3, platformDone: true }).decision,
    'uncertain');
});

test('复用判定：现场读不到题数（页面停在"章节"栏）→ 不许复用（没有题面证据）', () => {
  const rec = { identityOk: true, identity: '1|x|n3', chapter: '第一章', quizFound: 3, verifiedResult: true };
  const d = chk.decideReuse(rec, { chapter: '第一章', quizFound: 0, platformDone: true });
  assert.equal(d.decision, 'uncertain');
  assert.match(d.reason, /读不到题数/);
});

/* ---------------- 存取与批次 ---------------- */

test('检查点：写进去能读回来，批次不同文件不同，不存任何凭据字段', () => {
  const dir = mkdir();
  const a = chk.openCheckpoint(dir, 'batchA');
  a.set('第一章', { quizFilled: true, quizFound: 3, identity: 'x', identityOk: true });
  a.note({ startedAt: '2026-10-11T00:00:00.000Z' });
  const w = a.flush();
  assert.equal(w.ok, true, '写盘必须成功');

  const raw = fs.readFileSync(chk.checkpointFile(dir, 'batchA'), 'utf8');
  assert.equal(/apiKey|api_key|cookie|token|password/i.test(raw), false, '状态里绝不能出现凭据字样');

  const again = chk.openCheckpoint(dir, 'batchA');
  assert.equal(again.get('第一章').quizFilled, true);
  assert.equal(again.get('第一章').quizFound, 3);
  assert.notEqual(chk.checkpointFile(dir, 'batchA'), chk.checkpointFile(dir, 'batchB'));
});

test('检查点：文件坏了不抛异常，从空白开始（不许把驱动器挡在启动之外）', () => {
  const dir = mkdir();
  fs.writeFileSync(chk.checkpointFile(dir, 'bad'), '{ 这不是 JSON', 'utf8');
  let c = null;
  assert.doesNotThrow(() => { c = chk.openCheckpoint(dir, 'bad'); });
  assert.equal(c.get('第一章'), null);
  c.set('第一章', { quizFilled: true });
  assert.equal(c.flush().ok, true, '坏文件应该被自己的新内容覆盖掉');
});

test('检查点：写不进去时 errors 里有记录，不静默成功', () => {
  const dir = mkdir();
  const c = chk.openCheckpoint(dir, 'nowrite');
  c.set('第一章', { quizFilled: true });
  /* 把目标位置换成一个目录：rename 一定失败 */
  fs.mkdirSync(chk.checkpointFile(dir, 'nowrite'));
  const r = c.flush();
  assert.equal(r.ok, false);
  assert.ok(c.errors.length >= 1, '失败必须留下原因');
});

test('找可恢复的批次：只认最近、且够新的那一份', () => {
  const dir = mkdir();
  const oldF = chk.checkpointFile(dir, 'old');
  fs.writeFileSync(oldF, JSON.stringify({ batch: 'old', chapters: {} }), 'utf8');
  const oldTime = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(oldF, oldTime, oldTime);
  const newF = chk.checkpointFile(dir, 'newest');
  fs.writeFileSync(newF, JSON.stringify({ batch: 'newest', chapters: {} }), 'utf8');

  const found = chk.findRestorableBatch(dir, { currentBatch: 'cur', maxAgeMs: 6 * 3600 * 1000 });
  assert.equal(found.batch, 'newest', '48 小时前的那份太老，不能拿来挡今天的一次全新运行');

  const all = chk.findRestorableBatch(dir, { currentBatch: 'cur', maxAgeMs: 0 });
  assert.ok(all, 'maxAgeMs=0 表示不限年龄');
});

test('清理：保留最近 N 份，而且绝不删当前批次', () => {
  const dir = mkdir();
  for (let i = 0; i < 6; i++) {
    const f = chk.checkpointFile(dir, 'b' + i);
    fs.writeFileSync(f, JSON.stringify({ batch: 'b' + i, chapters: {} }), 'utf8');
    const t = new Date(Date.now() - (6 - i) * 1000);
    fs.utimesSync(f, t, t);
  }
  const r = chk.pruneCheckpoints(dir, { currentBatch: 'b0', keepBatches: 2 });
  assert.equal(fs.existsSync(chk.checkpointFile(dir, 'b0')), true, '当前批次永远不删');
  assert.equal(r.removed.includes('b0'), false);
  const left = fs.readdirSync(dir).filter((x) => x.startsWith(chk.FILE_PREFIX));
  assert.ok(left.length <= 4, '应该只剩下 keepBatches + 当前批次：' + left.join(','));
});

/* ---------------- B. driver.js 的静态检查 ---------------- */

const DRIVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'driver.js'), 'utf8');

test('handlePopup：日志声称"记进待办"，就必须真的调用记录函数', () => {
  const claims = DRIVER_SRC.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter((x) => /记进待办|记到待办|记进 待办/.test(x.line) && /log\(/.test(x.line));
  assert.ok(claims.length >= 1, '至少应有一处"记进待办"的日志');
  for (const c of claims) {
    /* 判定范围：这条日志**前后各 600 字符**内必须出现真正的落盘调用。
       为什么要这么查：以前那句日志后面跟着的是**不可达代码**里的 recordTodo，
       等于对着用户说谎（日志说记了、文件里没有）。
       允许"往前看"是因为 recordTodo 在日志之前调用、日志只是回执 ——
       "先写盘、再打印已写入"本来就是更该有的顺序。 */
    const at = DRIVER_SRC.indexOf(c.line);
    const around = DRIVER_SRC.slice(Math.max(0, at - 600), at + 600);
    assert.ok(/noteTodoOnce\(|recordTodo\(/.test(around),
      '第 ' + c.no + ' 行声称记进待办，但前后都没有真正写待办文件的调用：' + c.line.trim());
  }
});

test('handlePopup：拒绝前进/停止之前，每个 stop 出口都要先真的记待办', () => {
  const start = DRIVER_SRC.indexOf('async function handlePopup(');
  assert.ok(start > 0, 'handlePopup 必须还在');
  const body = DRIVER_SRC.slice(start, DRIVER_SRC.indexOf('\n  }\n', start));
  const stops = body.match(/return 'stop';/g) || [];
  const notes = body.match(/noteTodoOnce\(/g) || [];
  assert.ok(stops.length >= 2, 'handlePopup 里应当有多个停止出口');
  assert.ok(notes.length >= stops.length,
    'handlePopup 里 stop 出口 ' + stops.length + ' 个，但只记了 ' + notes.length + ' 次待办 —— ' +
    '日志说记了、文件里没有是最坏的一种谎，每个拒绝前进的出口都要真的落盘');
});

test('handlePopup：不许再有"无条件 return 之后的不可达代码"', () => {
  const start = DRIVER_SRC.indexOf('async function handlePopup(');
  const body = DRIVER_SRC.slice(start, DRIVER_SRC.indexOf('\n  }\n', start));
  const lines = body.split('\n');
  let brace = 0;
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    brace += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (/^(return|break|continue);?$/.test(t) && brace === 1) {
      /* 与它同层（缩进相同）的后续行里，如果还有可执行语句，那就是不可达代码 */
      const indent = lines[i].match(/^\s*/)[0];
      for (let j = i + 1; j < lines.length; j++) {
        const s = lines[j];
        if (!s.trim() || /^\s*(\/\/|\/\*|\*)/.test(s)) continue;
        const ind2 = s.match(/^\s*/)[0];
        if (ind2.length < indent.length) break;
        if (ind2.length === indent.length) {
          const code = s.trim();
          if (/^(case |default:|\}|\/)/.test(code)) break;
          findings.push('第 ~' + (i + 1) + ' 行 return 之后仍有同层代码：' + code.slice(0, 70));
          break;
        }
      }
    }
  }
  assert.deepEqual(findings, [], '发现不可达代码：\n' + findings.join('\n'));
});

test('handlePopup：不再引用已经删掉的 popupMiss 状态', () => {
  assert.equal(/popupMiss\s*[=+]{1,2}/.test(DRIVER_SRC), false,
    'popupMiss / popupMissAt 是随不可达代码一起删掉的死变量，不许再被赋值');
});

test('带图的题：记录里没有图片指纹 → 不许判"可复用"，要重读一遍', () => {
  /* 【要凑出"本来能复用"的一整套字段】decideReuse 走到底要：identity + 章节名一致 +
     题数一致 + 现场读得到题数 + 平台已完成 + 记录里存的是已验证结果。
     只给一半字段会落到 uncertain，那条断言就没意义了（第一版就栽在这儿）。 */
  const ok = {
    identityOk: true, identity: ['x'], identityWhy: '',
    chapter: '函数极限', quizFound: 10,
    verifiedResult: { saved: true }
  };
  const base = { chapter: '函数极限', quizFound: 10, platformDone: true };
  assert.equal(chk.decideReuse(ok, base).decision, 'reuse', '基本盘：全都对得上就该复用');
  const d = chk.decideReuse(ok, Object.assign({}, base, { imgNeed: true }));
  assert.equal(d.decision, 'discard', '有带图的题而记录里没图片指纹 → 重读（discard 才会清检查点）');
  assert.match(d.reason, /图片指纹/, '理由要说清是"补图片指纹"，不是"题变了"');
  /* 页面读不到图就别多跑：调用方不传 imgNeed 时要照老规矩判 */
  assert.equal(chk.decideReuse(ok, Object.assign({}, base, { imgNeed: false })).decision, 'reuse');
  assert.equal(chk.decideReuse(ok, base).decision, 'reuse', '不传 imgNeed = 老行为，一个字不变');
});

test('驱动器接线：只在"页面上真有图"时才去翻记录；读记录失败一律当作"有"（不折腾）', () => {
  assert.match(DRIVER_SRC, /async function liveQuizImgCount\(/, '要有"这一章几道题带图"的只读探针');
  assert.match(DRIVER_SRC, /imgN > 0 && !recordBlockHasImgIds\(chapter\)/, '两道闸门：页面真有图 + 记录里真没有');
  assert.match(DRIVER_SRC, /imgNeed: imgNeed/, '要把结论传给决定复用的那个函数');
  assert.match(DRIVER_SRC, /function recordBlockHasImgIds\(chapter\)/, '要能翻记录里这一章最后一块');
  assert.match(DRIVER_SRC, /catch \(e\) \{ return true; \}/, '读不出来当作"有"—— 宁可少补一次，也别每章都重读');
});
