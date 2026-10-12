/* API 网关地址可自定义（默认 DeepSeek）—— 2026-10-12 法师要求。
   这里的用例只干两件事：
     ① 把 apiUrlOf / maskApiUrl 的规则钉死（默认、自定义、写错回落、查询串打码）；
     ② 用源码契约钉住"三处调用都走 apiUrlOf(cfg)"，防止以后有人又写死地址。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const Q = require(path.join(ROOT, '答题助手.js'));
/* 项目里的用例用的都是 node:test + assert/strict（不是自己写的 test 壳） */

test('默认就是 DeepSeek：没配 / 空 / 空格 → 一律回落默认', () => {
  assert.equal(Q.API_URL, 'https://api.deepseek.com/chat/completions', '默认地址常量必须是 DeepSeek 官方');
  assert.equal(Q.DEFAULT_CFG.apiUrl, Q.API_URL, '默认配置里就该是 DeepSeek');
  assert.equal(Q.apiUrlOf({}), Q.API_URL, '{} → 默认');
  assert.equal(Q.apiUrlOf(null), Q.API_URL, 'null → 默认');
  assert.equal(Q.apiUrlOf({ apiUrl: '' }), Q.API_URL, '空串 → 默认');
  assert.equal(Q.apiUrlOf({ apiUrl: '   ' }), Q.API_URL, '全空格 → 默认');
});

test('配了就用配的（整条 URL，路径由用户说了算 —— 中转常写 /v1/chat/completions）', () => {
  const gw = 'https://gw.example/v1/chat/completions';
  assert.equal(Q.apiUrlOf({ apiUrl: gw }), gw);
  assert.equal(Q.apiUrlOf({ apiUrl: '  ' + gw + '  ' }), gw, '首尾空白要修掉');
  assert.equal(Q.apiUrlOf({ apiUrl: 'http://127.0.0.1:3000/v1/chat/completions' }), 'http://127.0.0.1:3000/v1/chat/completions', '本机网关也允许');
});

test('写错（不是 http(s)）→ 回落默认，而不是"照着错的发"', () => {
  for (const bad of ['ftp://x/y', 'api.deepseek.com/chat/completions', 'javascript:alert(1)', 'ws://x/y']) {
    assert.equal(Q.apiUrlOf({ apiUrl: bad }), Q.API_URL, bad + ' 应当回落默认');
  }
});

test('显示时要打码：URL 里带 token 的网关不许把查询串打进日志', () => {
  assert.equal(Q.maskApiUrl('https://gw.example/v1/chat'), 'https://gw.example/v1/chat', '没有查询串就原样');
  assert.equal(Q.maskApiUrl('https://gw.example/v1/chat?key=SECRET'), 'https://gw.example/v1/chat?…（查询串已隐藏）');
  assert.ok(Q.maskApiUrl('https://gw.example/v1/chat?token=SECRET').indexOf('SECRET') < 0, 'token 不许露出来');
});

test('源码契约：三处 API 调用都必须走 apiUrlOf(cfg)，不许再写死', () => {
  const src = fs.readFileSync(path.join(ROOT, '答题助手.js'), 'utf8');
  const n = (src.match(/fetchWithTimeout\(apiUrlOf\(cfg\),/g) || []).length;
  assert.equal(n, 3, '问答/直接问/看图 三处都要用配置里的地址，现在是 ' + n + ' 处');
  assert.equal((src.match(/fetchWithTimeout\(API_URL,/g) || []).length, 0, '不许再有写死的 fetch(API_URL)');
  assert.match(src, /function apiUrlOf\(cfg\)/, '规则集中在 apiUrlOf 里，别处别自己拼');
});

test('源码契约：控制台与命令行都要能改这个地址，而且都要校验 http(s)', () => {
  const web = fs.readFileSync(path.join(ROOT, '网页控制台.js'), 'utf8');
  assert.match(web, /patch\.apiUrl !== undefined/, '控制台要认这个字段');
  assert.match(web, /网关地址必须以 http:\/\/ 或 https:\/\/ 开头/, '控制台要拦下非 http(s)');
  assert.match(web, /id="apiUrl"/, '界面上要有输入框');
  assert.match(web, /function resetApiUrl\(\)/, '要能一键恢复默认');
  const cli = fs.readFileSync(path.join(ROOT, '配置.js'), 'utf8');
  assert.match(cli, /case 'apiUrl': \{/, '命令行要能 --set apiUrl=…');
  assert.match(cli, /网关地址必须以 http:\/\/ 或 https:\/\/ 开头/, '命令行也要拦');
  assert.match(cli, /网关地址       /, '--show 里要看得到');
});

test('打包契约：网关配置跟着包走（示例配置里能看到这个键）', () => {
  const p = path.join(ROOT, '_实验', '_打包临时', '答题设置.json.示例');
  if (!fs.existsSync(p)) return;                 /* 打包目录不在这台机器上就跳过 */
  const txt = fs.readFileSync(p, 'utf8');
  assert.match(txt, /apiUrl/, '示例配置里应当有这个键，方便别人照着填');
});
