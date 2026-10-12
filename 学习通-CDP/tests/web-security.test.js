'use strict';

/* 网页控制台入口闸门的离线测试（审查第 1 条）
 *
 * 覆盖：
 *   Host  —— 域名重绑定、端口不符、Host 缺失
 *   Origin —— 精确匹配自身（含动态端口）、"看起来像本机"的域名挡不挡得住
 *   token —— 随机生成、timingSafeEqual、缺失/错误
 *   Content-Type —— 只认 application/json（简单请求能用的类型全拒）
 *   体积 —— 413；坏 JSON —— 400（**不能**默默变成 {}）
 *   通过 —— 正确请求要能过，且拒绝的请求**不产生任何副作用**
 *
 * 全部离线：不连浏览器、不读用户配置、不读用户日志、不起真服务器。
 *     node tests/web-security.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const sec = require('../web-security.js');

const PORT = 8899;          // 故意不是默认的 8898：端口是动态选的
const TOKEN = 'a'.repeat(64);

function req(over) {
  const o = over || {};
  const headers = Object.assign({
    host: '127.0.0.1:' + PORT,
    origin: 'http://127.0.0.1:' + PORT,
    'content-type': 'application/json',
    'x-dsh-console-token': TOKEN,
  }, o.headers || {});
  /* headers 里显式给 null 表示"这个头不存在" */
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  return { method: o.method || 'GET', url: o.url || '/api/state', headers };
}

function verify(over, opts) {
  return sec.verifyRequest(req(over), Object.assign({ port: PORT, token: TOKEN }, opts || {}));
}

/* ===========================================================================
 * Host
 * ========================================================================*/

test('本机 Host（含动态端口）放行', () => {
  assert.equal(sec.checkHost('127.0.0.1:' + PORT, PORT).ok, true);
  assert.equal(sec.checkHost('localhost:' + PORT, PORT).ok, true);
  assert.equal(sec.checkHost('[::1]:' + PORT, PORT).ok, true);
  assert.equal(sec.checkHost('LOCALHOST:' + PORT, PORT).ok, true, '大小写不该影响判断');
  assert.equal(sec.checkHost('localhost.:' + PORT, PORT).ok, true, '末尾点是合法的绝对域名写法，规范化后仍是本机');
});

test('域名重绑定：攻击者域名一律 403，哪怕字符串里含 127.0.0.1', () => {
  for (const h of ['evil.test:' + PORT, '127.0.0.1.evil.test:' + PORT, 'localhost.evil.test:' + PORT,
                   'evil.test', 'attacker.localhost:' + PORT]) {
    const r = sec.checkHost(h, PORT);
    assert.equal(r.ok, false, h + ' 必须被拒');
    assert.equal(r.status, 403);
    assert.equal(r.code, 'HOST_NOT_LOCAL');
  }
});

test('Host 缺失 → 403（不给"没写就当你本机"的方便）', () => {
  const r = sec.checkHost('', PORT);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'HOST_MISSING');
  assert.equal(r.status, 403);
});

test('Host 端口必须跟实际监听端口一致（含"没写端口"）', () => {
  const r1 = sec.checkHost('127.0.0.1:1', PORT);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'PORT_MISMATCH');
  assert.equal(r1.status, 403);
  const r2 = sec.checkHost('127.0.0.1', PORT);
  assert.equal(r2.ok, false, '没写端口也算不匹配 —— 默认端口不是这个进程');
  assert.equal(r2.code, 'PORT_MISMATCH');
  const r3 = sec.checkHost('127.0.0.1:abc', PORT);
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'PORT_MISMATCH');
});

/* ===========================================================================
 * Origin
 * ========================================================================*/

test('Origin 精确匹配自身 origin（含动态端口）', () => {
  assert.equal(sec.checkOrigin({ headers: { origin: 'http://127.0.0.1:' + PORT } }, 'http://127.0.0.1:' + PORT).ok, true);
  const bad = sec.checkOrigin({ headers: { origin: 'http://127.0.0.1:8898' } }, 'http://127.0.0.1:' + PORT);
  assert.equal(bad.ok, false, '端口不同就不是同一个源');
  assert.equal(bad.code, 'ORIGIN_MISMATCH');
});

test('Origin 里"看起来像本机"的域名也要拒（不能只做子串匹配）', () => {
  const self = 'http://127.0.0.1:' + PORT;
  for (const o of ['http://127.0.0.1.evil.test:' + PORT, 'http://localhost.evil.test:' + PORT, 'null', 'not-a-url']) {
    const r = sec.checkOrigin({ headers: { origin: o } }, self);
    assert.equal(r.ok, false, o + ' 必须被拒');
    assert.equal(r.status, 403);
  }
});

test('Origin 缺失 → 403；Referer 可以顶替但同样要精确', () => {
  const missing = sec.checkOrigin({ headers: {} }, 'http://127.0.0.1:' + PORT);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'ORIGIN_MISSING');
  const viaRef = sec.checkOrigin({ headers: { referer: 'http://127.0.0.1:' + PORT + '/index.html' } }, 'http://127.0.0.1:' + PORT);
  assert.equal(viaRef.ok, true, 'Referer 是完整 URL，比较的是它的 origin');
  const badRef = sec.checkOrigin({ headers: { referer: 'http://evil.test/x' } }, 'http://127.0.0.1:' + PORT);
  assert.equal(badRef.ok, false);
});

test('自身 origin 从 Host 头拼出来（写死 8898 会在换端口时把自己挡在外面）', () => {
  assert.equal(sec.selfOriginFromHost('127.0.0.1:' + PORT, 8898), 'http://127.0.0.1:' + PORT);
  assert.equal(sec.selfOriginFromHost('[::1]:' + PORT, 8898), 'http://[::1]:' + PORT);
  assert.equal(sec.selfOriginFromHost('evil.test:' + PORT, 8898), null);
});

/* ===========================================================================
 * token
 * ========================================================================*/

test('token 是随机生成的，两次不一样，长度够', () => {
  const a = sec.makeToken(32);
  const b = sec.makeToken(32);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, '必须是随机的 —— 固定 token 等于没有 token');
});

test('比较用 timingSafeEqual，且长度不同直接判否', () => {
  assert.equal(sec.safeEqual('abc', 'abc'), true);
  assert.equal(sec.safeEqual('abc', 'abd'), false);
  assert.equal(sec.safeEqual('abc', 'abcd'), false);
  assert.equal(sec.safeEqual('', ''), false, '空 token 永远不算匹配');
  assert.equal(sec.safeEqual(undefined, undefined), false);
  /* 实现必须走 crypto.timingSafeEqual —— 用 === 会被计时攻击逐字符猜出来。 */
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'web-security.js'), 'utf8');
  assert.ok(src.includes('timingSafeEqual'), 'safeEqual 必须用 timingSafeEqual');
});

test('token 只从自定义头取：query / Cookie 都不算', () => {
  const viaQuery = sec.checkToken({ headers: {}, url: '/api/state?token=' + TOKEN }, TOKEN);
  assert.equal(viaQuery.ok, false);
  assert.equal(viaQuery.code, 'TOKEN_MISSING');
  const viaCookie = sec.checkToken({ headers: { cookie: 'token=' + TOKEN } }, TOKEN);
  assert.equal(viaCookie.ok, false, 'Cookie 在 rebinding 场景下会被带上，不能当凭据');
  assert.equal(viaCookie.code, 'TOKEN_MISSING');
  const good = sec.checkToken({ headers: { 'x-dsh-console-token': TOKEN } }, TOKEN);
  assert.equal(good.ok, true);
});

/* ===========================================================================
 * Content-Type
 * ========================================================================*/

test('只认 application/json（简单请求能用的类型全拒 → 415）', () => {
  assert.equal(sec.isJsonContentType('application/json'), true);
  assert.equal(sec.isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(sec.isJsonContentType('APPLICATION/JSON'), true);
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data',
                    'text/json', 'application/jsonp', '', undefined]) {
    const r = sec.checkContentType({ headers: { 'content-type': ct } });
    assert.equal(r.ok, false, String(ct) + ' 必须被拒');
    assert.equal(r.status, 415, String(ct) + ' 的状态码必须是 415');
  }
});

/* ===========================================================================
 * 体积 / JSON
 * ========================================================================*/

test('声明体积超限 → 413', () => {
  const r = sec.checkSize(String(sec.DEFAULT_MAX_BODY + 1), sec.DEFAULT_MAX_BODY);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(sec.checkSize(String(sec.DEFAULT_MAX_BODY), sec.DEFAULT_MAX_BODY).ok, true);
  assert.equal(sec.checkSize(undefined, sec.DEFAULT_MAX_BODY).ok, true, '没声明长度就交给读的时候兜');
});

test('坏 JSON → 400，绝不能默默当成 {}', () => {
  const r = sec.parseJsonBody(Buffer.from('{"action":', 'utf8'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'BAD_JSON');
  assert.equal(r.value, undefined, '失败时不能给出一个空对象顶替');
});

test('空体与"不是对象"的 JSON 也拒', () => {
  assert.equal(sec.parseJsonBody(Buffer.alloc(0)).status, 400);
  assert.equal(sec.parseJsonBody(Buffer.from('   ', 'utf8')).code, 'EMPTY_BODY');
  assert.equal(sec.parseJsonBody(Buffer.from('[]', 'utf8')).code, 'BAD_JSON');
  assert.equal(sec.parseJsonBody(Buffer.from('123', 'utf8')).code, 'BAD_JSON');
  assert.equal(sec.parseJsonBody(Buffer.from('null', 'utf8')).code, 'BAD_JSON');
});

test('合法 JSON 对象照常解析（BOM 也认）', () => {
  const r = sec.parseJsonBody(Buffer.from('\uFEFF{"action":"stop","dry":false}', 'utf8'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { action: 'stop', dry: false });
});

/* ===========================================================================
 * readBody（传输层）
 * ========================================================================*/

function fakeReq(chunks, opts) {
  const o = opts || {};
  const r = new Readable({ read() {} });
  r.headers = o.headers || {};
  r.destroyed = false;
  const origDestroy = r.destroy.bind(r);
  r.destroy = (e) => { r.destroyed = true; return origDestroy(); };
  setImmediate(() => {
    for (const c of chunks) {
      if (r.destroyed) return;
      r.push(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
    }
    /* end:false 用来模拟"流还没结束"（超限、断连这类场景）——
       否则流自己 end + autoDestroy 会把 destroyed 置真，掩盖"是谁拆的 socket"。 */
    if (o.end !== false && !r.destroyed) r.push(null);
  });
  return r;
}

test('readBody：超限时立刻回 413（不是"空对象"），且不得在这之前拆 socket', async () => {
  const big = Buffer.alloc(1024, 0x61);
  const r0 = fakeReq([big, big, big], { end: false });
  const r = await sec.readBody(r0, { maxBytes: 2048 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(r.code, 'TOO_LARGE');
  assert.equal(r.oversized, true, '要带 oversized 标记，处理器才知道这个连接不能复用、要 Connection: close');
  assert.ok(r.received > 2048, '要把"收到了多少字节"说出来，方便排错');
  /* 【关键回归】老实现先 req.destroy() 再 resolve，真实客户端只看到 ECONNRESET，
     413 根本没机会发出去。超限时不许碰 socket —— 收尾交给响应写完之后的
     Connection: close（见 needsConnectionClose）。 */
  assert.equal(r0.destroyed, false, '超限时不能在响应发出之前 destroy socket');
  assert.equal(sec.needsConnectionClose(r, { method: 'POST', readableEnded: false }), true);
  r0.destroy();   // 收尾：别让测试进程留着半开的流
});

test('readBody：认定超限之后到来的字节不再进内存，结论也不被后续事件改掉', async () => {
  const r0 = fakeReq([], { end: false });
  const p = sec.readBody(r0, { maxBytes: 8 });
  setImmediate(() => {
    r0.push(Buffer.alloc(64, 0x61));            // 超限
    r0.push(Buffer.alloc(1024 * 1024, 0x61));   // 后面再来 1MB，必须被丢弃
  });
  const r = await p;
  assert.equal(r.status, 413);
  assert.equal(r.oversized, true);
  /* 继续读一会儿：后续事件不许把结论改掉、也不许抛 */
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.status, 413);
  r0.destroy();
});

test('readBody：坏 JSON → 400；好 JSON → 值', async () => {
  const bad = await sec.readBody(fakeReq(['{"a":']), { maxBytes: 4096 });
  assert.equal(bad.status, 400);
  const good = await sec.readBody(fakeReq(['{"action":"decode"}']), { maxBytes: 4096 });
  assert.equal(good.ok, true);
  assert.equal(good.value.action, 'decode');
});

test('readBody：连接中断也要给出结论，不能永远挂着', async () => {
  const r = fakeReq([], { end: false });
  const p = sec.readBody(r, { maxBytes: 4096 });
  setImmediate(() => r.emit('aborted'));
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.code, 'ABORTED', '中断和"坏 JSON"要分开报，否则排错时看不出是谁的问题');
  r.destroy();
});

test('readBody：只有 close（没有 end / aborted）也必须收口', async () => {
  const r = fakeReq([], { end: false });
  const p = sec.readBody(r, { maxBytes: 4096 });
  setImmediate(() => r.emit('close'));
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.code, 'ABORTED');
  r.destroy();
});

test('readBody：结论只有一个，重复事件不会二次 resolve', async () => {
  const r = fakeReq(['{"a":1}']);
  let calls = 0;
  const p = sec.readBody(r, { maxBytes: 4096 }).then((v) => { calls += 1; return v; });
  const res = await p;
  r.emit('error', new Error('迟到的错误'));
  r.emit('aborted');
  r.emit('close');
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(res.ok, true);
  assert.equal(calls, 1, 'resolve 只能发生一次');
});

/* ===========================================================================
 * 总闸门：顺序与副作用
 * ========================================================================*/

test('三道闸谁先谁后：Host → Content-Type → Origin → token', () => {
  /* 全部条件齐备 → 通过 */
  const ok = verify({ method: 'POST' });
  assert.equal(ok.ok, true);

  /* 审查要求的三个"必须 403"用例 */
  const noOrigin = verify({ method: 'POST', headers: { origin: null, referer: null } });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.code, 'ORIGIN_MISSING');

  const evilOrigin = verify({ method: 'POST', headers: { origin: 'http://evil.test' } });
  assert.equal(evilOrigin.status, 403);
  assert.equal(evilOrigin.code, 'ORIGIN_MISMATCH');

  const noToken = verify({ method: 'POST', headers: { 'x-dsh-console-token': null } });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.code, 'TOKEN_MISSING');

  /* 顺序：Origin 不合法时即便 token 也错，报的应该是 Origin（先说最外层那道） */
  const bothBad = verify({ method: 'POST', headers: { origin: 'http://evil.test', 'x-dsh-console-token': null } });
  assert.equal(bothBad.code, 'ORIGIN_MISMATCH');

  /* Content-Type 排在最前（在 Origin 之前）：415 而不是 403 */
  const badCt = verify({ method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://evil.test' } });
  assert.equal(badCt.status, 415);
});

test('GET 状态/文件同样要 token（这是"别的网页读不到状态"的根据）', () => {
  const r = verify({ method: 'GET', url: '/api/state', headers: { 'x-dsh-console-token': null } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  const f = verify({ method: 'GET', url: '/api/file?f=log', headers: { 'x-dsh-console-token': 'b'.repeat(64) } });
  assert.equal(f.ok, false);
  assert.equal(f.code, 'TOKEN_BAD');
});

test('GET 不看 Origin（本机直接打开页面也该能用），但 Host 一定要对', () => {
  const r = verify({ method: 'GET', headers: { origin: null, referer: null } });
  assert.equal(r.ok, true);
  const rebind = verify({ method: 'GET', headers: { host: 'evil.test:' + PORT } });
  assert.equal(rebind.ok, false);
  assert.equal(rebind.code, 'HOST_NOT_LOCAL');
});

/* ===========================================================================
 * 响应头与页面注入
 * ========================================================================*/

test('公共响应头必须有 no-store / nosniff / CSP', () => {
  const h = sec.securityHeaders();
  assert.match(h['Cache-Control'], /no-store/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.match(h['Content-Security-Policy'], /default-src 'none'/);
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Cross-Origin-Resource-Policy'], 'same-origin');
});

test('跨源不给 CORS 许可头（同一源预检才给）', () => {
  const self = 'http://127.0.0.1:' + PORT;
  assert.deepEqual(sec.corsHeadersFor('http://evil.test', self), {});
  assert.deepEqual(sec.corsHeadersFor(undefined, self), {});
  assert.equal(sec.corsHeadersFor(self, self)['Access-Control-Allow-Origin'], self);
});

test('token 注入：只注入十六进制 token，别的一律洗掉', () => {
  const html = 'var TOKEN = \'__CONSOLE_TOKEN__\';';
  const out = sec.injectToken(html, 'deadbeef');
  assert.equal(out, "var TOKEN = 'deadbeef';");
  assert.equal(sec.injectToken(html, 'DEADBEEF'), "var TOKEN = 'DEADBEEF';");
  /* 万一有人把带引号/换行的东西塞进来（真有 token 就不可能，但别让它变成注入洞）： */
  const nasty = sec.injectToken(html, "x';alert(1);//");
  assert.equal(nasty.indexOf("'"), 12, '注入点之后只剩一个收尾引号');
  assert.equal(nasty.indexOf(';alert'), -1, '分号/括号这类字符必须被洗掉');
  assert.equal(sec.injectToken(html, ''), "var TOKEN = '';");
});

test('拒绝的请求：状态码、错误码、人话三样都有', () => {
  const r = sec.checkHost('evil.test:' + PORT, PORT);
  assert.equal(typeof r.status, 'number');
  assert.ok(r.code);
  assert.ok(r.message.length > 5, '错误提示要是给人看的，不能只是一串码');
  assert.equal(sec.ERROR_STATUS[r.code], r.status, '错误码 → 状态码的映射要一致');
});

/* ===========================================================================
 * 与 runtime-processes.js 的接口必须对得上
 *
 * 网页控制台按固定契约调用另一个模块（那个文件不归我改）：
 *   readVerifiedDriver(baseDir)  同步  -> {pid, alive, verified, reason}
 *   stopVerifiedDriver(baseDir)  async -> {ok, pid, reason}
 *   recordOwnedEdge({baseDir,pid,profileDir,port})  async -> {ok, reason}
 *   stopOwnedEdge({baseDir,profileDir,port})        async -> {ok, count, reason}
 * 契约一旦漂移（改名、改同步/异步、改字段、把 alive 和 verified 合并），
 * 控制台会静默地"以为没在跑"或者"以为有所有权" —— 这两件事都会伤人。
 * 所以这里直接对着真实模块核一遍（只读导出，不调用、不起进程）。
 * ========================================================================*/

test('runtime-processes.js 的四个契约函数存在且签名一致', () => {
  let rp = null;
  try { rp = require('../runtime-processes.js'); } catch (e) { rp = null; }
  if (!rp) {
    /* 那个文件还没到位时不算失败，但要在输出里说清楚 */
    console.log('（runtime-processes.js 还不在，跳过接口核对）');
    return;
  }
  for (const name of ['readVerifiedDriver', 'stopVerifiedDriver', 'recordOwnedEdge', 'stopOwnedEdge']) {
    assert.equal(typeof rp[name], 'function', '缺少契约函数 ' + name);
  }
  assert.ok(rp.readVerifiedDriver.length >= 1, 'readVerifiedDriver 要接 baseDir');
  assert.ok(rp.stopVerifiedDriver.length >= 1, 'stopVerifiedDriver 要接 baseDir');
  /* readVerifiedDriver 必须是**同步**的：控制台在 apiState 里直接 await 它，
     如果哪天它改成返回 Promise，await 也能工作，所以这里只提示不强制。 */
  const r = rp.readVerifiedDriver(require('node:path').join(__dirname, '..'));
  assert.equal(typeof r, 'object');
  for (const k of ['pid', 'alive', 'verified', 'reason']) {
    assert.ok(k in r, 'readVerifiedDriver 的返回里必须有 ' + k + '（字段名漂了会让控制台读成"没在跑"）');
  }
  assert.equal(typeof r.alive, 'boolean');
  assert.equal(typeof r.verified, 'boolean');
  assert.equal(typeof r.reason, 'string');
});

test('控制台判定"在跑"必须同时要求 alive && verified（不能只看 alive）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '网页控制台.js'), 'utf8');
  assert.ok(src.includes('running: alive && verified'), 'alive 单独不足以判定"在跑"，PID 会被复用');
  assert.ok(src.includes('drv.running'), 'live 状态必须由 running 推出来');
  assert.equal(/if \(drv\.alive\) live =/.test(src), false, '不能再用裸 alive 判定运行中');
  /* 没有所有权凭据时不许自己拼 taskkill */
  assert.equal(/taskkill['"], *\['\/f'/.test(src), false, '控制台里不该再有 taskkill 调用');
});


/* ===========================================================================
 * 前端调用与后端路由必须对得上（改了闸门最容易在这里出漏子）
 * ========================================================================*/

test('页面里每个 api() 路径后端都处理得到（加了闸门也不能把前端挡死）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '网页控制台.js'), 'utf8');

  /* 前端：api('/api/xxx') 或 api("/api/xxx?…") */
  const called = new Set();
  const reCall = /api\(\s*['"](\/api\/[a-z]+)/g;
  let m;
  while ((m = reCall.exec(src))) called.add(m[1]);
  assert.ok(called.size >= 3, '至少应该找到状态/文件/配置/动作这几个调用，实际只找到 ' + called.size);

  /* 后端：路由里的 '/api/xxx' 字面量 */
  const routes = new Set();
  const reRoute = /['"](\/api\/[a-z]+)['"]/g;
  while ((m = reRoute.exec(src))) routes.add(m[1]);

  for (const p of called) {
    assert.ok(routes.has(p), '页面在调 ' + p + '，但服务端没有这个路由');
  }
  for (const p of ['/api/state', '/api/file', '/api/config', '/api/action']) {
    assert.ok(called.has(p), p + ' 没被前端用到？那这个路由要么多余、要么前端漏调');
  }
  /* /api/ping 是给外部探活用的（前端不调），但它同样在闸门之后 */
  assert.ok(src.includes("'/api/ping'"), '探活路由要么留着、要么彻底删掉 —— 现在必须在闸门之后');
});

test('token 头名前后端一致，且注入占位符在页面里', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '网页控制台.js'), 'utf8');
  assert.ok(src.includes("'X-Dsh-Console-Token'"), '前端必须把 token 放在 x-dsh-console-token 头里');
  assert.equal(sec.TOKEN_HEADER, 'x-dsh-console-token');
  assert.ok(src.includes('__CONSOLE_TOKEN__'), '页面里要有注入占位符，否则前端拿不到 token');
  assert.ok(src.includes('sec.injectToken(PAGE, CONSOLE_TOKEN)'), '入口 GET 必须走 injectToken');
});

test('/api/state 的响应体里不能出现 token 或 key（只有遮罩）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '网页控制台.js'), 'utf8');
  const i = src.indexOf('async function apiState()');
  const j = src.indexOf('\n/* ============', i);
  assert.ok(i > 0 && j > i, '要能定位到 apiState');
  const body = src.slice(i, j);
  assert.equal(body.indexOf('CONSOLE_TOKEN'), -1, 'apiState 里绝不能回显访问 token');
  assert.ok(body.includes('keyMask: maskKey(effKey)'), 'key 只能以遮罩形式出去');
  assert.equal(/apiKey:\s*cfg\.apiKey/.test(body), false, 'apiState 里不能直接回传原始 key');
});
