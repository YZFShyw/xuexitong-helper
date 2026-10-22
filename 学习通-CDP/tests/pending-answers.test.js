/* 待补答案清单测试（离线，只写系统临时目录）
 *
 * 规矩：
 *   · addMiss 按指纹去重：同一题漏两次只留一条、missCount 累加；
 *   · --set 的写入逻辑（applyAnswer）把答案补进题库条目、清单标 filled；
 *   · 不写真实 题库.json（save:false），不碰真实清单（PENDING_FILE 指到临时目录）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pending-'));
process.env.PENDING_FILE = path.join(TMP, '待补答案.jsonl');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

const ROOT = path.join(__dirname, '..');
const pending = require(path.join(ROOT, '待补答案.js'));
const QB = require(path.join(ROOT, '题库.js'));

const REC = {
  type: '单选', stem: '1. 下列选项中，不属于信息化战争特征的是（）',
  options: ['A. 战场透明', 'B. 非接触作战', 'C. 大规模人海冲锋', 'D. 精确打击'],
  chapter: '4.1 信息化战争', why: '题库没有这道题',
};

test('addMiss：同一题漏两次只留一条，missCount 累加', () => {
  pending.addMiss(REC);
  pending.addMiss(REC);
  const list = pending.loadList();
  assert.equal(list.length, 1, '同一指纹只留一条');
  assert.equal(list[0].missCount, 2, '漏两次要累加');
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].stem, REC.stem);
});

test('addMiss：不同题各记一条', () => {
  pending.addMiss({ type: '判断', stem: '2. 另一道题', options: ['对', '错'], chapter: 'x', why: 'y' });
  assert.equal(pending.loadList().length, 2);
});

test('applyAnswer：把人工答案补进题库条目，清单标 filled（不写盘）', () => {
  const list = pending.loadList();
  const fp = list[0].fp;
  const bank = QB.parseBank(JSON.stringify({ version: QB.BANK_VERSION, builtAt: '', source: '', stats: {}, entries: {} }));
  const r = pending.applyAnswer(bank, fp, 'C', { save: false });
  assert.equal(r.ok, true);
  const e = bank.entries[fp];
  assert.ok(e, '题库里应新建这条');
  assert.equal(e.answer, 'C', '默认答案应是人工补的');
  assert.ok((e.answers || []).some((a) => (a.srcs || []).indexOf('manual:pending') >= 0), '来源要标 manual:pending');
  const after = pending.loadList().filter((x) => x.fp === fp)[0];
  assert.equal(after.status, 'filled', '清单要标已完成');
  assert.equal(after.filledAnswer, 'C');
});

/* 【codex 2026-10-22 报告 + 复现】不同选项的两道题，指纹必须不同 ——
   否则 addMiss 会把它们当成同一道题合并，补答案时可能填错题。
   根因：noteMiss 传的是字符串数组（'A. 甲'），fpOf 读 op.letter/op.text 全是 undefined，
   选项段一律变成 ':'，于是同题干不同选项的题算出同一个指纹。 */
test('不同选项的两道题不能合并（指纹必须可区分）', () => {
  const a = { type: '单选', stem: '下列说法正确的是', options: ['A. 甲', 'B. 乙'] };
  const b = { type: '单选', stem: '下列说法正确的是', options: ['A. 丙', 'D. 丁'] };
  assert.notEqual(pending.fpOf(a), pending.fpOf(b), '选项不同，指纹必须不同');
  /* 对象形态（新 noteMiss 传的就是这个）也要能区分 */
  const c = { type: '单选', stem: '下列说法正确的是', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }] };
  const d = { type: '单选', stem: '下列说法正确的是', options: [{ letter: 'A', text: '丙' }, { letter: 'D', text: '丁' }] };
  assert.notEqual(pending.fpOf(c), pending.fpOf(d), '对象形态同样要能区分');
  /* 同题同选项 → 指纹必须一致（去重要照旧生效） */
  assert.equal(pending.fpOf(a), pending.fpOf({ type: '单选', stem: '下列说法正确的是', options: ['A. 甲', 'B. 乙'] }));
});
