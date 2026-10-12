'use strict';

/* 网页控制台状态/日志纯逻辑的离线测试（审查第 6、8 条）
 *
 * 覆盖：
 *   ① 正则契约 —— 每条日志正则都要对得上 driver.js / 答题助手.js 真正打出来的格式
 *      （RE.quiz 与 RE.playDone 就是这么发现对不上的）
 *   ② 空日志不能被标成「（上轮）」；跨批次的日志才标「上一轮」
 *   ③ 保存（草稿）状态：保存中 / 已保存 / 未确认 —— 且绝不当成"平台已完成"
 *   ④ 日志轮转：归档到 日志\、保留最近 N 份、**只删自己那种命名的普通文件**
 *
 * 全部离线：不连浏览器、不读用户配置、**不读用户已有日志**（日志样本全是造出来的），
 * 只有轮转测试会写文件，且只写在 os.tmpdir() 下的临时目录里。
 *     node tests/web-state.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ws = require('../web-state.js');

const BASE = path.join(__dirname, '..');

/* ===========================================================================
 * ① 正则契约
 * ========================================================================*/

/* 这几条是 driver.js 里真正写日志用的模板（从源码里 grep 出来的原样片段）。
   如果哪天 driver.js 改了日志格式，这些锚点会先在测试里报"找不到"，
   而不是等到界面上一直显示空白才被发现。 */
const ANCHORS = [
  { key: 'chapter', tpl: '──────── 章节：', file: 'driver.js' },
  { key: 'playStart', tpl: '▶ 开始播放：', file: 'driver.js' },
  { key: 'playDone', tpl: '✅ 视频播完：', file: 'driver.js' },
  { key: 'docDone', tpl: '✅ 文档阅读到底了：', file: 'driver.js' },
  { key: 'stuck', tpl: '秒没有任何进展（最后一步：', file: 'driver.js' },
  { key: 'end', tpl: '驱动器结束。', file: 'driver.js' },
  { key: 'workLeft', tpl: '个任务点没做完', file: 'driver.js' },
  { key: 'todo', tpl: '跳过：', file: 'driver.js' },
  { key: 'quiz', tpl: '──────── 测验：', file: '答题助手.js' },
  { key: 'draftSaved', tpl: '页面出现「' , file: '答题助手.js' },
  { key: 'draftUnconfirmed', tpl: '没能确认已保存', file: '答题助手.js' },
  { key: 'draftFailed', tpl: '没保存：', file: '答题助手.js' },
];

function sourceOf(f) { return fs.readFileSync(path.join(BASE, f), 'utf8'); }

/* 【没有 GBK 编码器】Node 只自带了 gb18030 的**解码**（TextDecoder），
   Buffer.from(s,'gb18030') 会直接抛 Unknown encoding —— 所以这里用
   从真实 运行日志.txt 里抓出来的一行 GBK 字节（十六进制写死），
   要的就是"字节形态"：对应
   「[2026/10/10 周六 19:23:46.78] 驱动器退出了（第 1 次）。15 秒后自动重新拉起，不用你管。 」 */
const GBK_LINE_HEX = '5b323032362f31302f313020d6dcc1f92031393a32333a34362e37385d20c7fdb6afc6f7cdcbb3f6c1cba3a8b5da203120b4cea3a9a1a3313520c3ebbaf3d7d4b6afd6d8d0c2c0adc6f0a3acb2bbd3c3c4e3b9dca1a320';
const GBK_LINE_TEXT = '[2026/10/10 周六 19:23:46.78] 驱动器退出了（第 1 次）。15 秒后自动重新拉起，不用你管。 ';
function gbkLine() { return Buffer.from(GBK_LINE_HEX, 'hex'); }

test('每条日志正则都有实现来源：模板字符串仍在产生它的文件里', () => {
  const cache = {};
  for (const a of ANCHORS) {
    if (!cache[a.file]) cache[a.file] = sourceOf(a.file);
    assert.ok(cache[a.file].includes(a.tpl),
      a.file + ' 里已经没有「' + a.tpl + '」了 —— 日志格式变了，web-state.js 的 RE.' + a.key + ' 必须跟着改');
  }
});

/* 用真实的格式实例化一遍（值都是编的，格式跟源码里的拼接方式一致）。 */
const SAMPLES = [
  ['[19:21:10] ──────── 章节：1.7 中国古代国防工程建设', 'chapter', '1.7 中国古代国防工程建设'],
  ['[19:21:10] ──────── 章节：2.1 军事思想   （上一节：1.7 中国古代国防工程建设）', 'chapter', '2.1 军事思想'],
  ['[19:21:10] ──────── 测验：1.7 中国古代国防工程建设   共 0 题', 'quiz', '1.7 中国古代国防工程建设'],
  ['[19:31:02] ──────── 测验：第三章 测验   共 12 题   （下面每道题都会读出来）', 'quiz', '第三章 测验'],
  ['[19:42:14] ✅ 视频播完：--:-- / --:--（平台已把这一章标记完成）   任务点 1/1', 'playDone', '--:--'],
  ['[19:50:00] ✅ 视频播完：12:30 / 12:30   倍速 1', 'playDone', '12:30'],
  ['[19:50:00] ✅ 视频播完：1:02:30 / 1:02:30', 'playDone', '1:02:30'],
  ['[19:44:07] ✅ 文档阅读到底了：100%   （文档）', 'docDone', '100'],
  ['[19:22:41] ⚠ 已经 91 秒没有任何进展（最后一步：换章：1.7 中国古代国防工程建设）—— 像是卡在某个等待里了。', 'stuck', '91'],
  ['[19:23:31] 驱动器结束。', 'end', null],
  ['[20:01:02] 失败: 无法读取 Edge 调试端口 9222 的页面列表：fetch failed。', 'fail', '无法读取 Edge 调试端口 9222 的页面列表：fetch failed。'],
  ['[20:01:02]   ↳ 答题助手出错：Cannot read properties of null', 'fail', '答题助手出错：Cannot read properties of null'],
  ['[20:01:02] ✗ 驱动器半路退出（退出码 1）', 'fail', '驱动器半路退出（退出码 1）'],
  ['[19:31:02] ▶ 开始播放：1.7 中国古代国防工程建设   总长 12:30   倍速 1   静音 是', 'playStart', '1.7 中国古代国防工程建设'],
  ['[19:33:02]   3:20 / 12:30   26.7%   倍速 1   rs=1.0', 'playTick', '3:20'],
  ['[19:33:02]   1:03:20 / 2:00:00   52.8%   倍速 60   rs=1.0', 'playTick', '1:03:20'],
  ['[19:44:07] 这一章还有 2 个任务点没做完（任务点一，任务点二），先不翻页', 'workLeft', '2'],
  ['[2026/10/10 周六 20:23:33]  跳过：1.7 中国古代国防工程建设   原因：这一章还有任务点没做，按 --force 点了「下一节」', 'todo', '1.7 中国古代国防工程建设'],
  ['[19:55:00]   → 已点 「暂时保存」(noSubmit())，页面出现「保存成功」（轮询 3 次，约 2 秒）', 'draftSaved', null],
  ['[19:55:00]   → 已点 「暂时保存」(noSubmit())，但（轮询 10 次，约 9 秒）内没看到平台的保存成功提示 —— **没能确认已保存**，请自己回页面看一眼草稿在不在', 'draftUnconfirmed', null],
  ['[19:57:00]   → 没保存：只找到提交类按钮，已拒绝（提交/交卷）（页面上的答案可能会丢，自己瞄一眼）', 'draftFailed', null],
  ['[19:57:30]   → 已点 「暂时保存」，但页面出现「保存失败」（轮询 6 次，约 4 秒） —— 草稿很可能没存上', 'draftUnconfirmed', null],
  ['[19:58:00]   → 调用了 saveWork()（页面函数直调，源码复核通过）但页面抛错：x is not a function —— 这次没能保存', 'draftFailed', null],
];

test('每条正则都对得上真实格式的样本行（含实测出现过的 --:--）', () => {
  for (const [line, key, expect] of SAMPLES) {
    /* 真实日志里带 [HH:MM:SS] 前缀的行，analyzeLog 是先剥掉时间戳再匹配 body 的，
       所以两种形态都得能匹配（单条正则要么自己容忍前缀，要么在 body 上匹配）。 */
    const ts = line.match(ws.RE.ts);
    const body = ts ? line.slice(ts[0].length) : line;
    const m = line.match(ws.RE[key]) || body.match(ws.RE[key]);
    assert.ok(m, 'RE.' + key + ' 匹配不到：' + line);
    if (expect !== null) assert.equal(m[1], expect, 'RE.' + key + ' 抓到的内容不对：' + line);
    assert.ok(body.match(ws.RE[key]), '剥掉时间戳之后也必须匹配：' + line);
  }
});

test('每条正则在整个样本里至少命中一行（防"死正则"）', () => {
  const keys = Object.keys(ws.RE).filter((k) => k !== 'ts');
  /* draftPending 只在页面上真的出现"正在暂存"那一瞬间才可能进日志，
     样本里没有；它单独在草稿三态那个用例里验过，这里不算缺口。 */
  const outOfSample = new Set(['draftPending']);
  const hit = {};
  for (const [line] of SAMPLES) {
    const ts = line.match(ws.RE.ts);
    const body = ts ? line.slice(ts[0].length) : line;
    for (const k of keys) if (ws.RE[k].test(line) || ws.RE[k].test(body)) hit[k] = (hit[k] || 0) + 1;
  }
  for (const k of keys) {
    if (outOfSample.has(k)) continue;
    assert.ok(hit[k] > 0, 'RE.' + k + ' 在这份样本里一条都没命中 —— 它可能已经跟实现脱节了');
  }
});

test('时间戳只认 [HH:MM:SS]，不要把外套写的日期当时间', () => {
  assert.equal('[2026/10/10 周六 20:23:33.68] 驱动器退出了'.match(ws.RE.ts), null);
  assert.equal('[19:20:10] x'.match(ws.RE.ts)[1], '19:20:10');
});

/* ===========================================================================
 * ② analyzeLog
 * ========================================================================*/

const SAMPLE_LOG = [
  '=== 学习通 CDP 驱动器 ===',
  '端口 9222   模式 驱动+翻节+跳过弹窗',
  '[19:21:10] ──────── 章节：1.7 中国古代国防工程建设',
  '[19:21:10] ──────── 测验：1.7 中国古代国防工程建设   共 0 题',
  '[19:21:10] ✅ 视频播完：--:-- / --:--（平台已把这一章标记完成）   任务点 1/1',
  '[19:22:41] ⚠ 已经 91 秒没有任何进展（最后一步：换章：1.7 中国古代国防工程建设）—— 像是卡在某个等待里了。',
  '[19:23:31] 驱动器结束。',
  '[2026/10/10 周六 20:23:33.68] 驱动器退出了（第 27 次）。15 秒后自动重新拉起，不用你管。',
  '失败: 无法读取 Edge 调试端口 9222 的页面列表：fetch failed。',
];

test('analyzeLog：章节 / 测验 / 视频完成 / 卡顿 / 收尾 / 失败 都读得出来', () => {
  const a = ws.analyzeLog(SAMPLE_LOG);
  assert.equal(a.chapter, '1.7 中国古代国防工程建设');
  assert.equal(a.quizTitle, '1.7 中国古代国防工程建设');
  assert.equal(a.quizCount, 0);
  assert.equal(a.lastChapterDone, '1.7 中国古代国防工程建设');
  assert.equal(a.video.pct, 100);
  assert.equal(a.stuckSec, 91);
  assert.equal(a.phase, '已收尾');
  assert.equal(a.lastEnd, '19:23:31');
  assert.match(a.lastFail, /fetch failed/);
  /* warns 是给界面"只看警告（卡住 / 断言失败 / 弹窗拦路）"那栏用的，
     只收 ⚠ / ✗ 开头的行 —— 「失败: …」是驱动器的顶层失败，走 lastFail。 */
  assert.equal(a.warns.length, 1);
  assert.match(a.warns[0], /91 秒没有任何进展/);
});

test('analyzeLog：✗ 行也要进警告栏', () => {
  const a = ws.analyzeLog(['[20:01:02] ✗ 驱动器半路退出（退出码 1）']);
  assert.equal(a.warns.length, 1);
  assert.match(a.lastFail, /驱动器半路退出/);
});

test('analyzeLog：共 0 题的测验不写成"遇到测验，共 0 题"这种吓人的相位', () => {
  const a = ws.analyzeLog(['[19:21:10] ──────── 章节：X', '[19:21:10] ──────── 测验：X   共 0 题']);
  const txt = ws.describeAct(a);
  assert.equal(a.phase, '', '测验行不该改写相位 —— 它不是"这一章做完了"的证据');
  assert.match(txt, /这轮没读到题/);
  assert.doesNotMatch(txt, /共 0 题/);
});

test('describeAct：有题时写出题数，且不说"平台已完成"', () => {
  const a = ws.analyzeLog(['[19:31:02] ──────── 测验：第三章   共 12 题']);
  const txt = ws.describeAct(a);
  assert.match(txt, /测验「第三章」共 12 题/);
  assert.doesNotMatch(txt, /平台/);
});

/* ===========================================================================
 * ③ 保存（草稿）状态
 * ========================================================================*/

test('草稿三态：已保存 / 保存中 / 未确认 / 没保存', () => {
  const saved = ws.analyzeLog(['[19:55:00]   → 已点 「暂时保存」(noSubmit())，页面出现「保存成功」（轮询 3 次，约 2 秒）']);
  assert.equal(saved.draft, 'saved');
  assert.equal(ws.draftTag(saved.draft), '已保存（页面回话）');

  const pending = ws.analyzeLog(['[19:55:00]   → 已点 「暂时保存」，（轮询 4 次，约 3 秒）期间看到按钮文字变成「正在暂存...」（但这只是"正在保存"，不是存好了）']);
  assert.equal(pending.draft, 'pending');
  assert.equal(ws.draftTag(pending.draft), '保存中…');

  const unconfirmed = ws.analyzeLog(['[19:56:00]   → 已点 「暂时保存」，但（轮询 10 次，约 9 秒）内没看到平台的保存成功提示 —— **没能确认已保存**，请自己回页面看一眼草稿在不在']);
  assert.equal(unconfirmed.draft, 'unconfirmed');
  assert.match(ws.draftTag(unconfirmed.draft), /未确认/);

  const failed = ws.analyzeLog(['[19:57:00]   → 没保存：只找到提交类按钮，已拒绝（提交/交卷）']);
  assert.equal(failed.draft, 'failed');
  assert.match(ws.draftTag(failed.draft), /没保存/);

  const threw = ws.analyzeLog(['[19:58:00]   → 调用了 saveWork()（页面函数直调，源码复核通过）但页面抛错：x is not a function —— 这次没能保存']);
  assert.equal(threw.draft, 'failed', '直调抛错是明确的失败，不是"未确认"');

  assert.equal(ws.draftTag(''), '');
  assert.equal(ws.draftTag('nonsense'), '');
});

test('【反例】"没保存：…"里有"保存"两个字，绝不能被读成已保存', () => {
  const a = ws.analyzeLog([
    '[19:50:00]   → 没保存：既没有「暂时保存」按钮，也调不到 noSubmit()（页面上的答案可能会丢，自己瞄一眼）',
  ]);
  assert.notEqual(a.draft, 'saved');
  assert.equal(a.draft, 'failed');
  const b = ws.analyzeLog(['[19:50:00]   → 已点 「暂时保存」，但页面出现「保存失败」（轮询 6 次，约 4 秒） —— 草稿很可能没存上']);
  assert.notEqual(b.draft, 'saved');
  assert.equal(b.draft, 'unconfirmed');
  const c = ws.analyzeLog(['[19:50:00]   → 保存出错：页面没了']);
  assert.notEqual(c.draft, 'saved', '"保存出错"同样不是证据');
});

test('"已保存"前面的行不能误判成已保存（同一章后一条覆盖前一条）', () => {
  const a = ws.analyzeLog([
    '[19:50:00]   → 已点 「暂时保存」，但（轮询 10 次，约 9 秒）内没看到平台的保存成功提示 —— **没能确认已保存**',
    '[19:52:00]   → 已点 「暂时保存」，页面出现「保存成功」',
  ]);
  assert.equal(a.draft, 'saved', '最近一次说了算');
});

test('换章要清掉上一章的测验/保存状态（不能把上一章的草稿记到这一章头上）', () => {
  const a = ws.analyzeLog([
    '[19:50:00] ──────── 章节：第一章',
    '[19:50:00] ──────── 测验：第一章   共 3 题',
    '[19:50:30]   → 已点 「暂时保存」，页面出现「保存成功」',
    '[19:55:00] ──────── 章节：第二章',
  ]);
  assert.equal(a.chapter, '第二章');
  assert.equal(a.quizTitle, '');
  assert.equal(a.quizCount, 0);
  assert.equal(a.draft, '');
});

test('日志里出现"保存"绝不等于平台把这一章标成完成', () => {
  const a = ws.analyzeLog([
    '[19:50:00] ──────── 章节：第一章',
    '[19:50:00] ──────── 测验：第一章   共 3 题',
    '[19:50:30]   → 已点 「暂时保存」，页面出现「保存成功」',
  ]);
  /* lastChapterDone 只由 driver.js 自己回报的 ✅ 行设置 */
  assert.equal(a.lastChapterDone, '', '草稿不能算"这一章完成了"');
  const txt = ws.describeAct(a);
  assert.doesNotMatch(txt, /平台已/, '只有 driver.js 的 ✅ 行才配提"平台"');
  assert.match(txt, /已保存/);
});

/* ===========================================================================
 * ④ 本次 / 上次
 * ========================================================================*/

test('空日志：不标「上轮」，也没有可显示的章节', () => {
  const v = ws.deriveLogView({ exists: false, hasContent: false, logMtimeMs: null, logName: '运行日志.txt', run: null });
  assert.equal(v.empty, true);
  assert.equal(v.stale, false, '空日志被标成"上一轮"正是审查指出的毛病');
  assert.equal(v.label, '');
});

test('有内容但属于上一批：标 stale，label=上一轮', () => {
  const run = { sessionId: 's2', log: '运行日志.txt', startedAtMs: 2000, startedAt: '本轮' };
  const v = ws.deriveLogView({ exists: true, hasContent: true, logMtimeMs: 1000, logName: '运行日志.txt', run });
  assert.equal(v.empty, false);
  assert.equal(v.stale, true);
  assert.equal(v.label, '上一轮');
  /* run.log 跟磁盘上的日志名对不上（换过名/归档过）→ 不当成本轮的，
     按时间兜底：日志比批次开始早，就是上一轮的残留。 */
  const v2 = ws.deriveLogView({ exists: true, hasContent: true, logMtimeMs: 1000, logName: '运行日志.txt', run: { sessionId: 's3', log: '运行日志-别的.txt', startedAtMs: 2000 } });
  assert.equal(v2.belongsToRun, false);
  assert.equal(v2.stale, true);
  /* 名字对不上、但日志确实比批次新（比如从别处启动过）→ 不硬说它是上一轮 */
  const v3 = ws.deriveLogView({ exists: true, hasContent: true, logMtimeMs: 3000, logName: '运行日志.txt', run: { sessionId: 's3', log: '运行日志-别的.txt', startedAtMs: 1000 } });
  assert.equal(v3.stale, false);
});

test('本批次自己写的日志：不标 stale', () => {
  const run = { sessionId: 's2', log: '运行日志.txt', startedAtMs: 1000, startedAt: '本轮' };
  const v = ws.deriveLogView({ exists: true, hasContent: true, logMtimeMs: 2000, logName: '运行日志.txt', run });
  assert.equal(v.stale, false);
  assert.equal(v.belongsToRun, true);
  assert.equal(v.label, '本轮');
});

test('没有批次记录时按时间兜底：不确定就宁可当"上一轮"（别误导成现状）', () => {
  const v = ws.deriveLogView({ exists: true, hasContent: true, logMtimeMs: 1000, logName: '运行日志.txt', run: null });
  assert.equal(v.stale, true);
  const v2 = ws.deriveLogView({ exists: true, hasContent: true, logMtimeMs: 1000, logName: '运行日志.txt', run: { startedAtMs: 0 } });
  assert.equal(v2.stale, true, '批次时间读不出来时同样当上一轮');
});

test('批次记录文件：写得出、读得回、坏 JSON 当没有', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-run-'));
  try {
    const p = path.join(dir, '本次运行.json');
    const rec = ws.makeRunRecord({ log: '运行日志.txt', logArchive: 'C:\\x\\日志\\运行日志-20261010-120000.txt' });
    assert.equal(ws.writeRunRecord(p, rec).ok, true);
    const back = ws.readRunRecord(p);
    assert.equal(back.sessionId, rec.sessionId);
    assert.equal(back.log, '运行日志.txt');
    fs.writeFileSync(p, '{坏', 'utf8');
    assert.equal(ws.readRunRecord(p), null);
    fs.writeFileSync(p, '{"v":999}', 'utf8');
    assert.equal(ws.readRunRecord(p), null, '版本不认识的当没有');
    assert.equal(ws.readRunRecord(path.join(dir, '不存在.json')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ===========================================================================
 * ⑤ 日志轮转（只写在临时目录里）
 * ========================================================================*/

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-')); }

test('开始新批次：旧运行日志被归档成带时间戳的文件（不是被删掉）', () => {
  const dir = tmp();
  try {
    const logs = path.join(dir, '日志');
    const log = path.join(dir, '运行日志.txt');
    fs.writeFileSync(log, '上一轮的日志：驱动器结束。\n', 'utf8');
    const r = ws.rotateRunLog({ logPath: log, dir: logs, keep: 5, atMs: new Date(2026, 9, 10, 12, 0, 0).getTime() });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'archived');
    assert.ok(fs.existsSync(r.archive), '归档文件要真的在');
    assert.equal(path.basename(r.archive), '运行日志-20261010-120000.txt');
    assert.equal(fs.readFileSync(r.archive, 'utf8'), '上一轮的日志：驱动器结束。\n', '内容一个字节都不能丢');
    assert.equal(fs.existsSync(log), false, '原文件挪走了，下一次跑会新建');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('空日志/没有日志：跳过，不建空归档', () => {
  const dir = tmp();
  try {
    const logs = path.join(dir, '日志');
    const log = path.join(dir, '运行日志.txt');
    const r1 = ws.rotateRunLog({ logPath: log, dir: logs, keep: 5 });
    assert.equal(r1.action, 'skipped');
    assert.match(r1.reason, /第一次跑/);
    fs.writeFileSync(log, '', 'utf8');
    const r2 = ws.rotateRunLog({ logPath: log, dir: logs, keep: 5 });
    assert.equal(r2.action, 'skipped');
    assert.match(r2.reason, /空的/);
    assert.equal(fs.existsSync(logs), false, '没什么可归档就不该建目录');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('保留份数：连续归档 6 次只留最近 3 份', () => {
  const dir = tmp();
  try {
    const logs = path.join(dir, '日志');
    const log = path.join(dir, '运行日志.txt');
    const t0 = new Date(2026, 9, 10, 12, 0, 0).getTime();
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(log, '第 ' + i + ' 轮\n', 'utf8');
      /* 每轮隔 1 小时，保证时间戳不撞 */
      const r = ws.rotateRunLog({ logPath: log, dir: logs, keep: 3, atMs: t0 + i * 3600 * 1000 });
      assert.equal(r.action, 'archived');
      assert.ok(r.kept <= 3, '每次归档后总数不超过 keep=' + 3);
    }
    const left = ws.listArchives(logs);
    assert.equal(left.length, 3);
    assert.deepEqual(left.map((f) => f.name), [
      '运行日志-20261010-170000.txt',
      '运行日志-20261010-160000.txt',
      '运行日志-20261010-150000.txt',
    ], '留下的必须是最新的三份');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('同一秒里连开两次：时间戳顺延，两次都留得住', () => {
  const dir = tmp();
  try {
    const logs = path.join(dir, '日志');
    const log = path.join(dir, '运行日志.txt');
    const at = new Date(2026, 9, 10, 12, 0, 0).getTime();
    fs.writeFileSync(log, 'A\n', 'utf8');
    const a = ws.rotateRunLog({ logPath: log, dir: logs, keep: 10, atMs: at });
    fs.writeFileSync(log, 'B\n', 'utf8');
    const b = ws.rotateRunLog({ logPath: log, dir: logs, keep: 10, atMs: at });
    assert.notEqual(a.archive, b.archive);
    assert.equal(ws.listArchives(logs).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('【安全底线】只删自己命名的普通文件：别的文件、目录、符号链接一个都不碰', () => {
  const dir = tmp();
  try {
    const logs = path.join(dir, '日志');
    fs.mkdirSync(logs, { recursive: true });
    /* 用户自己的东西 —— 名字不符合"运行日志-*.txt" */
    const keepMe = [
      path.join(logs, '我的笔记.txt'),
      path.join(logs, '运行日志-手写的.txt'),           // 后缀对但会被认成归档？—— 是归档命名，允许删
      path.join(logs, '运行日志-2026.txt.bak'),
      path.join(logs, '重要数据.json'),
    ];
    fs.writeFileSync(keepMe[0], 'x');
    fs.writeFileSync(keepMe[2], 'x');
    fs.writeFileSync(keepMe[3], 'x');
    fs.mkdirSync(path.join(logs, '运行日志-20261009-000000.txt'), { recursive: true });   // 同名目录（不在要删的 10 份里）
    /* 10 份归档，keep=1 → 删 9 份 */
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(logs, '运行日志-20261010-00' + String(i).padStart(2, '0') + '00.txt'), 'x');
    const before = fs.readdirSync(logs).length;

    const p = ws.pruneArchives(logs, 1);
    assert.equal(p.removed.length, 9);
    assert.equal(fs.existsSync(keepMe[0]), true, '我的笔记.txt 不能动');
    assert.equal(fs.existsSync(keepMe[2]), true, '运行日志-2026.txt.bak 不能动');
    assert.equal(fs.existsSync(keepMe[3]), true, '重要数据.json 不能动');
    assert.equal(fs.statSync(path.join(logs, '运行日志-20261009-000000.txt')).isDirectory(), true, '同名目录不能动');
    assert.equal(fs.readdirSync(logs).length, before - 9);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('目录不存在时轮转与清理都不抛（第一次跑就是这个状态）', () => {
  const dir = tmp();
  try {
    assert.deepEqual(ws.listArchives(path.join(dir, '根本没有这个目录')), []);
    const p = ws.pruneArchives(path.join(dir, '根本没有这个目录'), 3);
    assert.deepEqual(p.removed, []);
    /* 不存在的日志文件同样只跳过、不抛 */
    const r = ws.rotateRunLog({ logPath: path.join(dir, '也没有.txt'), dir: path.join(dir, '日志'), keep: 3 });
    assert.equal(r.action, 'skipped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('归档命名规则：只有"运行日志-*.txt"这种名字才在删的范围内', () => {
  for (const n of ['运行日志-20261010-120000.txt', '运行日志-x.txt']) assert.equal(ws.isRotatableArchiveName(n), true, n);
  for (const n of ['运行日志.txt', '运行日志-2026.txt.bak', '我的笔记.txt', '运行日志-.txt.exe',
                   '../运行日志-x.txt', '子目录\\运行日志-x.txt', '运行日志-x.TXT', '']) {
    assert.equal(ws.isRotatableArchiveName(n), false, n + ' 不该被当成可删的归档');
  }
});

/* ===========================================================================
 * ⑥ 编码
 * ========================================================================*/

test('混合编码：UTF-8 行按 UTF-8 读，GBK 行退回 gb18030', () => {
  const utf8 = Buffer.from('[19:20:10] 驱动器结束。\n', 'utf8');
  const gbk = gbkLine();
  assert.ok(gbk.toString('utf8').includes('\uFFFD'), '这段样本必须是"当 UTF-8 读会出替换字符"的，否则测不出回退逻辑');
  /* 先确认取到的字节本身确实是那句 GBK（不然测试就在自欺欺人） */
  assert.equal(new TextDecoder('gb18030').decode(gbk), GBK_LINE_TEXT);
  const lines = ws.splitLines(Buffer.concat([utf8, gbk, Buffer.from('\n', 'utf8')]));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '[19:20:10] 驱动器结束。');
  assert.equal(lines[1], GBK_LINE_TEXT, 'GBK 行必须原样还原');
});

test('splitLines：空缓冲给空数组，半行不抛', () => {
  assert.deepEqual(ws.splitLines(Buffer.alloc(0)), []);
  assert.deepEqual(ws.splitLines(null), []);
  assert.deepEqual(ws.splitLines(Buffer.from('没有换行', 'utf8')), ['没有换行']);
});

test('analyzeBuf = splitLines + analyzeLog（控制台用的就是这条链）', () => {
  const buf = Buffer.from('[19:21:10] ──────── 章节：1.7 中国古代国防工程建设\n', 'utf8');
  assert.equal(ws.analyzeBuf(buf).chapter, '1.7 中国古代国防工程建设');
  assert.equal(ws.analyzeBuf(Buffer.alloc(0)).chapter, '');
});
