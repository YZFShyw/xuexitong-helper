'use strict';

/* 网页控制台的**真实 HTTP** 回归（合成，全离线）
 *
 * 为什么要有这个文件：
 *   tests/web-security.test.js 里的 readBody 用例喂的是假 req（一个 Readable），
 *   只能证明"返回对象里有 413"。审查复核时发现：老实现超限时先 `req.destroy()`
 *   再 resolve，真实客户端只看到 ECONNRESET —— 那个 413 在响应写出去之前就被
 *   拆掉了 socket，根本没机会上路。假 req 永远看不出这种事。
 *
 *   所以这里起一个**真的** http server，用**同一份生产逻辑**
 *   （web-security.js 的 verifyRequest + readBody + needsConnectionClose），
 *   用真的 http.request 打过去，断言客户端收到的**状态码**。
 *
 * 边界（写死在这里，免得以后有人顺手扩大）：
 *   · 只监听 127.0.0.1 的随机临时端口（listen 0）—— 不碰任何固定端口，
 *     更不会去碰真的 8898，绝不启动 网页控制台.js；
 *   · token 是虚构的常量，不是任何真实凭据；不读用户文件、不碰配置、
 *     不启动浏览器、不访问任何外部地址或课程；
 *   · 处理函数里没有任何真实副作用，只有一个内存里的动作计数器
 *     —— 它存在的意义就是证明"被拒绝的请求一个动作都没执行"。
 *
 *     node tests/web-http.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const sec = require('../web-security.js');

/* 虚构 token：64 个十六进制字符，和真实 token 同形，但内容是自己写的。 */
const TOKEN = 'deadbeef'.repeat(8);
const MAX = sec.DEFAULT_MAX_BODY;

/* 服务端计数：拒绝的请求必须一个动作都不执行。 */
let actions = 0;
let bodyReads = 0;
/* readBody 每次的结论（服务端侧），用来核对"客户端中途跑了"这条路也收口了。 */
const bodyLog = [];

/* ---------------------------------------------------------------------------
 * 被测试的服务端：故意逐条照着 网页控制台.js 的顺序来
 * Host → (POST: Content-Type → Origin) → token → 体积 → readBody → 动作
 * 拒绝的响应也和那边一样：JSON + 需要时 Connection: close。
 * -------------------------------------------------------------------------*/

function writeJson(req, res, status, obj, denyResult) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  };
  if (sec.needsConnectionClose(denyResult || null, req)) headers['Connection'] = 'close';
  res.writeHead(status, headers);
  res.end(body);
}

function deny(req, res, d) {
  writeJson(req, res, d.status, {
    ok: false, error: d.message, code: d.code, detail: d.extra || '',
  }, d);
}

function handler(req, res) {
  const selfPort = req.socket.localPort;   // 就是真实监听的临时端口
  const gate = sec.verifyRequest(req, { port: selfPort, token: TOKEN, maxBody: MAX });
  if (!gate.ok) return deny(req, res, gate);        // 声明超限在这一步就被拒

  if (String(req.method).toUpperCase() === 'GET') {
    return writeJson(req, res, 200, { ok: true, ping: true });
  }
  /* chunked（没声明长度）的超限只有读到一半才知道。 */
  return sec.readBody(req, { maxBytes: MAX }).then((body) => {
    bodyReads += 1;
    bodyLog.push(body.ok ? 'OK' : body.code);
    if (!body.ok) return deny(req, res, body);
    actions += 1;                                    // 只有真正放行的请求才会走到这
    return writeJson(req, res, 200, { ok: true, action: body.value.action, actions });
  }).catch((e) => {
    writeJson(req, res, 500, { ok: false, error: String(e && e.message) });
  });
}

/* ---------------------------------------------------------------------------
 * 客户端：真 http.request，收集状态码 / 头 / body
 * -------------------------------------------------------------------------*/

function post(opt) {
  const o = opt || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:' + port,
      'X-Dsh-Console-Token': TOKEN,
    }, o.headers || {});
    for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];

    const req = http.request({
      host: '127.0.0.1',
      port,
      method: o.method || 'POST',
      path: o.path || '/api/action',
      headers,
    }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(bufs).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 不是 JSON 就留 null，断言会看出来 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    /* 必须在收到响应之前就挂上：真出问题时（老实现就是）这里会收到 ECONNRESET，
       测试要报的是"客户端没收到状态码"，而不是让 promise 永远挂着。 */
    req.on('error', (e) => reject(new Error('客户端连接出错（说明状态码没送达）：' + (e.code || e.message))));

    const chunks = o.chunks || [];
    for (const c of chunks) req.write(c);
    if (o.declaredLength) {
      const buf = Buffer.alloc(o.declaredLength, 0x61);
      req.write(buf);
    }
    req.end(o.body === undefined ? undefined : o.body);
  });
}

/* ---------------------------------------------------------------------------
 * 临时服务器 + socket 清理
 * -------------------------------------------------------------------------*/

let server = null;
let port = 0;
const sockets = new Set();

test.before(async () => {
  server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  /* 随机临时端口，只绑回环。 */
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  assert.ok(port > 0 && port !== 8898, '必须是内核分配的临时端口，且绝不占用真实控制台端口');
});

test.after(async () => {
  for (const s of sockets) { try { s.destroy(); } catch (e) { /* 已经关了 */ } }
  sockets.clear();
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }
});

/* ===========================================================================
 * 1. chunked 累计超限：客户端必须拿到明确 413
 * ========================================================================*/

test('chunked 超限：真实客户端收到 413（不是 ECONNRESET），且动作计数 0', async () => {
  const before = actions;
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const r = await post({ chunks: [chunk, chunk, chunk, '{"action":"stop"}'] });  // 768KB > 512KB

  assert.equal(r.status, 413, '客户端必须真的收到 413，而不是被断连');
  assert.equal(r.json && r.json.code, 'TOO_LARGE');
  assert.equal(r.json && r.json.ok, false);
  assert.equal(r.headers.connection, 'close', '请求体没读完，连接不能复用');
  assert.equal(actions, before, '被拒绝的请求绝不能执行任何动作');
});

test('chunked 超限：一次超大 chunk 也能立刻回 413', async () => {
  const r = await post({ chunks: [Buffer.alloc(MAX * 2, 0x62)] });
  assert.equal(r.status, 413);
  assert.equal(r.json && r.json.code, 'TOO_LARGE');
  assert.equal(actions, 0);
});

/* ===========================================================================
 * 2. 声明的 Content-Length 超限：同样 413，而且一个字节都不读
 * ========================================================================*/

test('声明超限：真实客户端收到 413，且根本没进 readBody（不占内存）', async () => {
  const reads = bodyReads;
  const declared = MAX + 4096;
  const r = await post({
    headers: { 'Content-Length': String(declared) },
    declaredLength: declared,
  });

  assert.equal(r.status, 413, '声明超限也必须是 413，不能只在读到一半时才拒');
  assert.equal(r.json && r.json.code, 'TOO_LARGE');
  assert.equal(r.headers.connection, 'close');
  assert.equal(bodyReads, reads, '声明就超限的请求不该进 readBody');
  assert.equal(actions, 0, '被拒绝的请求绝不能执行任何动作');
});

/* ===========================================================================
 * 3. 坏 JSON：400（不能默默变成 {}），也不执行动作
 * ========================================================================*/

test('坏 JSON：客户端收到 400 BAD_JSON，动作计数 0', async () => {
  const r = await post({ body: '{"action":' });
  assert.equal(r.status, 400);
  assert.equal(r.json && r.json.code, 'BAD_JSON');
  assert.equal(actions, 0, '坏 JSON 不是"空动作"，一个动作都不许跑');
});

/* ===========================================================================
 * 4. 正常对象：200，动作正好跑一次
 * ========================================================================*/

test('正常请求：客户端收到 200，动作跑且只跑一次', async () => {
  const r = await post({ body: JSON.stringify({ action: 'stop', dry: false }) });
  assert.equal(r.status, 200);
  assert.equal(r.json && r.json.ok, true);
  assert.equal(r.json && r.json.action, 'stop');
  assert.equal(actions, 1, '放行的请求要真的执行一次');
});

/* ===========================================================================
 * 5. 顺带用真实连接核一遍闸门没被削弱（Host / token）
 * ========================================================================*/

test('真实连接上：Host 不是本机 → 403；token 不对 → 403；都不执行动作', async () => {
  const badHost = await post({
    headers: { Host: 'evil.test:' + port },
    body: JSON.stringify({ action: 'stop' }),
  });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.json && badHost.json.code, 'HOST_NOT_LOCAL');
  assert.equal(actions, 1, '被 Host 闸门挡下的请求不许执行动作');

  const badToken = await post({
    headers: { 'X-Dsh-Console-Token': 'e'.repeat(64) },
    body: JSON.stringify({ action: 'stop' }),
  });
  assert.equal(badToken.status, 403);
  assert.equal(badToken.json && badToken.json.code, 'TOKEN_BAD');
  assert.equal(actions, 1, 'token 不对的请求不许执行动作');

  const badCt = await post({
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'stop' }),
  });
  assert.equal(badCt.status, 415, 'Content-Type 闸门不能被"真实请求"绕过');
  assert.equal(actions, 1);
});

/* ===========================================================================
 * 6. 客户端发到一半就跑：readBody 必须有结论（不能永远挂着），服务端不能被打死
 * ========================================================================*/

test('客户端发到一半就断：readBody 收口（不永久等待），服务端照旧能干活', async () => {
  const before = actions;
  const settled = bodyReads;

  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/action',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:' + port,
        'X-Dsh-Console-Token': TOKEN,
      },
    }, (res) => { res.resume(); resolve('response'); });
    req.on('error', () => resolve('error'));            // 客户端这边必然会报错，正常
    req.write('{"action":"stop"');                       // 半个 JSON，故意不发完
    setTimeout(() => { req.destroy(); resolve('destroyed'); }, 10);
  });

  /* 服务端必须在有限时间内拿到结论（挂住的话这里会等超时） */
  const deadline = Date.now() + 3000;
  while (bodyReads === settled && Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(bodyReads, settled + 1, 'readBody 必须在连接断开时给出结论，不能永远挂着');
  assert.equal(bodyLog[bodyLog.length - 1], 'ABORTED', '中断要报成 ABORTED（400），跟"坏 JSON"分开');
  assert.equal(actions, before, '没收完的请求不许执行动作');

  /* 服务端还活着：紧接着的正常请求要照常 200 */
  const after = await post({ body: JSON.stringify({ action: 'stop' }) });
  assert.equal(after.status, 200, '处理完断连之后服务端必须照常工作');
  assert.equal(actions, before + 1);
});

/* ===========================================================================
 * 7. 源码契约：这条修复不能被悄悄改回去
 * ========================================================================*/

test('readBody 不得在响应之前 destroy socket；控制台必须把 req 传进 sendDeny', () => {
  const secSrc = fs.readFileSync(path.join(__dirname, '..', 'web-security.js'), 'utf8');
  const bodyStart = secSrc.indexOf('function readBody');
  const bodyEnd = secSrc.indexOf('needsConnectionClose', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, '要能定位到 readBody');
  const readBodySrc = secSrc.slice(bodyStart, bodyEnd);
  assert.equal(/req\.destroy\s*\(/.test(readBodySrc), false,
    'readBody 里不能再 destroy：那会让客户端只看到 ECONNRESET，收不到 413');
  assert.ok(readBodySrc.includes("req.on('close'"),
    "必须有 close 兜底，否则某些断连路径会让 promise 永远挂着");
  assert.equal(typeof sec.needsConnectionClose, 'function');

  const consoleSrc = fs.readFileSync(path.join(__dirname, '..', '网页控制台.js'), 'utf8');
  assert.ok(consoleSrc.includes('sec.needsConnectionClose(d, req)'), 'sendDeny 要按 needsConnectionClose 决定是否关连接');
  assert.ok(consoleSrc.includes('sendDeny(res, gate, req)'), '闸门拒绝要把 req 传下去（体积超限要关连接）');
  assert.ok(consoleSrc.includes('sendDeny(res, body, req)'), 'readBody 拒绝要把 req 传下去');
});

test('needsConnectionClose：读完了可复用，没读完/超限必须关', () => {
  assert.equal(sec.needsConnectionClose({ oversized: true }, { method: 'POST', readableEnded: true }), true);
  assert.equal(sec.needsConnectionClose({ ok: false, code: 'TOO_LARGE' }, { method: 'POST', readableEnded: false }), true,
    '声明超限是在闸门那步拒的，请求体一个字都没读，必须关连接');
  assert.equal(sec.needsConnectionClose({ ok: false, code: 'BAD_JSON' }, { method: 'POST', readableEnded: true }), false,
    '正文读完了（坏 JSON 是读完才知道的），keep-alive 可以留着');
  assert.equal(sec.needsConnectionClose({ ok: false, code: 'HOST_NOT_LOCAL' }, { method: 'GET', readableEnded: false }), false,
    'GET 没有请求体，没必要关连接');
});
