#!/usr/bin/env node
/* quiz-api-timeout.test.js —— "正文读取不能脱离超时保护"的离线回归测试
 *
 * 背景（2026-10-15 · Codex 报告，属实）：
 *   答题助手.js 的 fetchWithTimeout 原来在**响应头到手**时就把定时器清了 ⇒
 *   正文（json/text）读取裸奔：服务器拖正文、或慢速滴流（能骗过默认 body 超时）时，
 *   整个答题流程会长时间挂着 ✗。
 *   修复：定时器一直护到正文读完（包装 json/text/arrayBuffer/blob，读完才 clear）。
 *
 * 这个文件用本地假服务器复现三种场景（不连外网、不读真实配置）：
 *   1. 正常接口 —— 包装不能把好的弄坏（正文照常读得到）
 *   2. 头到手后正文卡死（stall）—— 必须在超时内抛错
 *   3. 正文慢速滴流（trickle）—— 同样必须在超时内结束
 *
 * 判定方式：正文读取外面套一个 5 秒护栏；旧代码会挂到护栏才结束（ms≈5000 ⇒ 断言红），
 * 新代码会在 ~800ms 被 abort 打断（ms<3000 ⇒ 断言绿）。
 *
 * 用法：node tests\quiz-api-timeout.test.js
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const Q = require(path.join(__dirname, '..', '答题助手.js'));

let server = null;
let base = '';

before(() => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '可以' } }] }));
      return;
    }
    if (req.url === '/stall') {
      /* 头到手、正文永不来：旧代码在这里挂住（定时器已被清） */
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"a":');
      return;                                    /* 故意不 end */
    }
    if (req.url === '/trickle') {
      /* 每 300ms 滴一个字节：能骗过"默认 body 超时"的经典场景 */
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
      const drip = setInterval(() => { try { res.write('x'); } catch (e) {} }, 300);
      res.on('close', () => clearInterval(drip));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; resolve(); });
}));

after(() => new Promise((resolve) => {
  try { server.closeAllConnections(); } catch (e) {}
  server.close(() => resolve());
}));

/* 护栏：正文读取最多等 5 秒；超了返回一个显眼的哨兵错误（旧代码会走到这里） */
const raceRead = (p, ms) => Promise.race([
  p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
  new Promise((r) => setTimeout(() => r({ ok: false, e: new Error('TIMEOUT_GUARD_5S') }), ms))
]);

test('对照：正常接口正文读得完（包装不能把好的弄坏）', async () => {
  const r = await Q.fetchWithTimeout(base + '/ok', {}, { timeoutMs: 3000 });
  const j = await r.json();
  assert.equal(j.choices[0].message.content, '可以');
});

test('★ 头到手后正文卡死(stall)：必须在超时内失败，不许挂住', async () => {
  const r = await Q.fetchWithTimeout(base + '/stall', {}, { timeoutMs: 800 });
  const t0 = Date.now();
  const out = await raceRead(r.json(), 5000);
  const ms = Date.now() - t0;
  assert.equal(out.ok, false, '正文永远不来的话，读取必须失败而不是悬挂');
  assert.ok(ms < 3000, '必须在超时保护内结束（实测 ' + ms + 'ms）—— 挂到 5 秒护栏说明正文脱离了超时保护');
});

test('★ 正文慢速滴流(trickle)：同样要在超时内结束', async () => {
  const r = await Q.fetchWithTimeout(base + '/trickle', {}, { timeoutMs: 800 });
  const t0 = Date.now();
  const out = await raceRead(r.json(), 5000);
  const ms = Date.now() - t0;
  assert.equal(out.ok, false, '滴流正文必须被保护性打断（旧代码会一直等下去）');
  assert.ok(ms < 3000, '必须在超时保护内结束（实测 ' + ms + 'ms）');
});
