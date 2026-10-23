/* quiz-accounting.test.js —— 记账不翻倍（2026-10-23 核实后修的回归）
 *
 * 实证：归档日志里 2.4 章节测验那一章写的是「10 道题，本轮欠 20 道」。
 * 根因：noteMiss 里既 `cfg.stats.missed++`，又调 `cfg.onUnanswered(...)`，
 * 而 driver 的 recordMiss 里**也** `quizStats.missed++` ——
 * 而 attachQuizBookkeeping 把 cfg.stats 直接赋成 quizStats，两者是**同一个对象**。
 * 于是每道没做成的题都记两次欠账。
 *
 * 这条用例只做一件事：一题没做成 → missed 只加 1、onUnanswered 只回调 1 次。
 * 跑法：node --test tests\quiz-accounting.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const quiz = require(path.join(ROOT, '答题助手.js'));

const REAL = {
  cache: quiz.ANSWER_CACHE_FILE,
  out: quiz.OUT_FILE,
  cfg: quiz.CFG_FILE,
  fetch: globalThis.fetch,
};

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-accounting-'));
  quiz.ANSWER_CACHE_FILE = path.join(dir, '缓存.json');
  quiz.OUT_FILE = path.join(dir, '记录.txt');
  quiz.CFG_FILE = path.join(dir, '配置.json');
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      quiz.ANSWER_CACHE_FILE = REAL.cache;
      quiz.OUT_FILE = REAL.out;
      quiz.CFG_FILE = REAL.cfg;
      globalThis.fetch = REAL.fetch;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    });
}

test('一题没做成 → missed 只加 1、onUnanswered 只回调 1 次（修复前是 2）', async () => {
  await withTmp(async () => {
    const stats = { chapters: 0, found: 0, filled: 0, missed: 0, saveConfirmed: 0, saveUnconfirmed: 0, saveFailed: 0 };
    let cb = 0;
    let cbStem = '';
    const cfg = {
      mode: 2, apiKey: '假key-不是真的', model: 'fm', visionModel: 'fvm',
      readMode: 'auto', maxShots: 1, autoFill: false, useAnswerCache: false, maxPerChapter: 30,
      stats: stats,
      /* 模拟 driver 的 recordMiss：它里面就是 quizStats.missed++（和 cfg.stats 同一个对象） */
      onUnanswered: (rec) => { cb++; cbStem = String((rec && rec.stem) || ''); stats.missed++; },
    };
    /* 模型答"不确定" → parseAnswer 返回 null → 走 noteMiss('模型无法确定答案') */
    globalThis.fetch = async () => ({
      ok: true, status: 200, __apiAttempts: 1,
      json: async () => ({ choices: [{ message: { content: '1. 不确定' } }], usage: {} }),
      text: async () => '',
    });
    const ev = async (expr) => {
      const s = String(expr);
      if (s.indexOf('var BY = "probe";') >= 0) return { ok: true, n: 1, vis: 1, probe: true, docs: 1 };
      return { ok: false, why: '定位不到（mock）', n: 1 };
    };
    const helper = quiz.makeHelper(cfg, { ev: ev, shot: async () => '', clickAt: null, reopenQuiz: null });
    const probe = {
      found: 1, obfCount: 0, fontB64: '', graded: false, docCount: 1,
      questions: [{
        type: '单选',
        stem: '账目用例-9F3K 这段题干题库里没有',
        options: [{ letter: 'A', text: '选项甲Q1' }, { letter: 'B', text: '选项乙Q2' }],
        obf: false,
      }],
    };
    await helper.handle('账目测试章', probe, () => {});

    assert.equal(cb, 1, 'onUnanswered 只该回调 1 次（待补清单不能重复入库）');
    assert.equal(stats.missed, 1, '欠账只该加 1（曾经是 2：noteMiss 加一次、recordMiss 再加一次）');
    assert.equal(Number(stats.filled) || 0, 0, '一题也没填上');
    assert.match(cbStem, /账目用例/, '回调里带的是这道题的题干');
  });
});
