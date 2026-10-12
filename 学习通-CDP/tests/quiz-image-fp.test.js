'use strict';

/* 图片指纹（不看内容、只看像素）的离线测试
 *
 * 背景：题干里的插图/公式图，我们不需要知道"图里写的什么"，
 *       只需要回答"这一张和库里那张是不是同一张" —— 跟字体对照表同一个思路。
 *       这个文件钉住的是归一化/相似度/表/码这几块纯逻辑（不需要浏览器、不需要网络）。
 *
 *     node tests/quiz-image-fp.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const IMG = require(path.join(ROOT, '图片指纹.js'));

/* 造一张"图"：白底 + 一个**空心方框**（有内部结构！）。
   注意别用实心方块：去纯色边之后它会变成一整块纯色 → 没有"形状"可比，相似度恒为 0
   （第一版就栽在这儿，6 条用例全红）。
   shape: 'ring' 空心框 / 'block' 实心块 / 'diag' 斜线 —— 用来造"另一张图" */
function makeGray(w, h, fx, shape) {
  const g = new Uint8Array(w * h).fill(255);
  const bw = Math.max(6, Math.round(w * 0.3)), bh = Math.max(6, Math.round(h * 0.3));
  const x0 = Math.round((w - bw) * fx), y0 = Math.round((h - bh) * fx);
  const st = Math.max(1, Math.round(w * 0.03));
  const kind = shape || 'ring';
  for (let y = y0; y < Math.min(h, y0 + bh); y++) {
    for (let x = x0; x < Math.min(w, x0 + bw); x++) {
      const edge = (x - x0 < st) || (y - y0 < st) || ((x0 + bw - 1 - x) < st) || ((y0 + bh - 1 - y) < st);
      const diag = Math.abs((x - x0) / (bw || 1) - (y - y0) / (bh || 1)) < 0.12;
      if (kind === 'ring' && edge) g[y * w + x] = 0;
      else if (kind === 'block') g[y * w + x] = 0;
      else if (kind === 'diag' && diag) g[y * w + x] = 0;
    }
  }
  return g;
}

test('归一化：同一张图形状不变 → 指纹高度相似；镜像/另一个形状 → 明显不像', () => {
  const a = IMG.fingerprintOfGray(makeGray(96, 96, 0.10), 96, 96, 16);
  const b = IMG.fingerprintOfGray(makeGray(48, 48, 0.10), 48, 48, 16);   /* 缩一半 */
  const same = IMG.ncc(a, b);
  assert.ok(same > 0.9, '缩放过照样要像（实测同一张图缩到 60% 是 0.9453），实际 ' + same.toFixed(4));

  /* 挪个位置也要像：归一化会"去边+拉满"，位置和大小都不该影响判定 */
  const moved = IMG.fingerprintOfGray(makeGray(96, 96, 0.7), 96, 96, 16);
  assert.ok(IMG.ncc(a, moved) > 0.9, '同一张图挪位置要像（去边/拉满就是干这个的），实际 ' + IMG.ncc(a, moved).toFixed(4));

  /* 镜像要用**不对称**的形状来测：空心方框是对称的，镜像当然还像（那是我的测试数据造错了） */
  const asym = IMG.fingerprintOfGray(makeGray(96, 96, 0.1, 'diag'), 96, 96, 16);
  const asymMirror = Buffer.alloc(256);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) asymMirror[y * 16 + x] = asym[y * 16 + (15 - x)];
  assert.ok(IMG.ncc(asym, asymMirror) < 0.5, '不对称形状镜像过来得当另一张（实测那张图是 -0.0171），实际 ' + IMG.ncc(asym, asymMirror).toFixed(4));

  const other = IMG.fingerprintOfGray(makeGray(96, 96, 0.1, 'block'), 96, 96, 16);   /* 换个形状 */
  assert.ok(IMG.ncc(asym, other) < 0.9, '形状不一样就不能判成同一张，实际 ' + IMG.ncc(asym, other).toFixed(4));
});

test('归一化：先去纯色边 —— 白边多宽都不影响指纹', () => {
  const inner = makeGray(64, 64, 0.2);
  const withBorder = new Uint8Array(96 * 96).fill(255);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) withBorder[(y + 16) * 96 + (x + 16)] = inner[y * 64 + x];
  const a = IMG.fingerprintOfGray(inner, 64, 64, 16);
  const b = IMG.fingerprintOfGray(withBorder, 96, 96, 16);
  assert.ok(IMG.ncc(a, b) > 0.97, '带白边和不带白边要认成同一张，实际 ' + IMG.ncc(a, b).toFixed(4));
});

test('纯色图不该算出 NaN（那种图没有"形状"可比）', () => {
  const flat = new Uint8Array(64 * 64).fill(128);
  const v = IMG.fingerprintOfGray(flat, 64, 64, 16);
  assert.equal(v.length, 256);
  assert.equal(IMG.ncc(v, v), 0, '全同的纯色图：没有形状 → 相似度 0（不除零）');
});

test('id 由指纹算出来：同样的图两台机器各自算，id 必须一样', () => {
  const a = IMG.fingerprintOfGray(makeGray(96, 96, 0.1), 96, 96, 16);
  const b = IMG.fingerprintOfGray(makeGray(96, 96, 0.1), 96, 96, 16);
  assert.equal(IMG.idOf(a), IMG.idOf(b), '同样的向量 → 同样的 id（跨机器靠这个对上）');
  assert.match(IMG.idOf(a), /^[0-9a-f]{8}$/);
  /* 注意：**形状不同**才算"另一张" —— 挪位置/缩放不算（归一化会抹平，那是设计目的） */
  const other = IMG.fingerprintOfGray(makeGray(96, 96, 0.1, 'diag'), 96, 96, 16);
  assert.notEqual(IMG.idOf(a), IMG.idOf(other), '不同形状必须是不同的 id');
});

test('查表：id 直接命中走"精确"，换个编码（像素略有差异）走"模糊"也能命中', () => {
  const v = IMG.fingerprintOfGray(makeGray(96, 96, 0.1), 96, 96, 16);
  const table = IMG.emptyTable();
  table.ids[IMG.idOf(v)] = v.toString('base64');
  const exact = IMG.matchOne(v, table);
  assert.equal(exact.exact, true);
  assert.equal(exact.id, IMG.idOf(v));

  /* 模拟"重压成 JPEG"：像素上抖了一点（实测同一张图 0.997） */
  const jitter = Buffer.from(v);
  for (let i = 0; i < jitter.length; i += 7) jitter[i] = Math.max(0, Math.min(255, jitter[i] + 6));
  const fuzzy = IMG.matchOne(jitter, table);
  assert.equal(fuzzy.exact, false);
  assert.equal(fuzzy.hit, true, '像素抖一点也要认出来（这就是"换编码还能认"的底气）');
  assert.equal(fuzzy.id, IMG.idOf(v));

  /* 完全不同的图 → 不许命中 */
  const other = IMG.fingerprintOfGray(makeGray(96, 96, 0.6, 'diag'), 96, 96, 16);
  assert.equal(IMG.matchOne(other, table).hit, false, '不像就不许命中（宁可退回问 AI）');
});

test('并表：按 id 取并集；同一 URL 指向两个 id 时保留先到的并计数', () => {
  const v1 = IMG.fingerprintOfGray(makeGray(96, 96, 0.1), 96, 96, 16);
  /* v2 必须**换形状**：只挪位置/缩放的话，归一化之后指纹一模一样（那是设计目的，不是 bug） */
  const v2 = IMG.fingerprintOfGray(makeGray(96, 96, 0.1, 'diag'), 96, 96, 16);
  assert.notEqual(IMG.idOf(v1), IMG.idOf(v2), '先确认这两张确实是不同的图');
  const A = IMG.emptyTable(); A.ids[IMG.idOf(v1)] = v1.toString('base64'); A.urls['http://x/1.png'] = IMG.idOf(v1);
  const B = IMG.emptyTable(); B.ids[IMG.idOf(v1)] = v1.toString('base64'); B.ids[IMG.idOf(v2)] = v2.toString('base64');
  B.urls['http://x/1.png'] = IMG.idOf(v2);          /* 冲突：同一个 URL 两个 id */
  B.urls['http://x/2.png'] = IMG.idOf(v2);
  const r = IMG.mergeTable(A, B, {});
  assert.equal(r.report.added, 1, '只该多出 v2 那条');
  assert.equal(r.report.same, 1, 'v1 已经在了');
  assert.equal(r.report.urlAdded, 1);
  assert.equal(r.report.urlConflict, 1, 'URL 冲突要计数（不是覆盖）');
  assert.equal(r.table.urls['http://x/1.png'], IMG.idOf(v1), '冲突时保留先到的');
});

test('表落盘/读回：读回来 id 与向量都对得上（表是用户数据、可分享）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-table-'));
  try {
    const v = IMG.fingerprintOfGray(makeGray(96, 96, 0.1), 96, 96, 16);
    const t = IMG.emptyTable();
    t.ids[IMG.idOf(v)] = v.toString('base64');
    t.urls['http://x/1.png'] = IMG.idOf(v);
    const p = IMG.saveTable(t, dir);
    assert.ok(p && fs.existsSync(p));
    const back = IMG.loadTable(dir);
    assert.equal(back.ids[IMG.idOf(v)], v.toString('base64'));
    assert.equal(back.urls['http://x/1.png'], IMG.idOf(v));
    assert.equal(back.stats.ids, 1);
    assert.equal(IMG.loadTable(path.join(dir, '不存在')).ids && Object.keys(IMG.loadTable(path.join(dir, '不存在')).ids).length, 0, '没有表时是空表，不炸');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('解码脚本：语法要对，而且用中灰垫底（透明区不能偏黑）', () => {
  const s = IMG.decodeScript('data:image/png;base64,AAAA');
  new vm.Script(s);                                        /* 真 JS 解析器验语法 */
  assert.match(s, /fillStyle = '#808080'/, '透明区要垫中灰 —— 垫黑的话同一张透明底图会算成另一张');
  assert.match(s, /return \{ ok: true, w: w, h: h/, '返回对象（驱动的 ev 是 returnByValue）');
});

test('取图字节：认得出常见图片格式（用来给 data: URL 挑 mime）', () => {
  assert.equal(IMG.mimeOf(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0])), 'image/png');
  assert.equal(IMG.mimeOf(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), 'image/jpeg');
  assert.equal(IMG.mimeOf(Buffer.from('RIFF____WEBPVP8 ', 'ascii')), 'image/webp');
  assert.equal(IMG.mimeOf(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(IMG.mimeOf(Buffer.from('不是图片', 'utf8')), 'application/octet-stream');
});

test('接线契约：题库码能带图片表（images 段），且不带也能解', () => {
  const QB = require(path.join(ROOT, '题库.js'));
  const v = IMG.fingerprintOfGray(makeGray(96, 96, 0.1), 96, 96, 16);
  const ids = {}; ids[IMG.idOf(v)] = v.toString('base64');
  const emptyBank = QB.parseBank('');
  const code = QB.encodeCode(emptyBank, { images: { ids: ids, urls: { 'http://x/1.png': IMG.idOf(v) } } });
  assert.match(code, /^TIKU1:/);
  const d = QB.decodeCode(code);
  assert.equal(d.ok, true);
  assert.ok(d.images && d.images.ids, '码里要带得动 images 段');
  assert.equal(Object.keys(d.images.ids).length, 1);
  const d2 = QB.decodeCode(QB.encodeCode(emptyBank, {}));
  assert.equal(d2.ok, true);
  assert.equal(d2.images, null, '不带图片表的码照样能解（老码兼容）');
});

test('取图失败：不许写表、不许抛错（宁可这道题没有图片 id，也不能打断答题）', async () => {
  const table = IMG.emptyTable();
  const r = await IMG.idForUrl('http://127.0.0.1:1/x.png', { table: table, timeoutMs: 1500 });
  assert.equal(r.ok, false, '取不到图就是失败');
  assert.equal(Object.keys(table.ids).length, 0, '失败时不许往表里塞东西');
  assert.equal(Object.keys(table.urls).length, 0, '也不许记 URL');
});

test('记录格式：建库端能读懂「→ 图片指纹：…」这一行，坏 id 会被丢掉', () => {
  const QB = require(path.join(ROOT, '题库.js'));
  const rec = [
    '章节测验记录', '', '[2026/10/12 12:00:00] 测验 · 图片题',
    '──────── 测验：图片题   共 1 题', '',
    '  [1] 单选', '      1', '       【单选题】带公式的题',
    '        A. 甲', '        B. 乙',
    '      → 图片 1 张：https://p.ananas.chaoxing.com/star3/origin/ab.png',
    '      → 图片指纹：a1b2c3d4',
    '      → 答案：B', ''
  ].join('\n');
  const p = QB.parseRecord(rec);
  assert.equal(p.questions.length, 1);
  assert.equal(p.questions[0].imgIds.length, 1);
  assert.equal(p.questions[0].imgIds[0], 'a1b2c3d4');
  const bad = rec.replace('a1b2c3d4', '不是十六进制');
  assert.equal(QB.parseRecord(bad).questions[0].imgIds.length, 0, '认不出的 id 一律丢掉');
});

test('接线：答题助手会顺手攒图片指纹（算不出也不影响这一章）', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /const IMGFP = require\('\.\/图片指纹\.js'\)/, '要引图片指纹模块');
  assert.match(src, /await IMGFP\.idForUrl\(u, \{ ev: evFn, table: tbl, dir: __dirname \}\)/, '取图算 id 要走产品模块');
  assert.match(src, /→ 图片指纹：/, '记录里要写下这一行（以后升级指纹时靠它）');
  assert.match(src, /攒不动就算了，绝不打断答题/, '整块要有护栏：算不出来不影响既有行为');
  assert.doesNotMatch(src, /imgIds\.get\(u\)[^)]*\)\s*\+\+\s*;/, '别塞奇怪的副作用');
});

test('护栏：优先比图片指纹 id —— URL 变了也能放行（这才是"带图题命中"的关键）', () => {
  const QB = require(path.join(ROOT, '题库.js'));
  const idA = 'aaaaaaaa';
  /* 库里那条：带 id（新条目） */
  const rec = [
    '章节测验记录', '', '[2026/10/12 13:00:00] 测验 · 图片题',
    '──────── 测验：图片题   共 1 题', '',
    '  [1] 单选', '      1', '       【单选题】带图的题',
    '        A. 甲', '        B. 乙',
    '      → 图片 1 张：https://旧域名/old.png',
    `      → 图片指纹：${idA}`,
    '      → 答案：B', ''
  ].join('\n');
  const b = QB.buildBank(QB.parseRecord(rec), { source: 't' });
  const k = Object.keys(b.entries)[0];
  assert.deepEqual(b.entries[k].imgIds, [idA], '建库要把图片指纹存进条目');
  assert.equal(b.entries[k].hasImage, true);
  /* 导出/并表也要带着它（不带的话换个机器就退回按 URL 比、白瞎） */
  const ex = QB.exportBank(b, { from: 't' });
  assert.deepEqual(ex.entries[k].imgIds, [idA], '导出要带 imgIds');
  const code = QB.encodeCode(b, {});
  const d = QB.decodeCode(code);
  assert.equal(d.ok, true);
});

test('护栏的判定顺序：两边都有 id → 只认 id；**页面的每个 id 都要能在库里找到**（子集，不是完全相等）', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  assert.match(src, /const hitIds = \(hit\.entry\.imgIds \|\| \[\]\);/, '两边都有 id 时先按 id 判');
  assert.match(src, /pageIdsList\.every\(\(x\) => hitIds\.indexOf\(x\) >= 0\)/,
    '判据是"页面的每个指纹都能在库里找到"—— 去重复会把同一题的指纹**并集**，库里可能比页面多');
  assert.match(src, /图片指纹对不上（' \+ L\.name/, 'id 对不上要如实说（并带上"是哪个库"）');
  assert.match(src, /const hitUrls = \(hit\.entry\.images \|\| \[\]\);/, '老条目（只有 URL）要退回按 URL 比');
  assert.match(src, /const pageIds = \(q\.imgs \|\| \[\]\)\.map\(\(u\) => imgIds\.get\(u\)\)/, '页面这边的 id 从本章开头算好的表里取');
  /* 库管理之后：逐个库查、每个库各自核对图片（某个库的图对不上，不该连累另一个库） */
  assert.match(src, /for \(const L of libs\) \{/, '要逐个库查（主库 + 子库）');
  assert.match(src, /图片对不上（' \+ L\.name \+ '）'/, '图片对不上要说清是哪个库');
  /* 反过来那一半也要在：页面出现了库里没有的图 → 拒（这题多半是另一个变体） */
  assert.match(src, /页面的图在库里找不到/, '页面多出来的图也要拒 —— 宁可不答');
});

test('题库码带向量：对方没"见过"这张图，也能把图归到码里那个 id（跨机器的坑）', () => {
  const IMG = require(path.join(ROOT, '图片指纹.js'));
  const QB = require(path.join(ROOT, '题库.js'));
  /* 造一张图（16×16 灰度）→ 算向量 / id，当成"发码那台机器"看到的 */
  const gray = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) gray[i] = (i % 7 === 0) ? 240 : (i % 3 === 0 ? 90 : 10);
  const vec = IMG.fingerprintOfGray(gray, 16, 16, 16);
  const id = IMG.idOf(vec);
  assert.ok(vec && id, '先得算出向量和 id');

  /* 发码方：表里有这张图的向量；库里有一条引用它的条目 */
  const senderTable = IMG.emptyTable();
  senderTable.ids[id] = Buffer.from(vec).toString('base64');
  const bank = { version: 1, builtAt: '', source: '', stats: {}, entries: {
    ['a'.repeat(32)]: {
      fp: 'a'.repeat(32), type: '单选', stem: '带图题', options: [{ letter: 'A', text: '甲' }],
      answer: 'A', n: 1, imgIds: [id], answers: [{ answer: 'A', srcs: ['self:x'], n: 1 }]
    }
  } };
  const code = QB.encodeCode(bank, { images: senderTable });
  const d = QB.decodeCode(code);
  assert.ok(d.ok, '码要能解开');
  assert.ok(d.images && d.images.ids && d.images.ids[id], '码里要带上这张图的向量');

  /* 收码方：表是**空的**（从没见过这张图）——这正是跨机器的情形 */
  const recvTable = IMG.emptyTable();
  const mg = IMG.mergeTable(recvTable, d.images, {});
  assert.ok(mg.table.ids[id], '合并之后表里就有这张图了');
  /* 关键：拿同一个向量去查，必须回到**码里那个 id**（而不是算出一个新 id） */
  const m = IMG.matchOne(vec, mg.table, {});
  assert.ok(m && m.hit, '应该命中（向量就是表里那条）');
  assert.equal(m.id, id, '必须归到码里那个 id —— 不然护栏会拒，白漏一次免答');
});

test('题库码只带"被引用"的图片向量（不然会随历史图线性膨胀）', () => {
  const IMG = require(path.join(ROOT, '图片指纹.js'));
  const QB = require(path.join(ROOT, '题库.js'));
  const t = IMG.emptyTable();
  t.ids['aaaaaaaa'] = Buffer.alloc(256, 1).toString('base64');
  t.ids['bbbbbbbb'] = Buffer.alloc(256, 2).toString('base64');
  const bank = { version: 1, entries: {
    ['c'.repeat(32)]: {
      fp: 'c'.repeat(32), type: '单选', stem: '只引用第一张', options: [{ letter: 'A', text: '甲' }],
      answer: 'A', n: 1, imgIds: ['aaaaaaaa'], answers: [{ answer: 'A', srcs: ['self:x'], n: 1 }]
    }
  } };
  const d = QB.decodeCode(QB.encodeCode(bank, { images: t }));
  assert.ok(d.images.ids['aaaaaaaa'], '被引用的那张要在');
  assert.equal(d.images.ids['bbbbbbbb'], undefined, '没被引用的那张**不许**带（码要长成"跟图数无关"）');
  /* 老码（没有图片段）照样能解 */
  const old = QB.decodeCode(QB.encodeCode(bank, {}));
  assert.ok(old.ok, '没有图片段的码也要能解');
  assert.equal(old.images, null, '老码的 images 是 null（解码端照旧处理）');
});

test('取图必须带 Referer —— 裸 fetch 会被 CDN 403（实测：这个是整条路的命门）', async () => {
  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u, o) => {
    seen = { url: String(u), headers: (o && o.headers) || {} };
    return { ok: true, arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 1, 1]) };
  };
  try {
    const r = await IMG.fetchImageBytes('https://p.ananas.chaoxing.com/star3/origin/abc.png', {});
    assert.equal(r.ok, true);
    assert.match(String(seen.headers.Referer || ''), /mooc1\.chaoxing\.com/,
      '实测：不带 Referer 是 403、带上才 200 —— 少了它，图片指纹整条路都是废的');
    assert.ok(seen.headers['User-Agent'], 'UA 也要带（有的 CDN 只看 UA）');
    assert.equal(r.via, 'node', 'Node 这条路能走通就别去打扰浏览器');
  } finally { globalThis.fetch = real; }
});

test('打包清单：图片指纹.js 进清单 + 图片对照表.json 进用户数据黑名单', () => {
  const p = path.join(ROOT, '_实验', '_打包临时', '打包清单.js');
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /'图片指纹\.js'/, '要进 eng 清单');
  const needBlock = src.slice(src.indexOf('const need = '), src.indexOf('const need = ') + 420);
  assert.match(needBlock, /'图片指纹\.js'/, '也要进 need 自检');
  assert.match(src, /图片对照表\\\.json\$/, '用户数据要在 banned 正则里（不能进分发包）');
});
