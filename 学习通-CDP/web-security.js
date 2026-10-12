'use strict';

/* 学习通助手 · 网页控制台的入口闸门（纯逻辑，可离线测试）
 *
 * 为什么单独一个文件：
 *   审查报告第 1 条 —— 控制台原来只绑 127.0.0.1 就以为安全了。绑回环只挡得住
 *   "外网的机器"，挡不住**你自己浏览器里的任意一个网页**：任何页面都能对
 *   http://127.0.0.1:8898/api/action 发一个不带预检的简单 POST，于是"关掉所有 Edge、
 *   停掉驱动器、把 API key 覆写成别人的"全都能被一个广告页触发；DNS rebinding
 *   还能让攻击者用自己的域名读 /api/state 和 /api/file。
 *
 *   所以入口要有四道闸，缺一不可：
 *     ① Host 必须是本机名（localhost / 127.0.0.1 / ::1）+ 本进程实际监听的端口
 *        —— 域名 rebinding 打过来的请求 Host 是 evil.test，直接挡掉；
 *     ② 每次启动生成一个随机 token，页面自己带在自定义请求头里；
 *        没有 token 的一律拒绝（自定义头跨源必须要预检，所以别的网页发不出来）；
 *     ③ POST 的 Origin 必须**精确等于**自身 origin（含动态端口）；
 *     ④ POST 的 Content-Type 必须是 application/json。
 *
 * 这个文件里**没有任何 IO**（除了 readBody 这个明确标注的传输层函数），
 * 所以测试不需要起服务器、不碰用户文件。
 *     node tests/web-security.test.js
 */

const crypto = require('crypto');

/* ---------------------------------------------------------------------------
 * 常量：错误码 → 状态码 → 给人看的话
 * 每种拒绝都要有独立的码，测试才能逐条断言"是这道闸挡的"，而不是"碰巧也拒了"。
 * -------------------------------------------------------------------------*/

const ERROR_STATUS = {
  HOST_MISSING: 403,
  HOST_NOT_LOCAL: 403,
  PORT_MISMATCH: 403,
  TOKEN_MISSING: 403,
  TOKEN_BAD: 403,
  ORIGIN_MISSING: 403,
  ORIGIN_MISMATCH: 403,
  CONTENT_TYPE: 415,
  BAD_JSON: 400,
  EMPTY_BODY: 400,
  /* 读到一半对方断了（或 socket 出错）。跟"坏 JSON"分开：一个是"你发的东西不对"，
     一个是"话没说完"——混在一起会让排错时看不出到底是谁的问题。状态码同为 400。 */
  ABORTED: 400,
  TOO_LARGE: 413,
  METHOD: 405,
};

const ERROR_TEXT = {
  HOST_MISSING: '请求没有 Host 头 —— 只接受本机地址访问。',
  HOST_NOT_LOCAL: 'Host 不是本机名（域名重绑定会被这一道挡住）。只允许 localhost / 127.0.0.1 / [::1]。',
  PORT_MISMATCH: 'Host 里的端口跟控制台实际监听的端口不一致 —— 拒绝。',
  TOKEN_MISSING: '请求没有带控制台 token（X-Dsh-Console-Token）—— 拒绝。页面要先把控制台页面加载出来，token 是启动时随机生成的。',
  TOKEN_BAD: '控制台 token 不对（可能控制台重启过了，刷新一下页面）。',
  ORIGIN_MISSING: 'POST 没有 Origin 头 —— 拒绝（只认控制台页面自己发的请求）。',
  ORIGIN_MISMATCH: 'Origin 不是控制台自己 —— 拒绝。',
  CONTENT_TYPE: 'POST 只接受 Content-Type: application/json。',
  BAD_JSON: '请求体不是合法 JSON。',
  EMPTY_BODY: '请求体是空的。',
  ABORTED: '请求体没读完，连接就断开或出错了。',
  TOO_LARGE: '请求体太大了。',
  METHOD: '不支持这个请求方法。',
};

/* fields：给拒绝结果挂附加字段（比如超限的 oversized / received）。
   附加字段是**给处理响应的代码看的**，不是给客户端看的。 */
function deny(code, extra, fields) {
  const d = { ok: false, code, status: ERROR_STATUS[code] || 403, message: ERROR_TEXT[code] || '拒绝。', extra: extra || '' };
  if (fields) Object.assign(d, fields);
  return d;
}

/* ---------------------------------------------------------------------------
 * Host
 * -------------------------------------------------------------------------*/

/* 只认这三种本机名。注意要剥掉末尾的点（"localhost." 是合法的绝对域名写法，
   但绝不能让它绕过白名单），并且**不做**任何 DNS 解析 —— 解析了就正好中了
   rebinding 的招。IPv6 回环的 Host 形态是 [::1]:port，方括号要去掉。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHostname(h) {
  let s = String(h === undefined || h === null ? '' : h).trim().toLowerCase();
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return { name: s, hadBrackets: true };
    return { name: s.slice(1, close), hadBrackets: true };
  }
  if (s.endsWith('.')) s = s.replace(/\.+$/, '');
  return { name: s, hadBrackets: false };
}

function isLocalHostName(h) {
  const n = normalizeHostname(h);
  if (!n.name) return false;
  return LOCAL_HOSTS.has(n.name);
}

/* Host 头 → { name, port }。port 是 null 表示没写端口。
   端口解析写成"纯数字才算"，宁可拒也不能瞎猜。 */
function parseHostHeader(host) {
  const raw = String(host === undefined || host === null ? '' : host).trim();
  if (!raw) return { name: '', port: null };
  const n = normalizeHostname(raw);
  if (n.hadBrackets) {
    const close = raw.indexOf(']');
    const rest = raw.slice(close + 1);
    if (rest.startsWith(':')) {
      const p = rest.slice(1);
      return { name: n.name, port: /^[0-9]+$/.test(p) ? Number(p) : NaN };
    }
    return { name: n.name, port: null };
  }
  const i = raw.lastIndexOf(':');
  if (i < 0) return { name: n.name, port: null };
  const p = raw.slice(i + 1);
  return { name: raw.slice(0, i).toLowerCase().replace(/\.+$/, ''), port: /^[0-9]+$/.test(p) ? Number(p) : NaN };
}

/* Host 闸门。selfPort 是本进程真正 listen 的端口（可能是动态选的 8899、8900…）。

   历史上的写法是"Host 里出现了 127.0.0.1 就放行"，那样
   Host: evil.test:8898 这种 rebinding 请求里的 127.0.0.1 出现在别处就漏了；
   而且不校验端口的话，Host: 127.0.0.1:1（指向别的本机服务）也能过。 */
function checkHost(host, selfPort) {
  const raw = String(host === undefined || host === null ? '' : host).trim();
  if (!raw) return deny('HOST_MISSING');
  const p = parseHostHeader(raw);
  /* 拿**剥掉端口之后**的名字去比对白名单 —— 直接拿整个 Host 比会把
     "localhost:8899" 判成不是本机（一开始就是这么写错的）。 */
  if (!LOCAL_HOSTS.has(p.name)) return deny('HOST_NOT_LOCAL');
  const want = Number(selfPort);
  if (Number.isInteger(want) && want > 0) {
    if (p.port === null) return deny('PORT_MISMATCH', 'Host=' + raw + ' 没写端口，本进程在 ' + want);
    if (!Number.isInteger(p.port)) return deny('PORT_MISMATCH', 'Host 里的端口不是数字：' + raw);
    if (p.port !== want) return deny('PORT_MISMATCH', 'Host 端口 ' + p.port + '，本进程在 ' + want);
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * Origin
 * -------------------------------------------------------------------------*/

function parseOrigin(origin) {
  const raw = String(origin === undefined || origin === null ? '' : origin).trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  return { origin: u.origin, hostname: u.hostname.toLowerCase(), port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80) };
}

function isLocalOrigin(origin) {
  const o = parseOrigin(origin);
  if (!o) return false;
  return LOCAL_HOSTS.has(o.hostname);
}

/* 自身 origin：用 Host 头拼，端口必须跟实际监听端口一致。
   为什么不用写死的 http://127.0.0.1:8898：端口被占会自动往后找，
   这时候页面发的 Origin 是随机的那个端口，写死就把自己人挡在外面了。 */
function selfOriginFromHost(host, selfPort) {
  const p = parseHostHeader(host);
  if (!LOCAL_HOSTS.has(p.name)) return null;
  const name = p.name === '::1' ? '[::1]' : p.name;
  const port = Number.isInteger(p.port) ? p.port : Number(selfPort);
  if (!Number.isInteger(port) || port <= 0) return null;
  return 'http://' + name + ':' + port;
}

/* Origin 闸门，**精确匹配**：协议 + 主机 + 端口。
   历史写法是"Origin 里含本机名就放行"，于是 http://127.0.0.1.evil.test 能过 ——
   这种"看起来像本机"的域名正是 rebinding 的常规打法。 */
function checkOrigin(req, selfOrigin) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  const referer = req && req.headers ? req.headers.referer : undefined;
  const raw = origin === undefined || origin === null || origin === '' ? referer : origin;
  if (raw === undefined || raw === null || String(raw).trim() === '') return deny('ORIGIN_MISSING');
  const o = parseOrigin(raw);
  if (!o) return deny('ORIGIN_MISMATCH', 'Origin 不是 http(s) 地址：' + raw);
  if (!isLocalOrigin(raw)) return deny('ORIGIN_MISMATCH', 'Origin 不是本机：' + raw);
  if (selfOrigin && o.origin !== selfOrigin) return deny('ORIGIN_MISMATCH', 'Origin=' + o.origin + '，自身=' + selfOrigin);
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * token
 * -------------------------------------------------------------------------*/

/* 启动时生成一次性随机 token。用 randomBytes 而不是 Math.random：
   后者在 Node 里是可预测的伪随机，等于没做。 */
function makeToken(bytes) {
  const n = Number.isInteger(bytes) && bytes >= 16 ? bytes : 32;
  return crypto.randomBytes(n).toString('hex');
}

/* 定长比较。timingSafeEqual 要求两个 Buffer 等长，所以**先比长度**：
   长度不同直接判否（长度本身不是秘密，token 长度固定，泄露不了东西）。
   用 timingSafeEqual 的理由：普通的 === 会在第一个不同的字符处返回，
   远程调用者能靠计时把 token 一个字符一个字符猜出来。 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a === undefined || a === null ? '' : a), 'utf8');
  const y = Buffer.from(String(b === undefined || b === null ? '' : b), 'utf8');
  if (x.length === 0 || y.length === 0) return false;
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

/* token 闸门。token 只从自定义请求头里取 —— 不接受 query string（会进浏览器历史、
   会进日志、会被 Referer 带出去），也不接受 Cookie（跨源简单请求带不了自定义头，
   但 Cookie 在 rebinding 场景下是会被带上的）。 */
const TOKEN_HEADER = 'x-dsh-console-token';

function readToken(req) {
  const h = (req && req.headers) || {};
  const v = h[TOKEN_HEADER];
  return Array.isArray(v) ? v[0] : v;
}

function checkToken(req, expected) {
  const got = readToken(req);
  if (got === undefined || got === null || String(got).trim() === '') return deny('TOKEN_MISSING');
  if (!expected) return deny('TOKEN_BAD', '服务端没有可用 token');
  if (!safeEqual(got, expected)) return deny('TOKEN_BAD');
  return { ok: true };
}

/* 自定义头 → 跨源必须预检。这一条是"别的网页读不到状态"的根据：
   即便某个浏览器对 POST 放宽了 Origin，带自定义头的跨源请求也过不了预检。 */
const CORS_ALLOW_HEADERS = 'X-Dsh-Console-Token, Content-Type';

/* ---------------------------------------------------------------------------
 * Content-Type
 * -------------------------------------------------------------------------*/

/* 只认 application/json（允许 ; charset=utf-8 这类参数）。
   text/plain、application/x-www-form-urlencoded、multipart/form-data 都是
   "简单请求"能用的类型 —— 正好是攻击页不需要预检就能发的那些，必须拒。 */
function isJsonContentType(ct) {
  const raw = String(ct === undefined || ct === null ? '' : ct).trim().toLowerCase();
  if (!raw) return false;
  const base = raw.split(';')[0].trim();
  return base === 'application/json';
}

function checkContentType(req) {
  const ct = req && req.headers ? req.headers['content-type'] : undefined;
  if (!isJsonContentType(ct)) return deny('CONTENT_TYPE', '收到的是：' + (ct === undefined ? '(没有)' : ct) + '；只接受 application/json');
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * 体积
 * -------------------------------------------------------------------------*/

const DEFAULT_MAX_BODY = 512 * 1024;

/* 体积闸门。审查原话："超大请求 413"。
   顺序上放在 token/Origin 之后：先拒身份不明的，别让攻击者用大包刷日志。 */
function checkSize(contentLength, maxBytes) {
  const max = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BODY;
  if (contentLength === undefined || contentLength === null || contentLength === '') return { ok: true };
  const n = Number(contentLength);
  if (!Number.isFinite(n) || n < 0) return deny('TOO_LARGE', 'Content-Length 不是合法数字：' + contentLength);
  if (n > max) return deny('TOO_LARGE', n + ' 字节 > 上限 ' + max + ' 字节');
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * JSON 解析
 * -------------------------------------------------------------------------*/

/* 坏 JSON 必须报 400，**不能**默默当成 {}。
   原来的 readBody 是 `catch (e) { resolve({}); }`：一个畸形请求会变成
   "空动作"，虽然多半落到"不认识的动作"，但 /api/config 会拿到 {} ——
   语义上"我什么都没改"和"你的 JSON 坏了"完全不是一回事，必须分开报。 */
function parseJsonBody(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf === undefined || buf === null ? '' : buf), 'utf8');
  if (b.length === 0) return deny('EMPTY_BODY');
  let text;
  try { text = b.toString('utf8'); } catch (e) { return deny('BAD_JSON', '读不出 UTF-8'); }
  if (text.replace(/^\uFEFF/, '').trim() === '') return deny('EMPTY_BODY');
  let v;
  try { v = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { return deny('BAD_JSON', e && e.message); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return deny('BAD_JSON', '请求体必须是一个 JSON 对象');
  return { ok: true, value: v };
}

/* ---------------------------------------------------------------------------
 * 总闸门
 * -------------------------------------------------------------------------*/

/* method: 'GET' | 'POST'；path: 用来判"HTML 入口 / favicon 放行"。
   返回 ok:true 时才允许往下走。 */
function verifyRequest(req, opts) {
  const o = opts || {};
  const selfPort = o.port;
  const selfOrigin = o.selfOrigin || selfOriginFromHost(req && req.headers ? req.headers.host : '', selfPort);
  const method = String((req && req.method) || '').toUpperCase();

  const h = checkHost(req && req.headers ? req.headers.host : '', selfPort);
  if (!h.ok) return h;

  if (method === 'POST') {
    const ct = checkContentType(req);
    if (!ct.ok) return ct;
    const og = checkOrigin(req, selfOrigin);
    if (!og.ok) return og;
  }

  const tk = checkToken(req, o.token);
  if (!tk.ok) return tk;

  if (method === 'POST') {
    const sz = checkSize(req && req.headers ? req.headers['content-length'] : undefined, o.maxBody);
    if (!sz.ok) return sz;
  }
  return { ok: true, selfOrigin };
}

/* ---------------------------------------------------------------------------
 * 传输层：读请求体
 * -------------------------------------------------------------------------*/

/* 这是本文件唯一的传输层函数（别的都是纯逻辑）。
   坑在哪：超限时**不能** resolve 一个空对象就完事 —— 那样上层会当成
   "合法但没有字段"，动作就被默默吞掉了；正确做法是明确回 413。

   【第二版修的一个真 bug】第一版超限时先 `req.destroy()` 再 resolve，
   结果真实客户端只看到 ECONNRESET：socket 在响应写出去之前就被拆了，
   那个 413 根本没机会上路（假 req 的单元测试看不出来，因为它只验返回对象）。
   现在的口径：
     · 超限 → 立刻 resolve 413（带 oversized:true、received:n），
       **不动 socket**，交给处理器去写响应；
     · 认定超限之后不再往 chunks 里塞字节（内存里只留到上限为止），
       但继续把到来的数据读掉丢掉 —— 不读的话，处理器写响应时连接上
       还堆着未读数据，TCP 层面容易变成 RST，反而把响应冲掉；
     · 连接怎么收尾由 needsConnectionClose + 处理器决定：写完响应后
       用 Connection: close 让 Node 自己安全关闭（先把没读的请求体丢掉，
       再关连接）。绝不在响应发出前 destroy。
   promise 一定会有结论：end / aborted / error / close 四条路都收口，
   且只 resolve 一次（done 闸）。 */
function readBody(req, opts) {
  const max = Number.isInteger(opts && opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BODY;
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (d) => {
      n += d.length;
      if (done) {
        /* 已经有结论了：不存、不解析，只是把字节从连接上读掉。
           这就是"不继续存入内存"，同时避免留一堆未读数据在 socket 上。 */
        return;
      }
      if (n > max) {
        finish(deny('TOO_LARGE', '读了 ' + n + ' 字节，上限 ' + max + ' 字节', { oversized: true, received: n }));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => finish(parseJsonBody(Buffer.concat(chunks))));
    req.on('aborted', () => finish(deny('ABORTED', '连接被对方中断')));
    req.on('error', (e) => finish(deny('ABORTED', (e && e.message) || '读请求体出错')));
    /* Node 16+ 里 aborted 已经算过时事件，某些路径（比如 socket 直接销毁）
       只发 close。少了这一条，promise 会永远挂着 —— 那等于把请求处理协程漏掉。 */
    req.on('close', () => finish(deny('ABORTED', '请求体读完之前连接就关闭了')));
  });
}

/* 拒绝一个请求之后，连接还能不能复用？
   只要请求体没读完（超限被提前拒、或闸门在体积检查那步就拒了），
   就必须 Connection: close：连接上剩下的字节属于这个请求，留着复用会被
   下一个请求当成自己的开头（请求走私的经典土壤）。
   读完了（readableEnded）就正常复用，页面轮询不至于每次都重连。
   注意这个函数只说"要不要关"，**关闭动作**由 Node 在响应写完之后做，
   不能在写响应之前去 destroy socket。 */
function needsConnectionClose(result, req) {
  if (result && result.oversized) return true;
  if (!req) return false;
  const m = String(req.method || '').toUpperCase();
  if (m !== 'POST') return false;
  return req.readableEnded !== true;
}

/* ---------------------------------------------------------------------------
 * 页面注入
 * -------------------------------------------------------------------------*/

/* 把 token 注入页面。为什么直接写进 HTML 而不是让页面再请求一次：
   页面本身也是"本机 GET",再开一个取 token 的接口等于把闸门开在墙上。
   跨源的页面读不到这段 HTML（同源策略），所以 token 不会外泄。 */
function injectToken(html, token) {
  const t = String(token === undefined || token === null ? '' : token);
  const safe = t.replace(/[^0-9a-fA-F]/g, '');
  return String(html).replace(/__CONSOLE_TOKEN__/g, safe);
}

/* 给所有响应补的公共头：
   no-store —— 状态里有 key 遮罩、章节名这些，别让浏览器缓存；
   X-Content-Type-Options —— 防止把 JSON 当 HTML 解析出 XSS；
   CSP —— 页面只允许自己内联的脚本（页面本来就只有一个内联 <script>），
         这样即便哪天混进一个外部脚本引用也会被拦下；
   Cross-Origin-Resource-Policy —— 别的源发起的跨源读取直接拒绝。 */
function securityHeaders(extra) {
  return Object.assign({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  }, extra || {});
}

/* 给拒绝请求的响应头：不再回 CORS 许可头 —— 跨源页面连"读错误内容"都做不到。
   只有同源（Origin 等于自身）的预检才回许可。 */
function corsHeadersFor(origin, selfOrigin) {
  if (!selfOrigin || origin !== selfOrigin) return {};
  return {
    'Access-Control-Allow-Origin': selfOrigin,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST',
    'Vary': 'Origin',
  };
}

module.exports = {
  ERROR_STATUS,
  ERROR_TEXT,
  DEFAULT_MAX_BODY,
  LOCAL_HOSTS,
  TOKEN_HEADER,
  CORS_ALLOW_HEADERS,
  deny,
  normalizeHostname,
  isLocalHostName,
  parseHostHeader,
  checkHost,
  parseOrigin,
  isLocalOrigin,
  selfOriginFromHost,
  checkOrigin,
  makeToken,
  safeEqual,
  readToken,
  checkToken,
  isJsonContentType,
  checkContentType,
  checkSize,
  parseJsonBody,
  verifyRequest,
  readBody,
  needsConnectionClose,
  injectToken,
  securityHeaders,
  corsHeadersFor,
};
