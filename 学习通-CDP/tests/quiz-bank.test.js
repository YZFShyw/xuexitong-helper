/* quiz-bank.test.js —— 离线验证 题库.js（建库那一步）
 *
 * 铁律（跟本工程其它测试一致）：
 *   · 不读任何真实用户文件（章节测验记录.txt / 题库.json / 答题答案缓存.json 都不碰），
 *     全部用**写在本文件里的虚构样本**；
 *   · 不按行号断言 —— 只用子串、正则、结构、哈希；
 *   · 临时文件只写进系统临时目录，跑完删掉。
 *
 * 这里钉住的三件事，正是"错了不会报错、只会表现成库是空的"那三处：
 *   ① 指纹的输入形态（题干**原样**保留题号行与【题型】标记、选项 text 不带 "A. " 前缀）
 *   ② 金标准样本（记录里运行时自己写下的 016aad05）能逐位复现
 *   ③ 冲突答案不被静默覆盖、乱码块不入库、丢的东西全部计数
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const QB = require(path.join(ROOT, '题库.js'));

/* ---------------------------------------------------------------- 样本 */
/* 形态全部照抄记录文件里的真实排版（缩进：块头 2 / 日志行 6 / 题干 6~7 / 选项 8） */
const SAMPLE = [
  '章节测验记录',
  '====================',
  '',
  '[2026/10/11 12:54:44] 测验 · 假章节',
  '──────── 测验：测验 · 假章节   共 5 题',
  '',
  '  [1] 单选',
  '      同一道题',
  '        A. 甲',
  '        B. 乙',
  '      → 答案：A',
  '  [跳过] 单选｜同一道题｜选项2个 —— 同一章里已经处理过这道题（指纹 016aad05）',
  '',
  '  [3] 单选',
  '      同一道题',
  '        A. 甲',
  '        B. 乙',
  '      → 答案：B',                       // ← 同一指纹、答案不同：必须保留成冲突，不许覆盖
  '',
  '  [2] 单选   ⚠正文字体被混淆，下面是乱码',
  '      2',
  '       【单选题】庘庝律上肯定',
  '        A. 庣庢条庤',
  '        B. 庨庥庩庪约',
  '      → 答案：A',
  '',
  '[2026/10/11 12:55:00] 真实形态章',
  '──────── 测验：真实形态章   共 3 题',
  '',
  '  [1] 单选',
  '      → 图片 2 张：https://p.example/star3/origin/aaa.png | https://p.example/star3/origin/bbb.png',
  '      7',
  '       ',
  '       【单选题】测试题干',
  '        A. 甲',
  '        B. 乙',
  '      → 答案：B',
  '        理由：因为它对',
  '      → 已选中：B（按 aria-checked 确认过）',
  '',
  '  [2] 单选',
  '      8',
  '       【单选题】同一道题',
  '        A. 甲',
  '        B. 乙',
  '      → 答案：B',
  '      → 点了但没选中：B（aria-checked 还是 false，得手动点一下）',
  '',
  '  [3] 单选',
  '      9',
  '       【单选题】选项没字母的题',
  '        ?. 权值是指某一数字符号在数的不同位置所表示的值的大小',
  '        ?. 基数是指某一数字符号在数的不同位置所表示的值的大小',
  '      → 答案：A',
  '',
  '  [4] 单选',
  '      10',
  '       【单选题】这道理由没记下来',
  '        A. 甲',
  '        B. 乙',
  '',
  '  ──── 模型抄录（原样，未经加工）────',
  '  【多选题】以下说法正确的有（）',
  '  A. 甲说',
  '  B. 乙说',
  '  C. 丙说',
  '  D. 丁说',
  '  ',
  '  【判断题】今天不下雨',
  '  A. 对',
  '  B. 错',
  '  ──────────────────────────────────',
  '',
  '  ──── 答案（模型生成，没有验证过）────',
  '  1. AC —— 甲和丙都对',
  '  2. 错 —— 今天下雨',
  '  ────────────────────────────────────',
  ''
].join('\n');

const parsed = QB.parseRecord(SAMPLE);
const bank = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
const keys = Object.keys(bank.entries);
const findEntry = (pred) => keys.map((k) => bank.entries[k]).filter(pred);

/* ---------------------------------------------------------------- 金标准 */
test('金标准：能复现运行时写下的 016aad05（记录里那对已知输入→已知输出）', () => {
  const m = bank.stats.marks;
  assert.equal(m.total, 1, '样本里应有 1 处（指纹 xxxxxxxx）标记');
  assert.equal(m.inBank, 1, '标记里的指纹必须能在库里找到');
  assert.equal(m.sameChapter, 1, '必须在**同一章**里也能找到（弱命中不算）');
  assert.ok(keys.some((k) => k.startsWith('016aad05')),
    '库里必须有 016aad05 开头的指纹 —— 没有就说明题干/选项的组装形态错了');
});

/* ------------------------------------------------------- 指纹输入的确切形态 */
test('指纹输入形态：题干原样（含题号行与【题型】标记），选项 text 不带 "A. " 前缀', () => {
  /* 手工写死这一版负载 —— 它就是运行时看到的那串字。改坏组装，这条立刻红。 */
  const payload = 'v2\n单选\n7【单选题】测试题干\nA:甲\nB:乙';
  const want = crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
  const e = bank.entries[want];
  assert.ok(e, '按"原样题干 + 剥字母的选项"算出的指纹必须在库里（算不到 = 形态错）');
  assert.equal(e.type, '单选');
  assert.equal(e.answer, 'B');
  assert.equal(e.picked, true, '有"→ 已选中：B（按 aria-checked 确认过）"就该标成已确认');
  assert.equal(e.answerText, '乙', '答案正文要能从自己的选项里落出来');

  /* 反例（文档 3.2 那两个坑）：剥掉标记、或选项带上 "A. " 前缀，都会算出**另一个**指纹 */
  const fpr = require(path.join(ROOT, 'quiz-state.js')).makeFingerprinter({});
  const noTag = fpr.fpOf({ type: '单选', stem: '测试题干', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }] });
  const withLetter = fpr.fpOf({ type: '单选', stem: '7【单选题】测试题干', options: [{ letter: 'A', text: 'A. 甲' }, { letter: 'B', text: 'B. 乙' }] });
  assert.notEqual(noTag, want, '剥掉【题型】标记会算出另一个指纹（这正是文档里那个坑）');
  assert.notEqual(withLetter, want, '选项带上 "A. " 前缀会算出另一个指纹');
  assert.equal(bank.entries[noTag], undefined, '错形态算出来的指纹不该在库里');
});

/* ------------------------------------------------------------------ 两种格式 */
test('两种记录格式都要吃：新格式 [N] 块 + 旧格式 模型抄录 段', () => {
  const dom = parsed.questions.filter((q) => q.src === 'dom');
  const trans = parsed.questions.filter((q) => q.src === 'transcribe');
  assert.equal(dom.length, 6, '新格式应有 6 道（乱码那道不算）');
  assert.equal(trans.length, 2, '旧格式应有 2 道');
  assert.equal(bank.stats.parsedDom + bank.stats.parsedTranscribe, parsed.questions.length);

  const multi = findEntry((e) => e.type === '多选')[0];
  assert.ok(multi, '多选题要按【多选题】→"多选"归一（题型参与哈希，写成"多选题"就是另一个指纹）');
  assert.equal(multi.answer, 'AC', '旧格式答案按"题号 N ↔ 第 N 个题干"配对');
  assert.equal(multi.why, '甲和丙都对');

  const judge = findEntry((e) => e.type === '判断')[0];
  assert.ok(judge, '判断题要按【判断题】→"判断"归一');
  assert.equal(judge.answer, '错');
  assert.equal(judge.undecoded, true, '旧格式是解码能力上线前记的，要留 undecoded 标记');

  for (const e of trans.map((q) => q)) {
    assert.ok(!String(e.stem).startsWith('【'), '旧格式题干必须剥掉【题型】前缀（带着会算出另一个指纹）');
  }
});

/* -------------------------------------------------------------- 乱码/计数 */
test('乱码块不入库，但**明确计数**（静默丢弃比丢错更糟）', () => {
  assert.equal(bank.stats.excluded.garbage, 1, '⚠正文字体被混淆 的块要被排除并计数');
  assert.equal(keys.filter((k) => bank.entries[k].stem.indexOf('庘') >= 0).length, 0,
    '替身字不能进库（那是没解码的文本，运行时的指纹是解码后算的）');
  assert.equal(bank.stats.excluded.noAnswer, 1, '没答案的题要计数（照样入库，供人看）');
  assert.equal(bank.stats.parsed, bank.stats.parsedDom + bank.stats.parsedTranscribe,
    '解析总数 = 新格式 + 旧格式');
});

/* -------------------------------------------------------------- 冲突保留 */
test('同一指纹不同答案：两份都留着，不静默覆盖', () => {
  const e = findEntry((x) => x.conflict)[0];
  assert.ok(e, '样本里那道"同一道题"有 A/B 两种答案，必须被标成冲突');
  assert.equal(e.conflict, true);
  assert.equal(e.answers.length, 2, '两个答案都要留着');
  assert.deepEqual(e.answers.map((a) => a.answer).sort(), ['A', 'B']);
  /* 顶层 answer 只是"最可信的那个"，冲突明细不许被吃掉 */
  assert.ok(['A', 'B'].includes(e.answer));
});

/* ------------------------------------------------------- 点了但没选中 */
test('"点了但没选中"要如实记下来，不能当已确认', () => {
  const e = findEntry((x) => x.notPicked)[0];
  assert.ok(e, '样本里有一道"点了但没选中"的题');
  assert.equal(e.picked, false, 'aria-checked 没确认过就不能算 picked');
  assert.equal(e.notPicked, 'B');
});

/* ------------------------------------------------------- 无字母选项 */
/* 原先这里有一条"按空字母算 + 打 noLetter 标记"的用例 —— 那个语义（字母空着）
   已经被 2026-10-12 的修复取代（空字母 ⇒ 指纹对不上 ⇒ 题等于没入库）。
   现在由上面那条"字母丢了按顺序补 A/B/C/D"（自带一份 `?.` 记录、并验证别名键与页面形状相等）负责。 */

/* ------------------------------------------------------- 落盘 / 读回 */
test('落盘与读回：写出来能原样读回，不写 BOM，dry 模式不落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-test-'));
  const out = path.join(dir, '题库.json');
  try {
    const dry = QB.buildFromFile(sampleFile(dir), null);
    assert.equal(fs.existsSync(out), false, '传 null 时不许写文件');
    const written = QB.buildFromFile(sampleFile(dir), out);
    assert.equal(fs.existsSync(out), true);
    const raw = fs.readFileSync(out, 'utf8');
    assert.notEqual(raw.charCodeAt(0), 0xFEFF, '写出来不能带 BOM');
    const back = QB.parseBank(raw);
    assert.equal(Object.keys(back.entries).length, Object.keys(written.bank.entries).length,
      '读回来的条目数要跟写出去的一致');
    assert.equal(QB.parseBank('{坏掉的').entries && Object.keys(QB.parseBank('{坏掉的').entries).length, 0,
      '读坏了当空库，绝不能当命中');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleFile(dir) {
  const p = path.join(dir, '样本记录.txt');
  fs.writeFileSync(p, SAMPLE, 'utf8');
  return p;
}

/* ------------------------------------------------------- 查库（答题链路用的那个） */
test('查库：指纹 + 题型都对上才算命中；没答案的条目不算命中', () => {
  const e = findEntry((x) => x.type === '单选' && x.answer === 'B' && !x.conflict)[0];
  assert.ok(e, '样本里要有一条干净的单选答案');
  const hit = QB.lookup(bank, e.fp, '单选');
  assert.ok(hit, '指纹 + 题型一致 → 命中');
  assert.equal(hit.answer, 'B');
  assert.equal(hit.answerText, '乙', '命中时要把答案对应的选项正文一起带出来');
  assert.equal(QB.lookup(bank, e.fp, '多选'), null, '题型不一致不算命中（同一题干在单选/多选下答案是两回事）');
  assert.equal(QB.lookup(bank, 'deadbeefdeadbeefdeadbeefdeadbeef', '单选'), null, '库里没有 → 不命中');
  assert.equal(QB.lookup(null, e.fp, '单选'), null, '没有库 → 不命中，而不是抛错');
  const noAns = findEntry((x) => !x.answer)[0];
  if (noAns) assert.equal(QB.lookup(bank, noAns.fp, noAns.type), null, '没答案的条目不许算命中（否则等于白省一次调用还填不上）');
});

test('可信度分级：平台官方 > aria 确认过 > 多来源（≥2 个**不同来源**）> 单来源；冲突要额外标出来', () => {
  const conf = findEntry((x) => x.picked)[0];
  assert.equal(QB.trustOf(conf), 'confirmed', '有"已选中（aria-checked 确认过）"的就是最可信那一档');

  /* 【档位看"来源数"，不看"出现次数"】
     实测（2026-10-12）：把本地库自己导入自己一次，票数从 977 涨到 1349 ——
     因为码里带着发送方的票数 n，接收方又当自己的证据重数了一遍。n 的本意是"本地见过几次"，
     来源是谁看 srcs。现在"多来源"= srcs 里有 ≥2 个不同的来源；
     同一个来源记多少次、导入多少次，都还是"单来源"（这才是"多个来源互相印证"的本意）。 */
  /* 档位用**造出来的条目**验，别依赖样本库碰巧长什么样（第一版就是这么红了一轮） */
  const twoSrc = { answers: [{ answer: 'A', srcs: ['self:第一章'] }, { answer: 'A', srcs: ['import:别人的码'] }] };
  assert.equal(QB.trustOf(twoSrc), 'multi', '两个不同来源都这么说 → 多来源一致');
  const oneSrc = { n: 9, answers: [{ answer: 'A', srcs: ['self:同一章'] }, { answer: 'A', srcs: ['self:同一章'] }] };
  assert.equal(QB.trustOf(oneSrc), 'single', '同一个来源记了 9 次也还是单来源（次数不是来源）');
  assert.equal(QB.trustOf({ answers: [{ answer: 'A', srcs: ['self:某章'] }] }), 'single', '一个来源 → 单来源');

  const single = findEntry((x) => !x.picked && (x.answers || []).every((a) => (a.srcs || []).length <= 1) && (x.answers || []).length === 1)[0];
  if (single) assert.equal(QB.trustOf(single), 'single', '只出现一次又没确认过 → 单来源（仍可用，但要标注）');

  const c = findEntry((x) => x.conflict)[0];
  const hit = QB.lookup(bank, c.fp, c.type);
  assert.equal(hit.conflict, true);
  assert.match(hit.conflictNote, /不同答案/, '冲突命中时必须明说，不能瞒着填');
});

test('自己导入自己是幂等的：条目/冲突/票数一个都不许变（票数尤其不能刷）', () => {
  const fresh = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const code = QB.encodeCode(fresh, {});
  const d = QB.decodeCode(code);
  const once = QB.mergeBank(fresh, d.bank, { from: '题库码' });
  assert.equal(once.report.added, 0, '自己的码不该"新增"条目');
  assert.equal(once.report.conflicted, 0, '自己的码不该产生冲突');
  /* 票数：条目级和答案级都不许涨 —— 涨了就等于把一条草稿"伪装成两条证据" */
  const ks = Object.keys(fresh.entries);
  let nBefore = 0, nAfter = 0, aBefore = 0, aAfter = 0;
  ks.forEach((k) => {
    const a = fresh.entries[k], b = once.bank.entries[k];
    nBefore += (a.n || 0);
    nAfter += (b && b.n || 0);
    aBefore += (a.answers || []).reduce((x, y) => x + (y.n || 0), 0);
    aAfter += (b && (b.answers || []).reduce((x, y) => x + (y.n || 0), 0) || 0);
  });
  assert.equal(nAfter, nBefore, '条目级票数不许被自己导自己刷上去（实测踩过：977 → 1349）');
  assert.equal(aAfter, aBefore, '答案级票数同理');
  /* 第二次再导一遍：还是幂等 */
  const twice = QB.mergeBank(once.bank, d.bank, { from: '题库码' });
  const n2 = Object.keys(twice.bank.entries).reduce((x, k) => x + (twice.bank.entries[k].n || 0), 0);
  assert.equal(n2, nBefore, '导第二遍也不许动票数');
});

/* ------------------------------------------------------- 导出（脱敏 / 只导可靠的） */
test('导出：只带"题 + 答案"，课程名/章节/时间/来源标记一个都不带走', () => {
  const ex = QB.exportBank(bank, { from: 'fixture' });
  const keys = Object.keys(ex.entries);
  assert.ok(keys.length > 0);
  const raw = JSON.stringify(ex);
  assert.equal(ex.kind, '题库-导出');
  assert.doesNotMatch(raw, /测验 · 假章节|真实形态章/, '课程/章节名不许进导出文件（那是学习轨迹）');
  assert.doesNotMatch(raw, /2026\//, '记录里的时间戳不许进导出文件');
  assert.doesNotMatch(raw, /"(srcs|chapter|at)"/, '来源标记/章节/时间这三个字段名都不该出现');
  assert.equal(keys.filter((k) => !ex.entries[k].answer).length, 0, '没答案的条目不导出（别人拿了没用）');
  assert.equal(ex.stats.skippedNoAnswer >= 1, true, '跳过多少条要报出来，不能悄悄少几条');
});

test('导出默认只导"能命中页面"的条目；图片身份跟着走；抄录条目要显式开关才带', () => {
  const dom = findEntry((x) => x.type === '单选' && x.answer === 'B' && !x.conflict)[0];
  const tr = findEntry((x) => x.type === '判断')[0];
  assert.ok(dom && tr, '样本里两种来源都要有');

  const def = QB.exportBank(bank, { from: 'fixture' });
  assert.ok(def.entries[dom.fp], '页面 DOM 来源的条目要导出');
  assert.equal(def.entries[tr.fp], undefined, '抄录来源（命不中页面）默认不导出 —— 导出去只会误导别人');
  assert.equal(def.stats.skippedUnverified >= 1, true, '跳过多少条要报数');
  assert.equal(def.entries[dom.fp].hasImage, true, '图片身份要跟着导出（人不看图就不知道公式长什么样）');
  assert.deepEqual(def.entries[dom.fp].images, ['https://p.example/star3/origin/aaa.png', 'https://p.example/star3/origin/bbb.png']);

  const all = QB.exportBank(bank, { from: 'fixture', withUnverified: true });
  assert.ok(all.entries[tr.fp], '带了 --with-unverified 就一起导');
  assert.ok(Object.keys(all.entries).length > Object.keys(def.entries).length);
});

test('图片行不进指纹：拿掉了图片那行，算出来的指纹一个字节都不变', () => {
  const noImg = QB.parseRecord(SAMPLE.split('\n').filter((l) => !/→ 图片 \d+ 张/.test(l)).join('\n'));
  const b2 = QB.buildBank(noImg, { source: 'fixture', keepJunk: true });
  const a = Object.keys(bank.entries).sort().join(',');
  const b = Object.keys(b2.entries).sort().join(',');
  assert.equal(a, b, '图片行是"给人看的/给核对用的"，绝不能混进指纹 —— 混进去就等于改了所有键');
  const dom = findEntry((x) => x.type === '单选' && x.answer === 'B' && !x.conflict)[0];
  assert.equal(b2.entries[dom.fp].images, undefined, '没有图片行时不该凭空有 images');
});

/* ------------------------------------------------------- 导入（合并） */
test('导入：新题加进来、同答案合并票数、不同答案两份都留（不许覆盖）', () => {
  const inc = {
    version: QB.BANK_VERSION,
    entries: {
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { fp: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: '单选', stem: '别人给的一道新题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A', answerText: '甲', why: '别人写的理由', picked: false, n: 1 },
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { fp: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', type: '判断', stem: '别人给的判断题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: '错', n: 3 },
      'cccccccccccccccccccccccccccccccc': { fp: 'cccccccccccccccccccccccccccccccc', type: '单选', stem: '没答案的题', options: [], answer: '', n: 1 },
      /* 这条是"没有题干、也没有答案"的废条目 —— 它该算"没答案"（跳过）还是"坏条目"？
         口径变了：**没有题干不再是"坏"**（题库码就是这种形态，它只有键和答案）。
         所以现在的判据是"有没有答案"：没答案 → skippedNoAnswer；
         连对象都不是（null / 字符串）→ skippedBad。 */
      'dddddddddddddddddddddddddddddddd': { fp: 'dddddddddddddddddddddddddddddddd', type: '单选', stem: '' },
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': null
    }
  };
  const r = QB.mergeBank(bank, inc, { from: '别人的记录.txt' });
  assert.equal(r.report.added, 2, '两条新题进来');
  assert.equal(r.report.skippedNoAnswer, 2, '没答案的跳过（并计数）');
  assert.equal(r.report.skippedBad, 1, '连对象都不是的才算坏条目');
  assert.ok(r.bank.entries['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], '新题要进库');
  assert.equal(r.bank.entries['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].n, 3, '票数要带过来');

  /* 同指纹、不同答案 → 两份都留 + 标冲突 + 写来源标记 */
  const one = findEntry((x) => x.type === '单选' && x.answer === 'B' && !x.conflict)[0];
  const inc2 = { version: QB.BANK_VERSION, entries: {} };
  inc2.entries[one.fp] = { fp: one.fp, type: one.type, stem: one.stem, options: one.options, answer: 'C', n: 1 };
  const r2 = QB.mergeBank(r.bank, inc2, { from: '另一个人.txt' });
  assert.equal(r2.report.conflicted, 1, '答案不一样要算冲突，不是覆盖');
  const merged = r2.bank.entries[one.fp];
  assert.equal(merged.conflict, true);
  assert.ok(merged.answers.some((a) => a.answer === 'C'), '导入的那个答案必须留着');
  assert.ok(merged.answers.some((a) => (a.srcs || []).indexOf('import:另一个人.txt') >= 0), '来源标记要写进去（以后能按来源清理）');
});

/* --------------------------------------------- 答题链路接线契约（静态源码） */
test('接线契约：查库在"算指纹之后 / 问模型之前"，且没装库时一行都不生效', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const iFp = src.indexOf('const fpKey = fp.fpOf(q);');
  const iBank = src.indexOf('const bk = bankHitOf(q);');
  const iAsk = src.indexOf('const a = await askOne(qq, cfg);');
  assert.ok(iFp >= 0 && iBank >= 0 && iAsk >= 0, '三处锚点都要在（改了名字就同步改这里）');
  assert.ok(iFp < iBank, '先算指纹，再查库');
  assert.ok(iBank < iAsk, '查库必须在问模型**之前** —— 这是"省一次模型调用"的全部意义');
  assert.match(src, /const bankHitOf = \(q\) =>/, '要有一个统一的"三把键都试"的入口（主键 / 去题号 / 顺序无关）');
  assert.match(src, /QB\.lookup\(L\.bank, fpKey, type\)[\s\S]{0,300}altKey[\s\S]{0,300}orderKey/,
    '三把键要依次试：主键 → 去题号 → 连选项顺序都不管（跨机器、跨卷子全靠它们）');
  assert.match(src, /remapAnswerByText/, '走"顺序无关"命中时，字母不能信 —— 要按**正文**重新定位该点哪个选项');
  assert.match(src, /bankHitOf\(q\)/, '查库要把页面上的图片一起带去核对（图片对不上就不用库里的答案）');
  assert.match(src, /fs\.existsSync\(BANK_FILE\)/, '没有 题库.json 时必须走原路（要有 existsSync 守卫）');
  assert.match(src, /bankHits = 0;/, '命中数要按章清零，否则章末数字会串章');
  assert.match(src, /本地题库命中 ' \+ bankHits \+ ' 题/, '章末要把"省了几次模型调用"打出来（可验证的收益）');
  const mod = require(path.join(ROOT, '答题助手.js'));
  assert.equal(typeof mod.BANK_FILE, 'string', 'BANK_FILE 要可读（测试要把它指到临时目录）');
  assert.match(String(mod.BANK_FILE), /题库\.json$/, '生产的库文件就叫 题库.json');
});

/* --------------------------------------------- 已完成页面：读官方正确答案 */
test('已完成页面：题干对得上就挂官方答案（最高档），对不上就存着不丢，撞多道题不猜', () => {
  /* 库里那条"测试题干"（页面原文，带题号 7） */
  const one = findEntry((x) => x.type === '单选' && x.answer === 'B' && !x.conflict)[0];
  const official = 'A';                       /* 故意跟草稿答案 B 不一样：要看它敢不敢标冲突 */
  const items = [
    { stem: one.stem, correctAnswer: official, myAnswer: 'B', score: '0.0', qid: '111', url: 'x' },   /* 精确对上 */
    { stem: '9\n【单选题】选项没字母的题', correctAnswer: 'A', myAnswer: 'A', score: '10.0', qid: '222' },  /* 别名的写法 */
    { stem: '1\n【单选题】库里根本没有这道题', correctAnswer: '对', myAnswer: '错', score: '0.0', qid: '333' }, /* 对不上 */
    { stem: '', correctAnswer: 'A' },          /* 读数不对 */
    { stem: '1\n【单选题】没有答案的题', correctAnswer: '' } /* 官方答案空 */
  ];
  const r = QB.ingestGraded(bank, items, { from: 'page:测试' });
  const rep = r.report;
  assert.equal(rep.read, 5);
  assert.equal(rep.badItem, 2, '题干空 / 官方答案空 要单独计数，不能当"没对上"');
  assert.equal(rep.attached >= 1, true, '至少那条精确对上的要挂上');
  assert.equal(rep.unmatched, 1, '库里没有的那道要进 gradedUnmatched');
  assert.equal((r.bank.gradedUnmatched || []).length, 1);
  assert.equal(r.bank.gradedUnmatched[0].qid, '333', 'qid 要留着（以后能按 id 挂，不依赖题干）');
  assert.equal(r.bank.gradedUnmatched[0].answer, '对');

  const e = r.bank.entries[one.fp];
  assert.equal(e.official, true, '平台正确答案是最可信那一档');
  assert.equal(QB.trustOf(e), 'official');
  assert.equal(e.answer, 'A', '官方答案要盖过草稿答案当默认值');
  assert.equal(e.conflict, true, '**官方和草稿不一样 → 冲突照样留着**，不许静默覆盖');
  assert.ok(e.answers.some((a) => a.answer === 'B'), '原来那条草稿答案必须还在');
  assert.ok(e.answers.some((a) => a.answer === 'A' && a.official), '官方那条要带 official 标记');
  assert.match(QB.lookup(r.bank, one.fp, '单选').trustLabel, /平台正确答案/);

  /* 官方答案也要能跟着"脱敏导出"走 */
  const ex = QB.exportBank(r.bank, { from: 'x' });
  assert.equal(ex.entries[one.fp].official, true);
  assert.ok(ex.entries[one.fp].answers.some((a) => a.official));
});

test('已完成页面：撞多道题（同一题干在库里有两条）时宁可不挂，并计数', () => {
  const K1 = 'e'.repeat(32), K2 = 'f'.repeat(32);
  const dup = {
    version: QB.BANK_VERSION, entries: {
      [K1]: { fp: K1, type: '判断', stem: '5【判断题】这句话是对的', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: '对', n: 1 },
      [K2]: { fp: K2, type: '判断', stem: '5【判断题】这句话是对的', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: '错', n: 1 }
    }
  };
  const r = QB.ingestGraded(dup, [{ stem: '5【判断题】这句话是对的', correctAnswer: '对', myAnswer: '对', score: '10' }], { from: 'page:x' });
  assert.equal(r.report.ambiguous, 1, '撞两道就报歧义');
  assert.equal(r.report.attached, 0, '歧义时一条都不挂（宁可不挂，也别挂错）');
  assert.equal(r.bank.entries[K1].official, undefined);
});

test('答案行上的注解要剥掉再解析（库答/缓存答写进记录时带来源注解）', () => {
  const rec = [
    '章节测验记录', '', '[2026/10/12 1:00:00] 测验 · 注解',
    '──────── 测验：注解   共 2 题', '',
    '  [1] 单选', '      1', '       【单选题】注解一', '        A. 甲', '        B. 乙',
    '      → 答案（题库·aria 确认过）：B　【乙】', '',
    '  [2] 单选', '      2', '       【单选题】注解二', '        A. 甲', '        B. 乙',
    '      → 答案（缓存）：A', ''
  ].join('\n');
  const p = QB.parseRecord(rec);
  assert.equal(p.questions.length, 2);
  assert.equal(p.questions[0].answer, 'B', '"（题库·…）"那种注解必须剥掉 —— 不然答出来的字是 "B【乙】"，整条被当成不可用丢掉');
  assert.equal(p.questions[1].answer, 'A', '"（缓存）"同理');
});

test('题号不同的同一道题：用的是"去掉题号"的别名键（导出/导入都要带着它）', () => {
  const QS = require(path.join(ROOT, 'quiz-state.js'));
  const fpr = QS.makeFingerprinter({});
  /* 【用一份**新建**的库】别用文件顶部那个共享的 bank ——
     ingestGraded / mergeBank 那两条用例会改动它（官方答案会顶掉草稿答案），
     接着按"答案是 B"去找就会选到别的条目（实测在这条用例上踩到过），
     那是测试之间的相互污染，不是产品行为。 */
  const fresh = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const e = Object.keys(fresh.entries).map((k) => fresh.entries[k]).filter((x) => /测试题干/.test(String(x.stem)))[0];
  assert.ok(e, '样本里要有那道"测试题干"');
  assert.ok(e.fpAlt, '题干带题号的条目，建库时要同时算一把"去掉题号与题型标记"的别名键');
  const alt = fpr.fpOf({ type: e.type, stem: QB.aliasStem(e.stem), options: e.options });
  assert.equal(alt, e.fpAlt, '别名键的算法必须与建库端**同一个函数**，两边不一致就等于没做');

  /* 同一道题换到别的位置（题号变了）：主键必然不同，别名键相同 */
  const page = { type: e.type, stem: String(e.stem).replace(/^7/, '3'), options: e.options };
  assert.notEqual(fpr.fpOf(page), e.fp, '题号是页面文字的一部分 → 主键必然不同');
  assert.equal(fpr.fpOf({ type: page.type, stem: QB.aliasStem(page.stem), options: page.options }), alt,
    '别名键必须相同 —— 这就是"换个编号也认得出"的依据');

  const loaded = QB.parseBank(QB.serializeBank(fresh));
  assert.ok(Object.keys(loaded.alias).length >= 1, '读回来时要建好别名索引');
  const hit = QB.lookup(loaded, alt, e.type);
  assert.ok(hit, '换了题号的同一道题要能查到');
  assert.equal(hit.viaAlias, true, '而且要如实标出"这是走别名键查到的"');
  assert.equal(hit.answer, e.answer);

  const ex = QB.exportBank(fresh, { from: 'f' });
  assert.ok(ex.entries[e.fp], '这道题是页面 DOM 来源，要能导出');
  assert.equal(ex.entries[e.fp].fpAlt, e.fpAlt, '别名键要跟着导出 —— 不带它，换台机器就又查不中了');
});

test('选项顺序/字母变了 → 两把键都不命中：宁可漏，也绝不按字母填错', () => {
  const QS = require(path.join(ROOT, 'quiz-state.js'));
  const fpr = QS.makeFingerprinter({});
  const fresh = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const e = Object.keys(fresh.entries).map((k) => fresh.entries[k]).filter((x) => /测试题干/.test(String(x.stem)))[0];
  const loaded = QB.parseBank(QB.serializeBank(fresh));
  const altOf = (q) => fpr.fpOf({ type: q.type, stem: QB.aliasStem(String(q.stem)), options: q.options });

  /* 【最危险的那种改法：顺序没动、字母换了对象】
     库里记的是 A=甲、B=乙，答案是 B；页面上变成 A=乙、B=甲。
     这时候要是"认字母"地填，就会把甲填上去 —— 错题。
     指纹（含选项正文）在这儿就是那道闸门：算出来的键跟库里任何一个都不一样 → 不命中 → 不填。 */
  const swapped = { type: e.type, stem: e.stem, options: [{ letter: 'A', text: '乙' }, { letter: 'B', text: '甲' }] };
  assert.notEqual(fpr.fpOf(swapped), e.fp, '选项变了 → 主键必须不同');
  assert.equal(QB.lookup(loaded, fpr.fpOf(swapped), e.type), null, '主键不命中');
  assert.equal(QB.lookup(loaded, altOf(swapped), e.type), null,
    '别名键（去题号）**带着选项**，所以一样不命中 —— 这道闸门不能拆');

  /* 顺序颠倒也算变（同一把闸门） */
  const reordered = { type: e.type, stem: e.stem, options: [e.options[1], e.options[0]] };
  assert.equal(QB.lookup(loaded, fpr.fpOf(reordered), e.type), null, '顺序颠倒同样不命中');
});

test('别名键撞车（两条不同题目的别名一样）→ 两侧都不建：宁可查不中，别挂到错题上', () => {
  const alt = 'a'.repeat(32);
  const bankX = QB.parseBank(JSON.stringify({
    version: 1,
    entries: {
      ['1'.repeat(32)]: { fp: '1'.repeat(32), type: '单选', stem: '题一', options: [], answer: 'A', fpAlt: alt },
      ['2'.repeat(32)]: { fp: '2'.repeat(32), type: '单选', stem: '题二', options: [], answer: 'B', fpAlt: alt }
    }
  }));
  assert.equal(Object.keys(bankX.alias).length, 0, '抢同一个别名键 → 整条不用');
  assert.equal(QB.lookup(bankX, alt, '单选'), null);
});

/* ------------------------------------------------------- 题库码（控制台粘贴用） */
test('题库码：编 → 解 一圈回来还是那些答案；题面/课程名一个字都不带', () => {
  const fresh = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const code = QB.encodeCode(fresh, {});
  assert.match(code, /^TIKU1:/, '码要带可识别的前缀');
  assert.doesNotMatch(code, /[\s]/, '码里不该有空白（复制粘贴会带换行，解码端会去掉）');
  const d = QB.decodeCode(code);
  assert.equal(d.ok, true, '自己编的码要能解回来');
  assert.ok(d.entries >= 1);
  const raw = JSON.stringify(d.bank.entries);
  assert.doesNotMatch(raw, /测试题干|同一道题|假章节|真实形态章/, '码里不许有题干原文（题面有版权）');
  assert.doesNotMatch(raw, /"stem"|"options"|"chapter"|"at"/, '也不许有选项全文/章节/时间这些字段');
  /* 答案本身要在，而且可信度要跟着走 */
  const ks = Object.keys(d.bank.entries);
  assert.ok(d.bank.entries[ks[0]].answer, '答案必须在');
  assert.ok(d.bank.entries[ks[0]].fpOrder, '三把键要跟着走 —— 不带就等于让别人只能命中"题号+顺序都一模一样"的题');
});

test('题库码：坏码要说清坏在哪一步，绝不半信半疑地用一半', () => {
  assert.equal(QB.decodeCode('').ok, false);
  assert.match(QB.decodeCode('随便一段话').error, /不像题库码/);
  assert.match(QB.decodeCode('TIKU1:@@@@不是base64').error, /读不出来|解压失败/);
  const good = QB.encodeCode(QB.buildBank(parsed, { source: 'f', keepJunk: true }), {});
  assert.match(QB.decodeCode(good.slice(0, good.length - 20)).error, /解压失败/, '被截断的码要认出来（复制漏尾巴最常见）');
});

test('题库码灌进空库之后，只有键和答案的条目也能用（键唯一就能查，撞键就不查）', () => {
  const fresh = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const d = QB.decodeCode(QB.encodeCode(fresh, {}));
  const loaded = QB.parseBank(QB.serializeBank(d.bank));
  assert.equal(Object.keys(loaded.entries).length, d.entries, '没有题干的条目也要能被 parseBank 收进来（不然码等于白贴）');

  /* 找一把"唯一"的键来查（有些条目共用同一把顺序无关键 —— 那是同一道题的两种题号，
     这种**故意不建立索引**，见下一条断言）。 */
  const ks = Object.keys(loaded.entries);
  const orderCount = {};
  ks.forEach((k) => { const od = loaded.entries[k].fpOrder; if (od) orderCount[od] = (orderCount[od] || 0) + 1; });
  const uniq = ks.filter((k) => loaded.entries[k].fpOrder && orderCount[loaded.entries[k].fpOrder] === 1)[0];
  assert.ok(uniq, '样本里要有"键唯一"的条目');
  const e = loaded.entries[uniq];
  const hit = QB.lookup(loaded, e.fpOrder, e.type);
  assert.ok(hit, '拿码里的键去查要能查到');
  assert.equal(hit.answer, e.answer);
  assert.equal(e.stem, undefined, '确认这条确实没有题干（就是"只有键 + 答案"的形态）');

  /* 两把键撞车（同一道题的不同题号）→ 故意不建索引：宁可查不中，也不挂错 */
  const dup = ks.filter((k) => loaded.entries[k].fpOrder && orderCount[loaded.entries[k].fpOrder] > 1)[0];
  assert.ok(dup, '样本里要有"共用同一把顺序无关键"的条目');
  assert.equal(QB.lookup(loaded, loaded.entries[dup].fpOrder, loaded.entries[dup].type), null,
    '撞键的条目不该被索引（这是护栏，不是 bug）');
});

test('网页控制台契约：有「题库」那一栏、有 /api/bank，而且编解码只走 题库.js（不在控制台另写一套）', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(src, /require\('\.\/题库\.js'\)/, '控制台要能用到题库模块');
  assert.match(src, /u\.pathname === '\/api\/bank'/, '要有 /api/bank 入口（GET 看规模、POST 导入/导出码）');
  assert.match(src, /function bankImportCode\(/, '导入码要有独立函数');
  assert.match(src, /function bankMakeCode\(/, '导出码要有独立函数');
  assert.match(src, /<section><h2>题库/, '页面上要有「题库」那一栏');
  assert.match(src, /onclick="bankAdd\(\)"/, '要有「添加题库码」按钮');
  assert.match(src, /function bankAdd\(\)/, '页面里要有对应的前端函数');
  assert.match(src, /QBANK\.decodeCode\(/, '解码要走题库.js（不许在控制台里重写一套）');
  assert.match(src, /QBANK\.encodeCode\(/, '编码也一样');
  assert.match(src, /QBANK\.mergeBank\(/, '合并也一样 —— 冲突"两份都留"的口径只能有一个');
  assert.match(src, /QBANK\.serializeBank\(/, '写回也要用题库.js 的序列化');
});

/* ------------------------------- 题库码 / 导入的坏输入（法师问的"乱码会不会影响以后"） ------------------------------- */

test('导入：一段好码**真的能落地**（没有题干的形态也要收 —— 这里原来有个 bug：一条都进不来）', () => {
  const fresh = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const code = QB.encodeCode(fresh, {});
  const d = QB.decodeCode(code);
  assert.ok(d.entries >= 1);
  /* 落到空库上 */
  const empty = QB.parseBank('');
  const m = QB.mergeBank(empty, d.bank, { from: '题库码' });
  assert.equal(m.report.added, d.entries, '码里每一条都要进库（**这条断言就是为那个"要求必须有题干"的 bug 写的**）');
  assert.equal(m.report.skippedBad, 0, '不该有"坏条目"');
  const loaded = QB.parseBank(QB.serializeBank(m.bank));
  assert.equal(Object.keys(loaded.entries).length, d.entries, '写盘再读回来还在（说明序列化也没把它弄丢）');
});

test('导入坏码：一条都不写进库（前缀错 / 截断 / 纯乱码，三种都要挡住）', () => {
  const before = JSON.stringify(parsed.questions.length);      /* 记录解析结果不受影响 */
  const base = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const n0 = Object.keys(base.entries).length;
  const bads = ['', '乱码乱码乱码', 'TIKU1:@@@', QB.encodeCode(base, {}).slice(0, 60)];
  for (const bad of bads) {
    const d = QB.decodeCode(bad);
    assert.equal(d.ok, false, '坏输入必须被判失败：' + JSON.stringify(String(bad).slice(0, 20)));
    /* 失败时 decodeCode 不返回 bank —— 调用方（控制台/命令行）就是靠这个"整段放弃"的 */
    assert.equal(d.bank, undefined, '失败时不许给出半个库');
  }
  assert.equal(Object.keys(base.entries).length, n0, '本地库没被动过');
  assert.equal(JSON.stringify(parsed.questions.length), before);
});

test('导入乱码不会影响**以后**认码：解压坏了就整段不认（gzip 的 CRC 是总闸），能解压的才逐条校验', () => {
  const base = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const good = QB.encodeCode(base, {});
  /* 把码中间改一个字符：base64 是"宽松"解码（非法字符会被丢掉），
     所以这里真正兜底的是 gzip 自己的校验和 —— 它坏了就绝对解不出来。 */
  const mid = Math.floor(good.length / 2);
  const tampered = good.slice(0, mid) + (good[mid] === 'A' ? 'B' : 'A') + good.slice(mid + 1);
  const d = QB.decodeCode(tampered);
  assert.equal(d.ok, false, '中间被改一个字符 → 整段不认（不会"解出半份"混进库）');
  /* 而同一段码紧接着再解一次，照样没问题 —— 坏输入不留后遗症 */
  const again = QB.decodeCode(good);
  assert.equal(again.ok, true, '紧接着解一段好码，必须照常认得出来（坏输入不污染后续）');
  assert.equal(again.entries, QB.decodeCode(good).entries);
});

test('同一个码贴两次：不会长出重复条目，只把票数加一（合并是幂等的）', () => {
  const fresh = QB.buildBank(parsed, { source: 'fixture', keepJunk: true });
  const d = QB.decodeCode(QB.encodeCode(fresh, {}));
  const empty = QB.parseBank('');
  const once = QB.mergeBank(empty, d.bank, { from: '题库码' });
  const n1 = Object.keys(once.bank.entries).length;
  const twice = QB.mergeBank(once.bank, d.bank, { from: '题库码' });
  assert.equal(Object.keys(twice.bank.entries).length, n1, '条目数不变');
  assert.equal(twice.report.added, 0, '第二次一条都不该"新增"');
  assert.equal(twice.report.merged, n1, '全都走合并');
  assert.equal(twice.report.conflicted, 0, '同样答案不该算冲突');
});

test('别人给的码顶不掉平台官方答案（即使他那份票数更多）—— 这条是导入的安全底线', () => {
  const fp = 'f'.repeat(32);
  const base = QB.parseBank(JSON.stringify({
    version: 1,
    entries: {
      [fp]: {
        fp: fp, type: '单选', stem: '一道题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
        answer: 'A', answerText: '甲', official: true, picked: true, n: 1,
        answers: [{ answer: 'A', answerText: '甲', picked: true, official: true, srcs: ['graded'], n: 1 }]
      }
    }
  }));
  const inc = { version: 1, entries: {} };
  inc.entries[fp] = { fp: fp, type: '单选', answer: 'B', answerText: '乙', n: 99 };   /* 别人票数很高，但只是草稿 */
  const r = QB.mergeBank(base, inc, { from: '别人给的码' });
  const e = r.bank.entries[fp];
  assert.equal(e.answer, 'A', '官方答案必须还是默认答案（票数多不等于对）');
  assert.equal(e.conflict, true, '但两说都要留着 —— 冲突本身是信息');
  assert.equal(e.answers.length, 2, '两条候选都在');
  assert.equal(r.report.conflicted, 1);
});

test('库里真有垃圾条目 → 顶多是"那把键退化"，绝不会被填错', () => {
  const fpA = '1'.repeat(32), fpB = '2'.repeat(32), alt = '3'.repeat(32);
  const junk = QB.parseBank(JSON.stringify({
    version: 1,
    entries: {
      [fpA]: { fp: fpA, type: '单选', stem: '正常题', options: [{ letter: 'A', text: '甲' }], answer: 'A', fpAlt: alt, answers: [{ answer: 'A', srcs: ['self:x'], n: 1 }] },
      [fpB]: { fp: fpB, type: '单选', stem: '垃圾题', options: [{ letter: 'A', text: '乙' }], answer: 'B', fpAlt: alt, answers: [{ answer: 'B', srcs: ['self:x'], n: 1 }] }
    }
  }));
  assert.equal(QB.lookup(junk, alt, '单选'), null, '撞键 → 那把键不建立索引（查不中，但也不会指到错题）');
  assert.ok(QB.lookup(junk, fpA, '单选'), '主键照常能查到 —— 垃圾只影响它自己抢的那把别名键');
  assert.equal(QB.lookup(junk, fpA, '判断'), null, '题型也对不上就查不到');
});

/* ------------------------------------------------------- 一键去重复 */
test('去重复：同题不同题号 → 并成一条，旧键留着当别名（以前查得到的照样查得到）', () => {
  const QS = require(path.join(ROOT, 'quiz-state.js'));
  const fpr = QS.makeFingerprinter({});
  const opt = [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }];
  const mk = (no, ans) => {
    const q = { type: '单选', stem: no + '\n【单选题】重复题', options: opt, answer: ans, picked: false, chapter: 'x', at: '' };
    return { q: q, fp: fpr.fpOf({ type: q.type, stem: q.stem, options: opt }) };
  };
  const a = mk('3', 'B'), b = mk('7', 'B'), c = mk('9', 'A');
  const rec = ['章节测验记录', '', '[2026/10/12 14:00:00] 测验 · 重复题', '──────── 测验：重复题   共 3 题', ''];
  [a, b, c].forEach((x, i) => {
    rec.push('  [' + (i + 1) + '] 单选', '      ' + x.q.stem.split('\n')[0], '       【单选题】重复题',
      '        A. 甲', '        B. 乙', '      → 答案：' + x.q.answer, '');
  });
  const bank = QB.buildBank(QB.parseRecord(rec.join('\n')), { source: 't' });
  assert.equal(Object.keys(bank.entries).length, 3, '先确认它真的被记成了三条（题号不同 → 主键不同）');
  const d = QB.dedupeBank(bank, {});
  assert.equal(Object.keys(d.bank.entries).length, 1, '三条并成一条');
  assert.equal(d.report.merged, 2);
  assert.equal(d.report.groups, 1);
  assert.equal(d.report.aliasesKept, 2, '两条被并掉的主键都要留成别名');
  /* 并完之后：三条老键**都要能查到**，而且拿到的都是同一条 */
  const loaded = QB.parseBank(QB.serializeBank(d.bank));
  [a, b, c].forEach((x) => {
    const hit = QB.lookup(loaded, x.fp, '单选');
    assert.ok(hit, '老键 ' + x.fp.slice(0, 8) + ' 并完还要能查到');
    assert.equal(hit.entry.fp, Object.keys(d.bank.entries)[0], '都指向同一条');
  });
  /* 答案一份不丢：两条 B（票数并起来 = 2）+ 一条 A 都在；默认答案按"票数多的那个" */
  const keep = d.bank.entries[Object.keys(d.bank.entries)[0]];
  assert.equal(keep.answers.length, 2, '两个不同答案都留着（不许覆盖）');
  assert.equal(keep.answer, 'B', '默认答案是票数多的那个（官方/aria 优先的规则在 ingestGraded 那边，不在记录里）');
  assert.equal(keep.conflict, true, '两个答案并存 → 标冲突');
  assert.equal(keep.answers.filter((x) => x.answer === 'B')[0].n, 2, 'B 的票数并起来了');
  assert.equal(keep.answers.filter((x) => x.answer === 'A')[0].n, 1, 'A 也在，票数没被吃');
});

test('去重复：没有"顺序无关键"的老条目不并（宁可留着，也别合错）', () => {
  const bank = QB.parseBank(JSON.stringify({
    version: 1,
    entries: {
      ['1'.repeat(32)]: { fp: '1'.repeat(32), type: '单选', stem: '甲题', options: [], answer: 'A' },
      ['2'.repeat(32)]: { fp: '2'.repeat(32), type: '单选', stem: '乙题', options: [], answer: 'B' }
    }
  }));
  const d = QB.dedupeBank(bank, {});
  assert.equal(d.report.merged, 0);
  assert.equal(Object.keys(d.bank.entries).length, 2, '没有判据就不动');
});

test('自动入库：记录比库新 → 运行时自己重建一次（带防抖 + **按课程分流**）', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /const bankAutoRebuild = \(\) => \{/, '要有自动重建那一步');
  assert.match(src, /QB\.buildSplitFromFile\(rec, \{\}\)/, '按课程分流地建库（不是一个大库）');
  assert.match(src, /QB\.libNameOf\(courseName\) \+ '\.json'/, '课程库文件名 = 规范化后的课程名（同名只认一个库）');
  assert.match(src, /preserveSources: true/, '记录→课程库 是"同一个来源搬家"，不许凭空多出一个来源');
  assert.match(src, /QB\.serializeBank\(sp\.main\)/, '没有课程名的老条目仍旧进主库（不迁移）');
  assert.match(src, /bankAt >= recAt/, '库不比记录旧就不重建');
  assert.match(src, /BANK_REBUILD_GAP_MS/, '要有防抖：不然每答完一章就重建一次（每次 1~2 秒）');
  assert.match(src, /catch \(e\) \{\s*return '';/, '重建失败就退回用旧库，绝不打断答题');
  const iRebuild = src.indexOf('const note = bankAutoRebuild();');
  const iList = src.indexOf('const all = QB.listBanks(');
  assert.ok(iRebuild >= 0 && iList > iRebuild, '先重建主库，再列所有库（不然列到的是旧库）');
});

test('按课程分库：课程名规范化（同名不会变成两个库）+ 按课程拆分 + 从记录分流建库', () => {
  const fsx = require('fs'), osx = require('os');
  /* 规范化：空白/大小写/危险字符 —— 法师明确要求"不要起相同同名库" */
  assert.equal(QB.libNameOf(' 军事理论 '), '军事理论', '首尾空白要吃掉');
  assert.equal(QB.libNameOf('军事理论\u3000'), '军事理论', '全角空格也要吃掉');
  assert.equal(QB.libNameOf('高等数学/上册'), '高等数学_上册', '路径分隔符换成下划线（不然会写到目录外面）');
  assert.equal(QB.libNameOf('军事理论...'), '军事理论', '结尾的点和空格在 Windows 上会出问题');
  assert.equal(QB.libNameOf(''), '', '空课程名 → 交给主库');
  assert.equal(QB.libNameOf('a'.repeat(200)).length <= 60, true, '太长的名字要截断');

  const rec = ['章节测验记录', '',
    '[2026/10/12 14:00:00] 1.7 中国古代国防工程建设', '课程：军事理论', '──────── 测验：1.7   共 1 题', '',
    '  [1] 单选', '      甲题', '        A. 一', '        B. 二', '      → 答案：B', '',
    '[2026/10/12 14:05:00] 2.1 极限的定义', '课程：高等数学', '──────── 测验：2.1   共 1 题', '',
    '  [1] 单选', '      乙题', '        A. 一', '        B. 二', '      → 答案：A', '',
    '[2026/10/12 14:09:00] 没写课程名的一章', '──────── 测验：X   共 1 题', '',
    '  [1] 单选', '      丙题', '        A. 一', '        B. 二', '      → 答案：A', ''].join('\r\n');
  const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'bank-split-'));
  try {
    const p = path.join(dir, '记录.txt');
    fsx.writeFileSync(p, rec, 'utf8');
    const parsed = QB.parseRecord(rec);
    assert.deepEqual(parsed.questions.map((q) => q.course), ['军事理论', '高等数学', ''], '每道题都要记住自己的课程');
    const sp = QB.buildSplitFromFile(p, {});
    assert.equal(Object.keys(sp.libs).length, 2, '两个课程库');
    assert.equal(Object.keys(sp.libs['军事理论'].entries).length, 1);
    assert.equal(Object.keys(sp.libs['高等数学'].entries).length, 1);
    assert.equal(Object.keys(sp.main.entries).length, 1, '没课程名的那道题进主库（老记录不迁移）');
  } finally {
    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('记录→课程库 的合并：来源不许凭空多一个（不然"单来源"秒变"多来源"）', () => {
  const mk = (ans, srcs) => ({
    fp: 'a'.repeat(32), type: '单选', stem: '甲', options: [], answer: ans,
    answers: [{ answer: ans, srcs: srcs.slice(), n: 1 }], n: 1
  });
  /* 【每次都要造一份新的 base】mergeBank 是**原地改 base** 的（它把 base 当 out 用），
     第一版我拿同一个 cur 连跑两次，第一次已经把来源写进去了，第二次断言就"看见"了那一个 —— 白红一轮。 */
  const baseOf = () => QB.parseBank(JSON.stringify({ version: 1, entries: { ['a'.repeat(32)]: mk('A', ['self:某章']) } }));
  const incOf = () => QB.parseBank(JSON.stringify({ version: 1, entries: { ['a'.repeat(32)]: mk('A', ['self:某章']) } }));
  /* 普通导入（别人的码）：来源多一个 → 档位可以升到"多来源" */
  const m1 = QB.mergeBank(baseOf(), incOf(), { from: '题库码' });
  assert.deepEqual(m1.bank.entries['a'.repeat(32)].answers[0].srcs, ['self:某章', 'import:题库码']);
  /* 搬家（记录 → 课程库）：来源**不许**变 */
  const m2 = QB.mergeBank(baseOf(), incOf(), { from: '记录', preserveSources: true });
  assert.deepEqual(m2.bank.entries['a'.repeat(32)].answers[0].srcs, ['self:某章'], '同一个来源搬家不算"第二个来源"');
  assert.equal(QB.trustOf(m2.bank.entries['a'.repeat(32)]), 'single', '搬家之后仍然是单来源');
  assert.deepEqual(m1.bank.entries['a'.repeat(32)].n, 1, '搬家/导入都不许动票数');
});

test('模式细分：AI 模式 / 题库模式 是两个开关，默认都开（老行为不变）', () => {
  const quiz = require(path.join(ROOT, '答题助手.js'));
  assert.equal(quiz.DEFAULT_CFG.useAI, true, '默认开（不写这两个键时行为跟以前一模一样）');
  assert.equal(quiz.DEFAULT_CFG.useBank, true);
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /const useBank = \(cfg\.useBank !== false\);/, '题库开关：只有显式 false 才算关');
  assert.match(src, /const useAI = \(cfg\.useAI !== false\);/, 'AI 开关同理');
  assert.match(src, /if \(!useBank\) return null;/, '关了题库 → 查库直接不查');
  assert.match(src, /const bankable = \(cfg\.mode >= 2 && useBank\)/, '截图路"全命中免截图"也要看题库开关');
  assert.match(src, /if \(!useAI && pipeline === 'shot'\)/, 'AI 关着就不该再走截图路（拍图是给模型看的）');
  assert.match(src, /AI 模式关着，题库里也没有/, 'AI 关着、库里没有 → 留着不填，并如实记账');
  assert.match(src, /AI 模式关着：只按本地题库答/, '章末要说清这一章为什么没花钱');
  /* 控制台那条路也要能存这两个开关（不然界面上改了、文件里没变） */
  const con = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(con, /id="useAI"/, '界面上要有 AI 模式');
  assert.match(con, /id="useBank"/, '界面上要有题库模式');
  assert.match(con, /patch\.useAI !== undefined/, '要能被存进配置（校验白名单）');
  assert.match(con, /patch\.useBank !== undefined/);
});

test('写库前先备份：去重复 / 导入题库码都会先留一份 .bak', () => {
  const src = fs.readFileSync(path.join(ROOT, '题库.js'), 'utf8');
  assert.match(src, /function backupBank\(bankPath\)/, '题库.js 要有这个函数');
  assert.match(src, /const bak = p \+ '\.bak';/, '备份文件名就是 题库.json.bak');
  const con = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  /* 库管理之后备份的是**目标库**（lib.path），不再是写死的 题库.json —— 所以按"调用次数"数 */
  const n = (con.match(/QBANK\.backupBank\(lib\.path\)/g) || []).length;
  assert.ok(n >= 2, '导入和去重复两处都要先备份（实际 ' + n + ' 处）');
  /* 真跑一次：临时目录里放个文件，备份要跟原文一字不差 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bak-'));
  try {
    const p = path.join(dir, '题库.json');
    fs.writeFileSync(p, '{"a":1}', 'utf8');
    const bak = QB.backupBank(p);
    assert.ok(bak && fs.existsSync(bak), '备份要真的写出来');
    assert.equal(fs.readFileSync(bak, 'utf8'), '{"a":1}', '内容要一字不差');
    assert.equal(QB.backupBank(path.join(dir, '不存在.json')), '', '没有原文件就不备份（不报错）');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

/* ------------------------------------------------------- 库管理（主库 + 子库） */
test('库管理：能列出主库与子库、按名字找库（子库目录在 题库\\ 里）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-libs-'));
  try {
    const main = path.join(dir, '题库.json');
    fs.writeFileSync(main, JSON.stringify({ version: 1, entries: { ['a'.repeat(32)]: { fp: 'a'.repeat(32), type: '单选', answer: 'A' } } }), 'utf8');
    const sd = path.join(dir, QB.SUB_DIR);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, '军事理论.json'), JSON.stringify({ version: 1, entries: { ['b'.repeat(32)]: { fp: 'b'.repeat(32), type: '单选', answer: 'B' } } }), 'utf8');
    fs.writeFileSync(path.join(sd, '读我.txt'), '不是库', 'utf8');

    const libs = QB.listBanks({ dir: dir, bankFile: main });
    assert.equal(libs.length, 2, '一个主库 + 一个子库（.txt 不算）');
    assert.equal(libs[0].name, '主库');
    assert.equal(libs[0].entries, 1);
    assert.equal(libs[1].name, '军事理论');
    assert.equal(libs[1].entries, 1, '子库条目要数得出来');
    assert.equal(libs[1].file, path.join(QB.SUB_DIR, '军事理论.json'));

    assert.equal(QB.findBank('主库', { dir: dir, bankFile: main }).entries, 1);
    assert.equal(QB.findBank('军事理论', { dir: dir, bankFile: main }).name, '军事理论', '按库名找得到');
    assert.equal(QB.findBank('军事理论.json', { dir: dir, bankFile: main }).name, '军事理论', '按文件名也找得到');
    assert.equal(QB.findBank('不存在的库', { dir: dir, bankFile: main }), null);
    assert.equal(QB.findBank('', { dir: dir, bankFile: main }).name, '主库', '不传就给主库');

    const bk = QB.loadBank(path.join(sd, '军事理论.json'));
    assert.ok(bk && Object.keys(bk.entries).length === 1, '子库要能读进内存库');
    assert.equal(QB.loadBank(path.join(sd, '没有这个.json')), null, '缺文件返回 null，不抛错');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('库管理：运行时逐个库查、每个库各自核对图片；两库答案不一致且分不出高低 → 不用', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /const bankLoadAll = \(\) => \{/, '要能一次载入多个库');
  assert.match(src, /const enabled = \(Array\.isArray\(cfg\.bankEnabled\)/, '启用名单来自配置');
  assert.match(src, /if \(enabled && enabled\.indexOf\(b\.name\) < 0\) continue;/, '没启用的库不查');
  assert.match(src, /const libs = bankLoadAll\(\);/, '查库时用的是"所有启用的库"');
  assert.match(src, /两个库的答案不一致/, '不一致要说清是哪两个库、分别给了什么');
  assert.match(src, /证据也分不出高低 → 不用/, '分不出高低就不填（宁可走原路）');
  assert.match(src, /libsTxt/, '命中日志里要说明答案来自哪个库');
  /* 配置项与界面 */
  const quiz = require(path.join(ROOT, '答题助手.js'));
  assert.deepEqual(quiz.DEFAULT_CFG.bankEnabled, [], '默认空数组 = 全部启用（新增子库自动生效）');
  const con = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(con, /id="banklibs"/, '界面上要有库清单');
  assert.match(con, /id="bankTarget"/, '要能选"导入到哪个库"');
  assert.match(con, /id="bankNewLib"/, '要能新建子库（直接写名字）');
  assert.match(con, /patch\.bankEnabled/, '启用名单要能存进配置');
});

/* ------------------------------------------------------- 课程名自动化 */
test('课程名全自动：控制台"开浏览器并开始"时会自己刷新映射表（失败也不拦着启动）', () => {
  const src = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(src, /const COURSE = require\('\.\/课程名\.js'\);/, '控制台要引这个模块');
  assert.match(src, /await COURSE\.refresh\(\{ port: CDP_PORT/, '启动前刷新一次课程名映射');
  assert.match(src, /不影响答题，只是新章节可能进不了课程库/, '刷新失败要如实说，并且**不拦着启动**');
  /* 模块本身：只会读、不点；临时标签页读完要关 */
  const mod = fs.readFileSync(path.join(ROOT, '课程名.js'), 'utf8');
  assert.match(mod, /function refresh\(opts\)/, '要导出 refresh');
  assert.match(mod, /function loadMap\(file\)/, '要导出 loadMap（答题助手查表用同一份读法）');
  assert.match(mod, /Target\.createTarget/, '没开列表页时自己开一个临时的');
  assert.match(mod, /Target\.closeTarget/, '读完要关掉（不留垃圾标签页）');
  assert.match(mod, /querySelectorAll\('a\[href\]'\)/, '靠页面上的课程链接抓 id + 名字');
  assert.doesNotMatch(mod, /\.click\(\)/, '只读：不许点任何东西');
  /* 打包清单两处都要有它（新产品文件必须两处同步） */
  const pl = path.join(ROOT, '_实验', '_打包临时', '打包清单.js');
  if (fs.existsSync(pl)) {
    const p = fs.readFileSync(pl, 'utf8');
    assert.match(p, /'课程名\.js'/, '要进打包清单');
    assert.match(p, /need\s*=\s*\[[^\]]*'课程名\.js'/, 'need 自检列表里也要有');
  }
  /* 答题助手：页面探不到名字时用 stu_CourseId / URL 查这张表 */
  const q = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(q, /const COURSE_MAP_FILE = '_课程名\.json';/);
  assert.match(q, /window\.stu_CourseId/, '用页面上的课程id去查表');
  assert.match(q, /courseMap\[id\]/, '查到就把课程名写进记录');
  /* 临时标签页是"事故源"：实测开着的几秒里驱动器跟了过去，学习页被顶掉、白等 3 分钟。
     所以：① 只在"当前这门课还没进表"时才开（onlyIfNeeded）；② 开完必须**确认关掉**。 */
  assert.match(mod, /if \(o\.onlyIfNeeded\) \{/, '要有"只在需要时才跑"的闸');
  assert.match(mod, /if \(id && map\[id\]\) \{ out\.ok = true; out\.skipped = true;/, '当前课程已在表里 → 直接跳过，连浏览器都不碰');
  assert.match(mod, /function currentCourseId\(dir\)/, '从 _上次的课程.txt 读当前课程id');
  assert.match(mod, /let closed = false;/, '关临时页要**确认**关掉了');
  assert.match(mod, /临时标签页没能关掉/, '关不掉要如实报出来，不能悄悄留着');
  const con2 = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(con2, /onlyIfNeeded: true/, '控制台调用时要带上这道闸');
});

/* ------------------------------------------------------- 选项字母丢了怎么办 */
test('字母丢了按顺序补 A/B/C/D：这样"作业那份"的题才查得到（实测本来 175/175 全落空）', () => {
  const QS = require(path.join(ROOT, 'quiz-state.js'));
  /* 造一份"字母没解出来"的记录：选项行写成 ?. （当时替身字没解开，字母本身也是替身字） */
  const rec = ['章节测验记录', '',
    '[2026/10/12 15:00:00] 作业 · 作业作答', '课程：军事理论', '──────── 测验：作业 · 作业作答   共 2 题', '',
    '  [1] 单选', '      1.', '       (单选题)', '      将十进制数126.875转换成二进制数，应该是_____。',
    '        ?. 0111 1110.0110', '        ?. 0111 1110.1110', '        ?. 0111 1100.0110', '        ?. 0111 1100.1110',
    '      → 答案：B', '',
    '  [2] 判断', '      2.', '       (判断题)', '      地球是圆的。', '        ?. 对', '        ?. 错', '      → 答案：对', ''].join('\r\n');
  const parsed = QB.parseRecord(rec);
  assert.equal(parsed.questions.length, 2, '两道题都要解析出来');
  const q1 = parsed.questions[0];
  assert.deepEqual(q1.options.map((o) => o.letter), ['A', 'B', 'C', 'D'],
    '字母丢了就按顺序补 —— 平台渲染选项永远按顺序，顺序就是 A/B/C/D');
  assert.equal(q1.lettersFromOrder, true, '要标出来"这字母是推出来的"，别让人以为是读出来的');
  const q2 = parsed.questions[1];
  assert.deepEqual(q2.options.map((o) => o.letter), ['A', 'B'], '判断题同理');

  /* 【决定性断言】补完字母之后，这道题的**别名键**要跟"页面形状"算出来的一模一样 ——
     不然运行时在页面上照样查不到（今天实测：175 道全落空，就是栽在这）。 */
  const fpr = QS.makeFingerprinter({});
  const opts = q1.options.map((o) => ({ letter: o.letter, text: o.text }));
  const recStem = String(q1.stem).replace(/^\d+[.,、]?\s*/, '').replace(/[（(]单选题[）)]/g, '').replace(/^[，,、\s]+/, '').trim();
  const pageStem = '1\n【单选题】' + recStem;
  assert.equal(
    fpr.fpOf({ type: '单选', stem: QB.aliasStem(recStem), options: opts }),
    fpr.fpOf({ type: '单选', stem: QB.aliasStem(pageStem), options: opts }),
    '记录形状与页面形状的别名键必须相等（这就是"查得到"的前提）');
  /* 而不用补字母的话，键是错的（拿空字母算一遍对照） */
  assert.notEqual(
    fpr.fpOf({ type: '单选', stem: QB.aliasStem(recStem), options: q1.options.map((o) => ({ letter: '', text: o.text })) }),
    fpr.fpOf({ type: '单选', stem: QB.aliasStem(pageStem), options: opts }),
    '字母空着算出来的键跟页面对不上 —— 这就是当初 175 道全查不到的原因');
});

test('读取端也一样：页面上字母没读出来时按顺序补（不然运行时算的键还是对不上）', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /字母没读出来就按顺序补 A\/B\/C\/D/, '探针里也要补');
  assert.match(src, /if \(opts\.length > 1 && opts\.some\(function \(o\) \{ return !o\.letter; \}\)\)/, '只在"有选项且确实缺字母"时补');
  assert.match(src, /opts\[oi\]\.letter = String\.fromCharCode\(65 \+ oi\)/, '按位置给 A/B/C/D');
});

/* ------------------------------------------------------- 主库也是合并 */
test('自动建库：主库也用**合并**（手工导进主库的东西不许被重建冲掉）', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /const curMain = QB\.loadBank\(BANK_FILE\) \|\| QB\.parseBank\(''\)/, '先把主库读进来');
  assert.match(src, /QB\.mergeBank\(curMain, sp\.main, \{ from: '记录', preserveSources: true \}\)/, '合并（不是覆盖），且搬家不许多来源');
  assert.match(src, /主库合并失败 → 退回"覆盖式重建"/, '真合并不了就退回覆盖（记录是原始账本，覆盖也安全）');
});

test('去重复的图片闸门：文字/选项一样但**图不同** → 不许并（并了就丢了"哪个答案配哪张图"）', () => {
  /* 【注意】parseBank 是按**条目自己的 fp** 索引的（不是 JSON 的键）——
     第一版我把 fp 写成同一个值、只换 JSON 键，结果第二条把第一条覆盖了，entries['d…'] 直接 undefined。 */
  const mk = (fp, imgIds, images, ans) => ({
    fp: fp, type: '单选', stem: '求下图所示的极限', options: [{ letter: 'A', text: '0' }, { letter: 'B', text: '1' }],
    answer: ans, n: 1, imgIds: imgIds || [], images: images || [], fpOrder: 'e'.repeat(32),
    answers: [{ answer: ans, srcs: ['self:x'], n: 1 }]
  });
  const two = (a, b) => QB.parseBank(JSON.stringify({
    version: 1, entries: { ['c'.repeat(32)]: a, ['d'.repeat(32)]: b }
  }));

  /* ① 两张图完全不重叠（同一道文字、不同图、不同答案）→ **不并**，两条都留着 */
  const ab = two(mk('c'.repeat(32), ['id1'], [], 'A'), mk('d'.repeat(32), ['id2'], [], 'B'));
  assert.equal(Object.keys(ab.entries).length, 2, '先确认两条都在（fp 不同 ⇒ 不会被覆盖）');
  const d1 = QB.dedupeBank(ab, {});
  assert.equal(d1.report.merged, 0, '图不同 → 一条都不许并');
  assert.equal(Object.keys(d1.bank.entries).length, 2, '两条都留着（多留一条不影响正确性）');
  assert.ok((d1.report.splitByImage || 0) >= 1 || (d1.report.keptApartByImage || 0) >= 1, '要记账：有组因为图不同被拆开');

  /* ② 两张图有交集（同一张图的两次不同渲染）→ 并 */
  const ab2 = two(mk('c'.repeat(32), ['id1', 'id9'], [], 'A'), mk('d'.repeat(32), ['id1'], [], 'A'));
  const d2 = QB.dedupeBank(ab2, {});
  assert.equal(d2.report.merged, 1, '有交集 = 同一张图 → 并成一条');
  assert.equal(Object.keys(d2.bank.entries).length, 1);

  /* ③ 两边都没图 → 并（今天的老行为，一个字不变） */
  const ab3 = two(mk('c'.repeat(32), [], [], 'A'), mk('d'.repeat(32), [], [], 'A'));
  assert.equal(QB.dedupeBank(ab3, {}).report.merged, 1, '两边都没图 → 照旧并');

  /* ④ 一边有图一边没有 → 说不清，保守不并 */
  const ab4 = two(mk('c'.repeat(32), ['id1'], [], 'A'), mk('d'.repeat(32), [], [], 'A'));
  assert.equal(QB.dedupeBank(ab4, {}).report.merged, 0, '一边有图一边没有 → 不并（说不清就别赌）');

  /* ⑤ 老条目只有 URL 时同理：URL 不重叠 → 不并 */
  const ab5 = two(mk('c'.repeat(32), [], ['https://a/1.png'], 'A'), mk('d'.repeat(32), [], ['https://a/2.png'], 'B'));
  assert.equal(QB.dedupeBank(ab5, {}).report.merged, 0, '老条目按 URL 判，不重叠就不并');
});

/* ------------------------------------------------------- 去杂（清非法脏数据） */
test('去杂：只删"能证明是垃圾"的三类；正常条目（判断题答案=B 这种）一个都不许动', () => {
  const mk = (fp, extra) => Object.assign({
    fp: fp, type: '单选', stem: '正常题干的长度够', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
    answer: 'A', n: 1, answers: [{ answer: 'A', srcs: ['self:x'], n: 1 }]
  }, extra || {});
  const bank = QB.parseBank(JSON.stringify({
    version: 1, entries: {
      ['1'.repeat(32)]: mk('1'.repeat(32), {}),                                                        /* 正常，留着 */
      ['2'.repeat(32)]: mk('2'.repeat(32), { chapter: '测验 · 假章节' }),                                /* R1 测试数据 */
      ['3'.repeat(32)]: mk('3'.repeat(32), { stem: '1.', options: [], answer: '' }),                     /* R2 空壳 */
      ['4'.repeat(32)]: mk('4'.repeat(32), { options: [{ letter: 'A', text: '' }, { letter: 'B', text: '?' }], answer: '' }), /* R3 认不出 */
      ['5'.repeat(32)]: mk('5'.repeat(32), { type: '判断', answer: 'B', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }] }), /* 完全正常！ */
      ['6'.repeat(32)]: mk('6'.repeat(32), { options: [{ letter: 'A', text: '' }, { letter: 'B', text: '' }], imgIds: ['aaaaaaaa'] })  /* 选项没文字但有图 → 留着 */
    }
  }));
  const c = QB.cleanBank(bank, {});
  const left = Object.keys(c.bank.entries).sort();
  assert.deepEqual(left, ['1'.repeat(32), '5'.repeat(32), '6'.repeat(32)], '只留正常的 + 有图的');
  assert.equal(c.report.r1.length, 1, '测试数据 1 条');
  assert.equal(c.report.r2.length, 1, '空壳 1 条');
  assert.equal(c.report.r3.length, 1, '认不出 1 条');
  /* 【体检时差点误删的那类】判断题答案是 B（选项 A.对 B.错）—— 必须留着 */
  assert.ok(c.bank.entries['5'.repeat(32)], '判断题答案=B 是正常的，不许当垃圾删');
});

test('去杂要落在**建库那条路**上（不然驱动器一重建，清掉的垃圾就回来了）', () => {
  const rec = ['章节测验记录', '',
    '[2026/10/12 16:00:00] 测验 · 假章节', '──────── 测验：测验 · 假章节   共 1 题', '',
    '  [1] 单选', '      假章节里的题', '        A. 甲', '        B. 乙', '      → 答案：A', '',
    '[2026/10/12 16:01:00] 真章节', '──────── 测验：真章节   共 1 题', '',
    '  [1] 单选', '      真章节里的题', '        A. 甲', '        B. 乙', '      → 答案：B', ''].join('\r\n');
  const parsed = QB.parseRecord(rec);
  const bank = QB.buildBank(parsed, { source: 't' });
  assert.equal(Object.keys(bank.entries).length, 1, '只收真章节那道题');
  assert.equal(bank.stats.junkSkipped['test-chapter'], 1, '要在 stats 里如实记账（挡掉了几道）');
  /* isJunkQuestion 的四条规则各过一遍 */
  assert.equal(QB.isJunkQuestion({ chapter: '测验 · 假章节', stem: 'x', options: [{ letter: 'A', text: '甲' }] }), 'test-chapter');
  assert.equal(QB.isJunkQuestion({ chapter: '真章节', stem: '同一道题', options: [{ letter: 'A', text: '甲' }] }), 'test-stem');
  assert.equal(QB.isJunkQuestion({ chapter: '真章节', stem: '没答案没选项', options: [], answer: '' }), 'empty-shell');
  assert.equal(QB.isJunkQuestion({
    chapter: '真章节', stem: '选项全空', answer: '', options: [{ letter: 'A', text: '' }, { letter: 'B', text: '' }]
  }), 'unreadable');
  assert.equal(QB.isJunkQuestion({
    chapter: '真章节', stem: '有图就不算', answer: '', options: [{ letter: 'A', text: '' }, { letter: 'B', text: '' }], imgIds: ['aaaaaaaa']
  }), '', '有图片身份的不算垃圾（能靠图认出来）');
});

test('运行时护栏：没答案的"占位"条目当没命中（别打出空壳答案日志）', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /if \(!hit\.answer\) continue;/, '没答案 → 当没命中');
  assert.match(src, /没答案的条目当没命中/, '要写清为什么（占位条目是留着以后合并答案用的）');
});

/* ------------------------------------------------------- 导出冲突答案 */
test('导出冲突答案：只列"同一道题、不同答案"；答案一致的、单候选的一律不列', () => {
  const mk = (fp, answers, extra) => Object.assign({
    fp: fp, type: '单选', stem: '题干' + fp.slice(0, 4), options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
    answer: answers[0].answer, n: answers.length, answers: answers
  }, extra || {});
  const A = (ans, n, srcs) => ({ answer: ans, answerText: ans === 'A' ? '甲' : '乙', srcs: srcs || ['transcribe:第1章'], n: n || 1 });
  const bank = QB.parseBank(JSON.stringify({
    version: 1, entries: {
      /* 真冲突：两个不同答案 */
      ['a'.repeat(32)]: mk('a'.repeat(32), [A('A', 3), A('B', 1)], { conflict: true }),
      /* 两个候选但答案一致 —— 默认不列 */
      ['b'.repeat(32)]: mk('b'.repeat(32), [A('A', 2), A('A', 1)]),
      /* 只有一个候选 —— 任何情况都不该列 */
      ['c'.repeat(32)]: mk('c'.repeat(32), [A('A', 5)])
    }
  }));
  const only = QB.exportConflicts(bank, {});
  assert.equal(only.count, 1, '默认只列真冲突');
  assert.equal(only.rows[0].fp, 'a'.repeat(32), '列的是冲突那条');
  assert.equal(only.rows[0].不同答案数, 2);
  assert.equal(only.rows[0].cands.length, 2, '两个候选都要在（含票数与来源）');
  assert.equal(only.rows[0].cands[0].answer, 'A', '候选按票数从多到少排');
  assert.ok(only.rows[0].cands[0].srcs.length, '候选要带来源');

  const withAgree = QB.exportConflicts(bank, { includeAgree: true });
  assert.equal(withAgree.count, 2, 'includeAgree 时把"多候选但一致"的也列上');
  assert.ok(!withAgree.rows.some((r) => r.fp === 'c'.repeat(32)), '**单候选的绝不许进来**（今天改过这个坑）');
});

test('导出的 csv 要能被 Excel 打开：BOM + 表头 + 引号/逗号/换行都转义', () => {
  const nasty = '题干里有,逗号 和 "引号"，还有\n换行';
  const bank = QB.parseBank(JSON.stringify({
    version: 1, entries: {
      ['d'.repeat(32)]: {
        fp: 'd'.repeat(32), type: '多选', stem: nasty, options: [{ letter: 'A', text: '甲' }],
        answer: 'A', n: 2, conflict: true,
        answers: [{ answer: 'A', answerText: '甲', srcs: ['transcribe:第2章'], n: 1 },
                  { answer: 'B', answerText: '乙', srcs: ['self:第2章'], n: 1 }]
      }
    }
  }));
  const r = QB.exportConflicts(bank, {});
  assert.equal(r.csv.charCodeAt(0), 0xFEFF, 'csv 开头要有 BOM（不然 Excel 里中文是乱码）');
  const lines = r.csv.split('\r\n');
  assert.match(lines[0], /题目指纹/, '要有表头');
  assert.ok(r.csv.indexOf('""引号""') > 0, '双引号要转义成两个');
  assert.ok(r.csv.indexOf('有,逗号') > 0, '逗号要放在引号里');
  assert.ok(r.csv.indexOf('有两份来源') > 0 || r.csv.indexOf('self:第2章') > 0, '候选来源要写进去');
  /* 人读的 txt 里，题干、选项、候选、现在用的是什么都得有 */
  assert.match(r.text, /⚠ 冲突/);
  assert.match(r.text, /外联式|甲/);
  assert.match(r.text, /现在用：/);
});

test('冲突导出：控制台和命令行都要有入口（源码契约）', () => {
  const web = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(web, /function bankExportConflicts\(target\)/, '控制台要有导出函数');
  assert.match(web, /payload\.conflicts/, '接口要认 conflicts 这个字段');
  assert.match(web, /导出冲突答案/, '界面上要有按钮');
  const cli = fs.readFileSync(path.join(ROOT, '题库.js'), 'utf8');
  assert.match(cli, /--conflicts/, '命令行要支持 --conflicts');
  assert.match(cli, /冲突答案\.csv/, '要写出 csv');
  assert.match(cli, /冲突答案\.txt/, '要写出 txt');
});

/* ------------------------------------------------------- 按标签导出 */
test('标签判据：每个标签都得"能证明"，不许猜', () => {
  const mk = (fp, extra) => Object.assign({
    fp: fp, type: '单选', stem: '题干够长一些', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
    answer: 'A', n: 1, answers: [{ answer: 'A', answerText: '甲', srcs: ['self:第1章'], n: 1 }]
  }, extra || {});
  const K = (d) => String(d).repeat(32);            /* parseBank 按条目自己的 fp 索引，键和 fp 必须一致 */
  const bank = QB.parseBank(JSON.stringify({
    version: 1, entries: {
      [K('1')]: mk(K('1'), { conflict: true, answers: [{ answer: 'A', answerText: '甲', srcs: ['self:第1章'], n: 1 }, { answer: 'B', answerText: '乙', srcs: ['transcribe:第1章'], n: 1 }] }),
      [K('2')]: mk(K('2'), { official: true }),
      [K('3')]: mk(K('3'), { picked: true }),
      [K('4')]: mk(K('4'), { answers: [{ answer: 'A', answerText: '甲', srcs: ['self:第1章'], n: 1 }, { answer: 'A', answerText: '甲', srcs: ['transcribe:第1章'], n: 1 }] }),
      [K('5')]: mk(K('5'), { imgIds: ['aaaaaaaa'] }),
      [K('6')]: mk(K('6'), { answer: '', answers: [] }),
      [K('7')]: mk(K('7'), { undecoded: true }),
      [K('8')]: mk(K('8'), { fpAlt: K('a') }),
      [K('9')]: mk(K('9'), { fpOrder: K('b') })
    }
  }));
  const ids = QB.listTags().map((t) => t.id);
  for (const want of ['conflict', 'official', 'picked', 'multi', 'single', 'image', 'noanswer', 'legacy', 'alias', 'order']) {
    assert.ok(ids.indexOf(want) >= 0, '标签表里应当有 ' + want);
  }
  const cnt = (id) => QB.exportBankByTags(bank, { tags: [id] }).count;
  assert.equal(cnt('conflict'), 1, '冲突');
  assert.equal(cnt('official'), 1, '官方');
  assert.equal(cnt('picked'), 1, '平台已选');
  assert.equal(cnt('multi'), 2, '多来源：①真冲突那条（两个不同来源）②多候选但一致那条');
  assert.equal(cnt('single'), 7, '单来源（只有一个候选的）');
  assert.equal(cnt('image'), 1, '带图片');
  assert.equal(cnt('noanswer'), 1, '没答案');
  assert.equal(cnt('legacy'), 1, '旧格式·模型抄录（字段叫 undecoded 但含义是"非 DOM 读到的"）');
  assert.equal(cnt('alias'), 1, '有别名键');
  assert.equal(cnt('order'), 1, '有顺序无关键');
});

test('多标签一起导：一行可以带多个标签，csv 里有「标签」这一列', () => {
  const bank = QB.parseBank(JSON.stringify({
    version: 1, entries: {
      ['m'.repeat(32)]: {
        fp: 'm'.repeat(32), type: '单选', stem: '又冲突又带图又官方', options: [{ letter: 'A', text: '甲' }],
        answer: 'A', n: 1, official: true, conflict: true, imgIds: ['aaaaaaaa'], fpAlt: 'n'.repeat(32),
        answers: [{ answer: 'A', answerText: '甲', official: true, srcs: ['self:第9章'], n: 1 },
                  { answer: 'B', answerText: '乙', srcs: ['transcribe:第9章'], n: 1 }]
      }
    }
  }));
  const r = QB.exportBankByTags(bank, { tags: ['conflict', 'official', 'image'] });
  assert.equal(r.count, 1);
  assert.deepEqual(r.rows[0].tags.sort(), ['conflict', 'image', 'official'], '三个标签都要认出来');
  assert.match(r.rows[0].tagsName, /冲突/);
  assert.match(r.csv.split('\r\n')[0], /标签/, 'csv 表头要有「标签」列');
  assert.match(r.csv, /冲突/, 'csv 行里要有标签名');
  assert.equal(r.byTag.conflict, 1);
  assert.equal(r.byTag.image, 1);
  assert.equal(r.byTag.official, 1);
  /* 题型筛选 */
  assert.equal(QB.exportBankByTags(bank, { tags: ['conflict'], type: '判断' }).count, 0, '题型限成判断 → 一条都没有');
  assert.equal(QB.exportBankByTags(bank, { tags: ['conflict'], type: '单选' }).count, 1);
});

test('标签解析：all = 全部；认 id 也认中文名；不认识的要说出来', () => {
  assert.equal(QB.parseTags('all').ids.length, QB.listTags().length, 'all = 全部标签');
  assert.deepEqual(QB.parseTags('conflict,official').ids, ['conflict', 'official']);
  assert.deepEqual(QB.parseTags('conflict official').ids, ['conflict', 'official'], '空格分隔也认');
  assert.deepEqual(QB.parseTags('冲突').ids, ['conflict'], '**中文名也认**（命令行上写中文更自然）');
  assert.deepEqual(QB.parseTags('官方').ids, ['official']);
  assert.deepEqual(QB.parseTags('xyz').bad, ['xyz'], '不认识的挑出来');
  assert.deepEqual(QB.parseTags('xyz,ab').ids, [], '认不出的不该混进结果');
  assert.deepEqual(QB.parseTags(['conflict', 'conflict']).ids, ['conflict'], '重复的合并');
});

test('按标签导出：控制台和命令行都要有入口（源码契约 + 不许撞 --export）', () => {
  const web = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(web, /function bankExportByTags\(target, tags, asCode\)/, '控制台要有按标签导出的函数（带 asCode）');
  assert.match(web, /payload\.exportTags/, '接口要认 exportTags');
  assert.match(web, /exportTags: tags, asCode: true, target: bankTargetName\(\)/, '界面提交时带上标签（且要码）');
  assert.match(web, /id="banktags"/, '界面上要有标签勾选框的位置');
  assert.match(web, /bankTagsRender/, '要把标签画出来（含每个标签的条数）');
  const cli = fs.readFileSync(path.join(ROOT, '题库.js'), 'utf8');
  assert.match(cli, /--export-tags/, '命令行要支持 --export-tags');
  assert.match(cli, /takeVal\('--export-tags'\)/, '--export-tags 是取值参数');
  /* 【今天栽过】--export 本来是"导出题库文件"的取值参数，拿它当开关会把后面那个词一起吃掉 */
  assert.ok(cli.indexOf("takeVal('--export')") > 0, '--export 仍然只作为"导出题库文件"的取值参数');
});

test('题库码与导出内容都要"在页面上看得见"（法师：导出题库码做成页面内文本显示）', () => {
  const web = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  /* 题库码：专门的输出框（不再塞进"粘贴导入"那个框里） */
  assert.match(web, /id="bankoutCode"/, '要有专门的题库码输出框');
  assert.match(web, /function bankCopyOut\(\)/, '要有「复制这段码」');
  assert.match(web, /function bankClearOut\(\)/, '要有「清空」');
  assert.ok(web.indexOf("$('bankcode').value = r.code") < 0, '**生成**的码不许再往"粘贴导入"框里塞（那是导入用的）');
  assert.ok(web.indexOf("box.value = r.code || ''") > 0 || web.indexOf("$('bankoutCode').value = r.code") > 0, '要写进导出框');
  /* 导出内容：页面上直接显示文本 + 一键复制；文件照样写 */
  assert.match(web, /id="banktext"/, '要有显示导出文本的位置');
  assert.match(web, /function bankShowText\(/, '要有"把文本画到页面上"的函数');
  assert.match(web, /function bankCopyText\(\)/, '要有「复制这段文本」');
  assert.ok(web.indexOf('bankShowText(r.text') > 0, '导出成功后要把文本画出来');
  /* 服务端要把文本一起回给页面（但文件照样写） */
  const qb = fs.readFileSync(path.join(ROOT, '题库.js'), 'utf8');
  assert.match(qb, /return \{ count: rows\.length, rows: rows, csv: csv, text: t\.join/, 'exportBankByTags 要产出 text');
  assert.match(web, /text: ex\.text, csv: ex\.csv,/, '控制台要把 text 回给页面');
  /* 页面上要有限流（几百条的大导出别把页面卡死），但复制用的是全文 */
  assert.match(web, /var lim = cap \|\| 60000;/, '页面渲染要有上限');
  assert.match(web, /window\.__bankExportText = full;/, '全文要留在内存里给「复制」用');
});

test('按标签导成"可导入的题库码"（法师：要能写进别的库的码，不是人看的报告）', () => {
  /* bankFromTags：按标签挑出一个同构的子库；编码走同一套 encodeCode */
  const mk = (fp, extra) => Object.assign({
    fp: fp, type: '单选', stem: '题干' + fp.slice(0, 3), options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
    answer: 'A', n: 1, answers: [{ answer: 'A', answerText: '甲', srcs: ['self:第1章'], n: 1 }]
  }, extra || {});
  const K = (d) => String(d).repeat(32);
  const bank = QB.parseBank(JSON.stringify({
    version: 1, entries: {
      [K('1')]: mk(K('1'), { conflict: true, answers: [{ answer: 'A', answerText: '甲', srcs: ['self:第1章'], n: 1 }, { answer: 'B', answerText: '乙', srcs: ['transcribe:第1章'], n: 1 }] }),
      [K('2')]: mk(K('2'), { imgIds: ['aaaaaaaa'] }),
      [K('3')]: mk(K('3'), {})
    }
  }));
  const sub = QB.bankFromTags(bank, { tags: ['conflict'] });
  assert.equal(sub.count, 1, '只挑冲突那条');
  assert.deepEqual(Object.keys(sub.bank.entries), [K('1')], '子库结构跟正常库一样（entries 原样带走）');
  assert.ok(sub.bank.entries[K('1')].answers.length === 2, '别名/多答案这些字段不许动');
  /* 做成码 → 解回来还得是它（number 与 fp 都要对） */
  const code = QB.encodeCode(sub.bank, { images: null, withUnverified: true });
  const d = QB.decodeCode(code);
  assert.ok(d.ok, '码要能解');
  assert.equal(d.entries, 1, '解回来 1 条');
  assert.ok(d.bank.entries[K('1')], '键也要对得上');
  /* 【真正要保证的那条】加了 withUnverified ⇒ "选中的全都带出来"（条数一条不差）。
     不去猜 isReliable 的具体规则（它还会看官方/已选/带图…），那属于实现细节；
     这里钉的是**行为契约**：按标签导 = 选中的都进码。 */
  const many = QB.bankFromTags(bank, { tags: ['all'] });
  assert.equal(many.count, 3, 'all 选出 3 条');
  const codeAll = QB.encodeCode(many.bank, { images: null, withUnverified: true });
  assert.equal(QB.decodeCode(codeAll).entries, 3, 'withUnverified ⇒ 3 条全进码');
  assert.ok(QB.decodeCode(QB.encodeCode(many.bank, { images: null })).entries <= 3, '不加开关时只会更少，不会更多');
  /* 题型筛选 + all */
  assert.equal(QB.bankFromTags(bank, { tags: ['all'] }).count, 3, 'all = 全都要');
  assert.equal(QB.bankFromTags(bank, { tags: ['all'], type: '判断' }).count, 0, '题型筛选');
});

test('页面上的分工：码进「导出的题库码」框、人看的报告进导出文本区（源码契约）', () => {
  const web = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(web, /function bankExportTagsCode\(\)/, '要有「把所选标签导成题库码」');
  assert.match(web, /exportTags: tags, asCode: true/, '要请求 asCode');
  assert.match(web, /box\.value = r\.code \|\| ''/, '码要写进码框（#bankoutCode）');
  assert.match(web, /bankShowText\(r\.text \|\| ''\)/, '报告要交给文本区');
  assert.match(web, /payload\.asCode/, '接口要认 asCode');
  assert.match(web, /QBANK\.encodeCode\(sub\.bank, \{ images: IMGFP\.loadTable\(BASE\), withUnverified: true \}\)/, '按标签导码要带 withUnverified');
  assert.match(web, /其中 ' \+ \(r\.picked - r\.pickedNoAns\) \+ ' 条有答案会进码/, '要如实说明"几条没答案进不了码"');
});

/* ------------------------------------------------------- 对外反馈的三条（2026-10-12） */
test('【反馈·高】题库码**只导一次**：alias/order 索引与 official 标记必须同时到位', () => {
  const K = (d) => String(d).repeat(32);
  const small = QB.parseBank(JSON.stringify({
    version: 1, entries: {
      [K('1')]: { fp: K('1'), type: '单选', stem: '老题一', options: [{ letter: 'A', text: '甲' }], answer: 'A', n: 1,
        answers: [{ answer: 'A', answerText: '甲', srcs: ['self:第1章'], n: 1 }] }
    }
  }));
  const inc = { version: 1, entries: {} };
  for (let i = 0; i < 6; i++) {
    const k = K(String(i + 3));
    inc.entries[k] = {
      fp: k, type: '单选', stem: '新题' + i, options: [{ letter: 'A', text: '甲' }], answer: 'A', answerText: '甲', n: 1,
      official: i < 2, fpAlt: K(String.fromCharCode(97 + i)), fpOrder: K(String.fromCharCode(65 + i)),
      answers: [{ answer: 'A', answerText: '甲', srcs: ['import:题库码'], n: 1, official: i < 2 }]
    };
  }
  const d = QB.decodeCode(QB.encodeCode(inc, { withUnverified: true }));
  const m = QB.mergeBank(small, d.bank, { from: '题库码' });
  assert.equal(m.report.added, 6, '六条都是新加的（走的 added 分支 —— 就是原来出事的那条路）');
  /* 关键：**序列化**（= 落盘那一步）之后，索引和标记都要齐 */
  const written = QB.parseBank(QB.serializeBank(m.bank));
  const ents = Object.keys(written.entries);
  const withAlt = ents.filter((k) => written.entries[k].fpAlt).length;
  const withOrd = ents.filter((k) => written.entries[k].fpOrder).length;
  const off = ents.filter((k) => written.entries[k].official).length;
  assert.equal(Object.keys(written.alias || {}).length, withAlt, 'alias 索引要等于"条目里带 fpAlt 的条数"');
  assert.equal(Object.keys(written.order || {}).length, withOrd, 'order 索引要等于"条目里带 fpOrder 的条数"');
  assert.equal(off, 2, 'official 标记要跟着进来（added 分支原来漏了 applyTopAnswer）');
  /* 只导一次就该能用：按别名键查得到 */
  const altKey = K('a');
  assert.equal(written.alias[altKey], K('3'), '别名索引要把 fpAlt 指回主键');
});

test('【反馈·中】判断题 B 与「错」是同一个答案：不许再产生假冲突', () => {
  const K = (d) => String(d).repeat(32);
  const opts = [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }];
  /* 读库时就要归一：老库里有 answer=B 的 */
  const local = QB.parseBank(JSON.stringify({ version: 1, entries: {
    [K('1')]: { fp: K('1'), type: '判断', stem: '单调递增数列必有极限', options: opts,
      answer: 'B', answerText: '错', n: 1, answers: [{ answer: 'B', answerText: '错', srcs: ['import:记录'], n: 1 }] }
  } }));
  assert.equal(local.entries[K('1')].answer, '错', '读进来就该变成"错"（口径统一）');
  assert.equal(local.entries[K('1')].answers[0].answer, '错', '候选答案也要归一');
  /* 别人码里是「错」⇒ 合并应当是 merged（同答案），不是 conflicted（假冲突） */
  const inc = { version: 1, entries: {
    [K('1')]: { fp: K('1'), type: '判断', stem: '单调递增数列必有极限', options: opts,
      answer: '错', answerText: '', n: 1, answers: [{ answer: '错', answerText: '', srcs: ['import:题库码'], n: 1 }] }
  } };
  const m = QB.mergeBank(local, inc, { from: '题库码' });
  assert.equal(m.report.conflicted, 0, '不许再有假冲突');
  assert.equal(m.report.merged, 1, '应当判成合并');
  assert.equal(m.bank.entries[K('1')].conflict, undefined, '也不该挂冲突标记');
  assert.equal(m.bank.entries[K('1')].answers.length, 1, '归一后只剩一个候选');
  assert.deepEqual(m.bank.entries[K('1')].answers[0].srcs.slice().sort().join('|'),
    ['import:记录', 'import:题库码'].sort().join('|'), '两个来源都要留着');
  /* 归一函数本身的口径 */
  assert.deepEqual(QB.normalizeJudgmentAnswer('判断', 'A', '').answer, '对');
  assert.deepEqual(QB.normalizeJudgmentAnswer('判断', 'B', '').answer, '错');
  assert.deepEqual(QB.normalizeJudgmentAnswer('判断', 'B', '错').answer, '错', '有正文时以正文为准');
  assert.deepEqual(QB.normalizeJudgmentAnswer('单选', 'B', '乙').answer, 'B', '选择题不动它');
  assert.equal(QB.normalizeJudgmentAnswer('判断', '不知道', '').changed, false, '认不出的原样留着，别硬改');
});

test('【反馈·高】离线自检的隔离与点名：默认缓存路径可被环境变量挪走，runner 会点名', () => {
  const helper = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(helper, /process\.env\.DSH_ANSWER_CACHE_FILE/, '默认缓存路径要能被环境变量挪走（给测试隔离用）');
  const runner = fs.readFileSync(path.join(ROOT, 'tests', 'run-offline-tests.js'), 'utf8');
  assert.match(runner, /DSH_ANSWER_CACHE_FILE/, 'runner 要给子进程设这个变量（指到临时文件）');
  assert.match(runner, /workspaceTouched/, 'runner 要有"哪个文件碰了工作区数据"的点名机制');
  assert.match(runner, /答题答案缓存\.json'\)/, '盯的就是那份工作区缓存');
});

/* ------------------------------------------------------- 打包清单契约 */
/* 这道契约只在**开发仓库**里能守：分发包不含 _实验\（见 打包清单.js 的排除注释），
   用户机器上找不到那个文件 ⇒ 跳过，不算失败。 */
const PACKLIST = path.join(ROOT, '_实验', '_打包临时', '打包清单.js');
test('打包清单三处契约：题库.js 进清单、进 need 自检、题库.json 进用户数据黑名单',
  { skip: fs.existsSync(PACKLIST) ? false : '分发包里没有 _实验\\，跳过' },
  () => {
    const src = fs.readFileSync(PACKLIST, 'utf8');
    assert.match(src, /['"]题库\.js['"]/, '产品文件必须进打包清单，否则下次出包漏带');
    assert.match(src, /need\s*=\s*\[[^\]]*['"]题库\.js['"]/, 'need 自检列表里也要有它（只改清单不改自检 = 自检形同虚设）');
    assert.match(src, /banned\s*=\s*\/[^\n]*题库\\\.json/, '题库.json 是用户数据，要在 banned 正则里拦住');
    /* 库管理之后多了 题库\ 子库目录：里面的 .json 也全是用户数据。
       少了这条规则，别人拿到包会连"你的子库"一起带走。 */
    assert.match(src, /banned\s*=\s*\/[^\n]*题库\[[^\n]*\.json/, '题库\\ 子库目录里的 .json 也要被 banned 拦住');
    assert.match(src, /banned\s*=\s*\/[^\n]*_课程名\\\.json/, '_课程名.json 是用户的课程名单，也要拦住');
  });
