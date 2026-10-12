'use strict';

/* 字体识别（运行时逐字认字形）的离线测试
 *
 * 背景：平台的 font-cxsecret 是**每份卷子现生成**的（码位随机、sha 每次都变），
 *       老对照表只能覆盖它诞生的那一支 ⇒ 必须能在运行时自己认。
 *       这个文件钉住的是"认字的数学"以及三条护栏 —— 不需要浏览器（渲染那步另有用例外工具验）。
 *
 *     node tests/quiz-font-ident.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FI = require(path.join(ROOT, '字体识别.js'));

/* 造一个"小型参考库"：候选字少、向量自己编 —— 验的是比对/护栏逻辑，不是渲染 */
function tinyRef(vecs, common) {
  const grid = 16;
  const chars = Object.keys(vecs);
  const data = Buffer.alloc(chars.length * grid * grid);
  chars.forEach((ch, i) => { Buffer.from(vecs[ch]).copy(data, i * grid * grid); });
  return {
    grid: grid, n: chars.length, chars: chars.join(''), refFont: 'synthetic',
    common: new Set(String(common || '').split('')),
    data: data, vec: (i) => data.subarray(i * grid * grid, (i + 1) * grid * grid)
  };
}
/* 造一个"有内容的"向量：右上角一块亮 + 左下角一块亮，用参数控制亮在哪，便于造近邻 */
function vecOf(seed) {
  const g = 16, v = new Uint8Array(g * g);
  for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) {
    const on = ((x + seed) % 5 === 0 && y > 2) || ((y + seed) % 7 === 0 && x > 1);
    v[y * g + x] = on ? 255 : 0;
  }
  return v;
}

test('cmap 解析：真字体里有多少码位就读出多少（老表 41、新卷子那支 34）', () => {
  const oldBuf = fs.readFileSync(path.join(ROOT, '_字体', 'font-01-font-cxsecret.ttf'));
  const cps = FI.parseCmap(oldBuf);
  assert.equal(cps.length, 41, '老字体 cmap 应该是 41 个码位');
  assert.ok(cps.includes(0x5390) && cps.includes(0x5E98), '要能拿到具体码位（厐 U+5390 / 庘 U+5E98）');
  for (const n of ['live-font-8a6135f6.ttf']) {
    const p = path.join(ROOT, '_实验', n);
    if (!fs.existsSync(p)) continue;
    assert.equal(FI.parseCmap(fs.readFileSync(p)).length, 34, '新卷子那支 cmap 是 34 个码位');
  }
});

test('ncc：一样的向量得 1，常数向量得 0（不除零）', () => {
  const a = vecOf(1);
  assert.equal(Number(FI.ncc(a, a).toFixed(4)), 1);
  const flat = new Uint8Array(256);
  assert.equal(FI.ncc(flat, flat), 0, '全 0 的向量不能算出 NaN');
});

test('认字：跟自己最像的那个候选胜出', () => {
  const ref = tinyRef({ 甲: vecOf(1), 乙: vecOf(9), 丙: vecOf(17) }, '甲乙丙');
  const r = FI.identifyOne(vecOf(9), ref);
  assert.equal(r.ch, '乙');
  assert.ok(r.score > 0.99, '完全一样应该接近 1');
  assert.equal(r.conf, true);
});

test('护栏一：跟第二名分不开 → conf=false（运行时遇到就整页不用）', () => {
  /* 拿同一个向量当两个候选：第一名和第二名必然一模一样 */
  const ref = tinyRef({ 甲: vecOf(3), 乙: vecOf(3) }, '甲乙');
  const r = FI.identifyOne(vecOf(3), ref);
  assert.equal(r.margin, 0);
  assert.equal(r.conf, false, '分不开就必须标"不确定"，绝不能猜');
});

test('护栏二：异体字陷阱 —— 分差小的时候认"更常见的那个"', () => {
  /* 造一对"几乎同形"的候选：一个在常见字表里，一个不在（模拟 国 / 囯） */
  const near = vecOf(5);
  const near2 = Uint8Array.from(near);
  near2[17] = near2[17] ? 0 : 255;                 /* 差一个像素：分数上谁也压不倒谁 */
  const ref = tinyRef({ 国: near2, 囯: near }, '国');   /* 常见字表里只有"国" */
  const r = FI.identifyOne(near, ref);
  assert.equal(r.tiebreak, true, '分差小 → 该走"挑更常见的"这条护栏');
  assert.equal(r.ch, '国', '异体字不能赢过常用字');
  assert.equal(r.conf, true, '挑完之后要有信心（这是实测 41/41 的前提）');
});

test('护栏三：大面积"自我映射"= 回退字体 → 判失败（这是最危险的一种假成功）', () => {
  assert.equal(FI.looksLikeFallback({ 甲: '甲', 乙: '乙', 丙: '丙', 丁: '丁' }), true);
  assert.equal(FI.looksLikeFallback({ 甲: '水', 乙: '乙', 丙: '火', 丁: '丁' }), false, '一半对一半不算回退');
  assert.equal(FI.looksLikeFallback({ 甲: '甲', 乙: '乙' }), false, '样本太少不下结论（<4 个）');
});

test('解码：拿表解文本；"拿不准"的字要如实计数（调用方据此放弃整页）', () => {
  const table = {
    map: { 徠: '年', 徚: '法', 徖: '侵' },
    conf: { 徠: true, 徚: true, 徖: false }
  };
  const r = FI.decodeWith(table, '1834 徠 徚 徖');
  assert.equal(r.hits, 2);
  assert.equal(r.uncertain, 1);
  assert.match(r.text, /年/);
  assert.match(r.text, /徖/, '拿不准的那个保持原样（不能被"猜"出来）');
  assert.equal(FI.decodeWith(null, 'abc').text, 'abc', '没表就原样返回');
});

test('表缓存：按 sha 前 8 位存/读，读回来 sha 必须对得上', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-table-'));
  try {
    const sha = FI.shaOf(Buffer.from('这不是真字体，只是让 sha 有个值').toString('base64'));
    assert.match(FI.tablePathFor(sha, dir), /对照表-[0-9a-f]{8}\.json$/);
    assert.equal(FI.loadTable(sha, dir), null, '还没写，读不到');
    const p = FI.saveTable({ sha256: sha, map: { 甲: '乙' }, conf: { 甲: true } }, dir);
    assert.ok(p && fs.existsSync(p));
    const back = FI.loadTable(sha, dir);
    assert.equal(back.map['甲'], '乙');
    /* sha 对不上（比如文件被换成别支字体的表）→ 一律不认 */
    assert.equal(FI.loadTable(sha.slice(0, 8) + 'ffffffffffffffffffffffffffffff', dir), null);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('渲染脚本：语法要是对的，而且必须在"声明了字体的那个文档"里画', () => {
  const s = FI.renderScript([0x5390, 0x5E98], 16, { docIndex: 2 });
  new vm.Script(s);                                   /* 起一个真的 JS 解析器，语法错就当场炸 */
  assert.match(s, /host\.createElement\('canvas'\)/, 'canvas 必须建在那份文档里（字体是按文档注册的）');
  assert.match(s, /docHasFont/, '要能自己找"哪个文档声明了 font-cxsecret"');
  assert.match(s, /return \{ ok: true/, '返回对象（驱动 ev 是 returnByValue）');
  assert.ok(s.indexOf('`') < 0, '模板里不能再出现反引号（会把外层模板字符串截断 —— 实测踩过）');
});

test('接线契约：答题助手在"判定能不能用表"时先试字体识别，且拿不准就整页不用', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /const FI = require\('\.\/字体识别\.js'\)/, '要引这个模块');
  assert.match(src, /let tableOk = haveTable && fontTableMatches\(r\.fontB64\)/, '原有判定不变（老表优先）');
  assert.match(src, /FI\.identifyFont\(\{ b64: r\.fontB64, sha: sha, ev: evFn \}\)/, '老表不匹配时当场认字形');
  assert.match(src, /setExtraTable\(t\.table\)/, '认出来就当这一页的表用上');
  assert.match(src, /拿不准"的字，整页不用它（走截图）/, '出现"拿不准"的字 → 整页不用（宁可走截图）');
  const iIdent = src.indexOf('FI.identifyFont(');
  const iUse = src.indexOf('setExtraTable(t.table)');
  assert.ok(iIdent >= 0 && iUse > iIdent, '认字要在用表之前');
  assert.match(src, /FI\.decodeWith\(EXTRA_TABLE, text\)/, 'decodeObf 要把这张表接上（否则白认）');
});

/* ------------------------------------------------- 整句对齐反推（A1-①） */

/* 造一个"认不准一个字"的现场：其余六个字都有把握，只有 圲 拿不准（表里给了个错的候选） */
function alignScene() {
  const table = { map: {}, conf: {} };
  const anchors = { 瑱: '年', 塬: '中', 塪: '国', 塩: '人', 塨: '部', 塭: '成' };
  Object.assign(table.map, anchors);
  for (const k of Object.keys(anchors)) table.conf[k] = true;
  table.map['圲'] = '图';            /* 候选（错的） */
  table.conf['圲'] = false;          /* 拿不准 */
  return table;
}

test('整句对齐反推：两次独立对齐给出同一个字 → 采纳（并标成可追溯的 from:align）', () => {
  const table = alignScene();
  /* 【长度必须一模一样】替身字和真字是一一对应的，长度不变 ——
     所以对齐是"按长度找候选"的。我第一版把它写成了 18 字 vs 19 字，
     候选压根没进比较，白测两轮（现在用例开头就先自己核一遍长度）。 */
  const texts = ['1983瑱4月，塬塪塩民公安塨队塭圲。', '公安塨队塭圲至今'];
  const known = ['1983年4月，中国人民公安部队成立。', '公安部队成立至今'];
  assert.equal(texts[0].length, known[0].length, '先自己确认这两条一样长');
  assert.equal(texts[1].length, known[1].length);
  const r = FI.alignFill({ table: table, texts: texts, known: known });
  assert.equal(r.ok, true);
  const one = r.added.filter((a) => a.sub === '圲')[0];
  assert.ok(one, '两次独立对齐都指向同一个字，就该采纳');
  assert.equal(one.real, '立');
  assert.equal(one.votes, 2);
  const n = FI.applyAlign(table, r.added);
  assert.equal(n, 1);
  assert.equal(table.map['圲'], '立');
  assert.equal(table.conf['圲'], true, '补上之后要变成"有把握"');
  assert.match(table.from['圲'], /^align:2$/, '要留证据（几票）—— 以后出问题能追');
});

test('整句对齐反推：只有一次证据 → 不采纳（宁可留着"拿不准"）', () => {
  const table = alignScene();
  const r = FI.alignFill({
    table: table,
    texts: ['1983瑱4月，塬塪塩民公安塨队塭圲。'],
    known: ['1983年4月，中国人民公安部队成立。']
  });
  assert.equal(r.added.length, 0, '只有一票不够 —— 认错一个字就可能填错一道题');
  assert.equal(FI.applyAlign(table, r.added), 0);
  assert.equal(table.conf['圲'], false, '原样留着"拿不准"');
});

test('整句对齐反推：两次给出不同的字（有争议）→ 不采纳', () => {
  const table = alignScene();
  const r = FI.alignFill({
    table: table,
    texts: ['1983瑱4月，塬塪塩民公安塨队塭圲。', '公安塨队塭圲至今'],
    known: ['1983年4月，中国人民公安部队成立。', '公安部队成位至今']   /* 一个说"立"一个说"位" */
  });
  assert.equal(r.added.length, 0, '1:1 有争议 → 不补');
});

test('整句对齐反推：对不上的候选（锚点错位太多）不许投票', () => {
  const table = alignScene();
  const r = FI.alignFill({
    table: table,
    texts: ['1983瑱4月，塬塪塩民公安塨队塭圲。'],
    known: ['xxxxxxxxxxxxxxxxxxx']        /* 同长度但内容完全不对 */
  });
  assert.equal(r.aligned, 0, '对不上就不算"对齐上"，一个票都不该投');
  assert.equal(Object.keys(r.votes).length, 0);
});

test('整句对齐反推：没有"拿不准"的字时什么都不做（不浪费）', () => {
  const table = alignScene();
  table.conf['圲'] = true; table.map['圲'] = '立';
  const r = FI.alignFill({ table: table, texts: ['x'], known: ['y'] });
  assert.equal(r.added.length, 0);
  assert.match(r.why, /没有拿不准的字/);
});

test('接线：答题助手在"有拿不准的字"时先试整句对齐，补不上才整页退回截图', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /FI\.alignFill\(\{/, '要用整句对齐反推');
  assert.match(src, /FI\.applyAlign\(/, '把补出来的字并进表');
  assert.match(src, /known: knownTexts/, '要把"以前记过的真字文本"喂给它');
  const iAlign = src.indexOf('FI.alignFill({');
  const iRefuse = src.indexOf('整页不用它（走截图）');
  assert.ok(iAlign >= 0 && iRefuse > iAlign, '先试对齐，补不上才退');
});

/* ------------------------------------------------- 48×48 细比（A1-②） */

function tinyRefGrid(grid, vecs, common) {
  const chars = Object.keys(vecs);
  const data = Buffer.alloc(chars.length * grid * grid);
  chars.forEach((ch, i) => { Buffer.from(vecs[ch]).copy(data, i * grid * grid); });
  return {
    grid: grid, n: chars.length, chars: chars.join(''), refFont: 'x',
    common: new Set(String(common || '').split('')),
    data: data, vec: (i) => data.subarray(i * grid * grid, (i + 1) * grid * grid)
  };
}
function vecG(grid, seed) {
  const v = new Uint8Array(grid * grid);
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      v[y * grid + x] = (((x + seed) % 4 === 0 && y > 1) || ((y + seed) % 5 === 0 && x > 1)) ? 255 : 0;
    }
  }
  return v;
}

test('挑形近字：16×16 下长得太像的挑出来，还得并上常用字表', () => {
  const a = vecG(16, 3);
  const near = Uint8Array.from(a); near[17] = near[17] ? 0 : 255;      /* 只差一个像素 */
  const far = vecG(16, 9);
  /* 【键必须是**一个字**】参考库是"一个字符一个向量"（靠 charAt(i) 取字），
     用 "甲2" 这种两字键会让索引整体错位（实测：挑出来的字变成 甲/2/乙/丙）。 */
  const ref = tinyRefGrid(16, { 甲: a, 乙: near, 丙: far, 丁: far }, '丁');
  const pick = FI.pickConfusable(ref, { threshold: 0.9, window: 20 });
  assert.ok(pick.chars.indexOf('甲') >= 0 && pick.chars.indexOf('乙') >= 0, '像的那一对要挑出来');
  assert.ok(pick.chars.indexOf('丁') >= 0, '常用字表也要并进来（对手常常是常用字）');
  assert.ok(pick.pairs >= 1);
});

test('48×48 细比：分辨率上去了就能分开；还是分不开就不给"有把握"', () => {
  const q = vecG(48, 5);
  const same = Uint8Array.from(q);
  const other = vecG(48, 21);
  const ref48 = tinyRefGrid(48, { 国: same, 囯: other }, '');
  const r = FI.refineWith48(q, ref48);
  assert.ok(r, '细库和查询都是 48×48，应该给出结果');
  assert.equal(r.ch, '国');
  assert.equal(r.conf, true, '完全一致必须给"有把握"');
  /* 跟两个候选都很像 → 不给"有把握"（宁可留着拿不准） */
  const mid = Uint8Array.from(q);
  const ref48b = tinyRefGrid(48, { 甲: q, 乙: mid }, '');
  assert.equal(FI.refineWith48(q, ref48b).conf, false, '分不开就不许说有把握');
  assert.equal(FI.refineWith48(new Uint8Array(16), ref48), null, '长度不对 → 直接拒绝（别算出一堆垃圾）');
});

test('接线：16×16 认不准 → 用 48×48 再认一遍；**缓存那条路也要补**（监控抓到的真问题）', () => {
  const src = fs.readFileSync(path.join(ROOT, '字体识别.js'), 'utf8');
  assert.match(src, /async function refineUncertain\(table, ev, opts\)/, '细比要抽成一个函数（两条路复用）');
  assert.match(src, /const ref48 = loadRef48\(\);/, '只在有拿不准的字时才走到读细库这一步');
  assert.match(src, /await ev\(renderScript\(cps, ref48\.grid, \{ docIndex: o\.docIndex \}\)\)/, '把那几个码位按 48×48 重画一遍');
  assert.match(src, /const r2 = refineWith48\(sub, ref48\);/, '拿细库再认一次');
  assert.match(src, /table\.from\[ch\] = 'fine48:'/, '补上的字要留证据（可追溯）');
  assert.match(src, /if \(!r2 \|\| !r2\.conf\) return;/, '细比也不敢确定 → 保持"拿不准"（绝不猜）');
  /* 【监控抓到的那条】实测：缓存里的表带着 conf:false 的码位，
     一路"已缓存：直接用了上次认出来的表 —— 但有一个拿不准的字，整页不用（走截图）"，
     每天早上重跑还是这样 —— 因为细比只挂在新表那条路上，缓存这条路永远补不上。 */
  const iCache = src.indexOf("const cached = loadTable(sha);");
  const iRefineInCache = src.indexOf('await refineUncertain(cached, o.ev');
  assert.ok(iCache >= 0 && iRefineInCache > iCache, '**缓存分支里也要补一把**（补上就省一次截图+一次 AI）');
  assert.match(src, /拿不准的字用 48×48 细比补上了/, '补上了要在日志里说清');
});

test('两份参考库都在、网格对得上（随包发的资产不能缺）', () => {
  const ref = FI.loadRef();
  assert.ok(ref, 'ref-16 要能加载');
  assert.equal(ref.grid, 16);
  assert.ok(ref.n > 20000, '16×16 那份是两万多个候选字');
  const r48 = FI.loadRef48();
  assert.ok(r48, 'ref-48-confuse 要能加载（跑一次 node _字体\\建参考字形.js --confuse 就有）');
  assert.equal(r48.grid, 48);
  assert.ok(r48.n > 100, '细库收的是"形近字 + 常用字"，不该是个空表');
});

test('建库工具：有 --confuse 模式（细库是它生成的，别人拿到包也能重建）', () => {
  const src = fs.readFileSync(path.join(ROOT, '_字体', '建参考字形.js'), 'utf8');
  assert.match(src, /--confuse/, '要有这个开关');
  assert.match(src, /ref-48-confuse\.json\.gz/, '产物名字要跟 字体识别.js 里读的一致');
  assert.match(src, /USE_GRID/, '网格要跟着切成 48');
});

test('打包清单：字体识别.js 要进清单 + 进 need 自检（新产品文件必须两处同步）', () => {
  const p = path.join(ROOT, '_实验', '_打包临时', '打包清单.js');
  if (!fs.existsSync(p)) return;            /* 分发包里没有 _实验\ 就跳过 */
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /'字体识别\.js'/, '要进 eng 清单');
  /* need 数组是跨行写的，所以要取"从 const need = 开始的一块"来核，不能只看那一行 */
  const needBlock = src.slice(src.indexOf('const need = '), src.indexOf('const need = ') + 400);
  assert.match(needBlock, /'字体识别\.js'/, '也要进 need 自检那一块');
});
