/* quiz-idxmap.test.js —— "答案题号 → 页面题号"的映射规则（离线，全假）
 *
 * 背景（codex 2026-10-23 在 fb2cac2 上复现的 P1 回归）：
 *   截图只拍一部分题时，AI 可能按"页面原题号"答（10. / 11.）、也可能按"这批第几条"答（1. / 2.）、
 *   还可能跳号（1.A、3.B）。原来一律按出现顺序重编成 1..N —— 跳号的会被压成 1、2，
 *   于是**第三题的答案被填到第二题**。
 *
 * 现在的规则（fillFromText + origMap）：
 *   ① 答案题号命中 origMap（原题号 → 页面索引）→ 按它填；
 *   ② 不命中 → 回退"第 k 条 ↔ indexMap[k]"；
 *   ③ 两边都对不上 → **跳过**（宁漏不错位）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Q = require(path.join(__dirname, '..', '答题助手.js'));

/* mock 掉页面：probe 报"有 n 道题"，按题号（fillAct 把题号编进 `var HINT = N;`）记下点了第几题 */
function makeEv(n) {
  const asked = [];
  const ev = async (expr) => {
    const s = String(expr);
    /* 注意：fillAct 生成的表达式**每条都含** if (BY === "probe") 分支，
       所以只能精确判 ar BY = "probe"; —— 用 indexOf('"probe"') 会把正常填题也当成 probe。 */
    if (s.indexOf('var BY = "probe";') >= 0) return { ok: true, n: n, vis: n, probe: true, docs: 1 };
    const m = s.match(/var HINT = (\d+);/);
    if (!m) return { ok: false, why: '题干定位不到（mock）', n: n };
    const want = Number(m[1]);
    asked.push(want);
    return {
      ok: true, n: n, vis: n,
      picks: [{ letter: 'A', selected: true, inView: true, x: 10, y: 20 }],
    };
  };
  return { ev: ev, asked: asked };
}

const MAP = { orig: { 10: 9, 11: 10 }, idx: [9, 10] };   // 只截了页面第 10、11 题（1 起）

test('AI 按原题号答（10./11.）→ 填到页面第 10、11 题', async () => {
  const { ev, asked } = makeEv(14);
  let rep = null;
  await Q.fillFromText(ev, '10. A\n11. B', 2, {
    indexMap: MAP.idx, origMap: MAP.orig, onResult: (r) => { rep = r; },
  });
  assert.deepEqual(asked, [9, 10], '必须按原题号映射（页面第 10、11 题 = 0 起的 9、10），不能压成 1、2');
  assert.equal(rep && rep.filled, 2);
});

test('AI 按这批第几条答（1./2.）→ 回退 indexMap，仍填第 10、11 题', async () => {
  const { ev, asked } = makeEv(14);
  await Q.fillFromText(ev, '1. A\n2. B', 2, { indexMap: MAP.idx, origMap: MAP.orig });
  assert.deepEqual(asked, [9, 10], '顺序号要走 indexMap 回退');
});

test('AI 跳号（1.A、3.B）→ 两条都不填（max(n)>k ⇒ 判成原题号、又对不上 → 全跳过，宁漏不错位）', async () => {
  /* 2026-10-23 改：`max(n) > 答案条数` 说明 AI 给的是页面原题号（批号不可能超过条数）。
     这里 pool=2、AI 写了「3.」→ 判成原题号 → origMap 里没有 3（只有 10、11）→ 全跳过。
     保守是刻意的：宁可漏答记欠账，也不把第三题的答案填到第二题。 */
  const { ev, asked } = makeEv(14);
  let rep = null;
  const msg = await Q.fillFromText(ev, '1. A\n3. B', 2, {
    indexMap: MAP.idx, origMap: MAP.orig, onResult: (r) => { rep = r; },
  });
  assert.deepEqual(asked, [], '题号对不上就一条都不填');
  assert.equal(rep && rep.filled, 0);
  assert.ok(rep && rep.skipped >= 1, '跳过要如实记账');
  assert.match(msg, /跳过/, '结论里要写清跳过');
});

test('没有 indexMap/origMap 时行为不变（答案就是 1..N）', async () => {
  const { ev, asked } = makeEv(3);
  await Q.fillFromText(ev, '1. A\n2. B\n3. C', 3, {});
  assert.deepEqual(asked, [0, 1, 2], '整章截图的老路径一个字都不许变（HINT 是 0 起索引）');
});
